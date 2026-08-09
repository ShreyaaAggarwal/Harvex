"""
Intervention Optimizer  ⭐ Feature 4
----------------------------------------
Real responsibility: once the Shelf-Life Budget Allocator has flagged
urgent batches, evaluate a bounded set of discrete interventions and
recommend the one with the best expected value — connecting existing
agents' own numbers (waste-rate assumptions shared with the Waste Ledger
Agent, demand signals, freshness budget) rather than being a disconnected
rules engine.

All cost/value figures are PROTOTYPE SIMULATION / ESTIMATED — same
spoilage-rate assumptions the Waste Ledger Agent uses, applied here
per-option instead of per-outcome so the options are comparable.
"""

from agents.base import Agent, AgentResult
from agents import freshness
from engine import events as EV

# Mirrors Waste Ledger Agent's illustrative baseline/HARVEX loss rates —
# kept here as a local constant so this module has no import-order
# dependency on waste_ledger_agent.
BASELINE_LOSS_RATE = {"MOVE_NOW": 0.65, "MARKDOWN_WINDOW": 0.30, "MONITOR": 0.06}
INTERVENTION_LOSS_RATE = {
    "REROUTE_TO_ALT_WAREHOUSE": 0.10,
    "PRIORITIZE_DISPATCH": 0.12,
    "MARKDOWN_SELL_FIRST": 0.08,
    "REALLOCATE_INVENTORY": 0.15,
    "REDUCE_INCOMING_PROCUREMENT": 0.20,
    "KEEP_CURRENT_PLAN": 0.55,
}
INTERVENTION_OP_COST_INR = {
    "REROUTE_TO_ALT_WAREHOUSE": 1800,
    "PRIORITIZE_DISPATCH": 900,
    "MARKDOWN_SELL_FIRST": 250,
    "REALLOCATE_INVENTORY": 1200,
    "REDUCE_INCOMING_PROCUREMENT": 400,
    "KEEP_CURRENT_PLAN": 0,
}
RISK_REDUCTION_LABEL = {
    "REROUTE_TO_ALT_WAREHOUSE": "HIGH",
    "PRIORITIZE_DISPATCH": "HIGH",
    "MARKDOWN_SELL_FIRST": "MEDIUM",
    "REALLOCATE_INVENTORY": "MEDIUM",
    "REDUCE_INCOMING_PROCUREMENT": "LOW",
    "KEEP_CURRENT_PLAN": "NONE",
}


class InterventionOptimizerAgent(Agent):
    name = "Intervention Optimizer"
    reacts_to = (EV.SHELF_LIFE_ALLOCATED,)

    def react(self, event, conn, llm) -> AgentResult:
        p = event.payload
        allocated = p.get("allocated_batches", [])
        urgent = [b for b in allocated if b["priority"] in ("MOVE_NOW", "MARKDOWN_WINDOW")]

        if not urgent:
            decision = {"event": "INTERVENTION_RECOMMENDED", "product": p.get("product"),
                        "note": "No urgent batches in this allocation — no intervention needed."}
            return AgentResult(
                decision=decision, reasoning="No urgent batches to intervene on — current plan is sufficient.",
                confidence=0.5, downstream_events=[],
            ), "simulation"

        product = conn.execute("SELECT * FROM products WHERE id=?", (p["product_id"],)).fetchone()
        price_per_kg = product["base_price_per_kg"] if product else 50.0
        total_kg = sum(b["quantity_kg"] for b in urgent)

        # grounded evidence reused from Procurement Agent's own signal
        near_expiry = conn.execute(
            "SELECT COALESCE(SUM(quantity_kg),0) kg FROM inventory_batches "
            "WHERE product_id=? AND status='IN_STOCK' AND julianday(date(expiry_date)) - julianday(date('now')) <= 3",
            (p["product_id"],),
        ).fetchone()["kg"]

        # is there a materially better-demand alternate warehouse? (grounded lookup)
        alt_wh = conn.execute(
            "SELECT w.name, AVG(d.demand_index) idx FROM warehouses w "
            "JOIN demand_signals d ON d.region = w.region AND d.product_id=? "
            "GROUP BY w.id ORDER BY idx DESC LIMIT 1",
            (p["product_id"],),
        ).fetchone()

        baseline_waste_kg = sum(b["quantity_kg"] * BASELINE_LOSS_RATE.get(b["priority"], 0.2) for b in urgent)

        options = []
        for action, rate in INTERVENTION_LOSS_RATE.items():
            if action == "REROUTE_TO_ALT_WAREHOUSE" and not alt_wh:
                continue
            residual_waste_kg = total_kg * rate
            waste_reduction_kg = round(max(0.0, baseline_waste_kg - residual_waste_kg), 1)
            value_impact_inr = round(waste_reduction_kg * price_per_kg, 0)
            cost_inr = INTERVENTION_OP_COST_INR[action]
            net_value_inr = round(value_impact_inr - cost_inr, 0)
            options.append({
                "action": action,
                "label": action.replace("_", " ").title(),
                "expected_waste_reduction_kg": waste_reduction_kg,
                "operational_cost_inr": cost_inr,
                "value_impact_inr": value_impact_inr,
                "net_value_inr": net_value_inr,
                "risk_reduction": RISK_REDUCTION_LABEL[action],
                "confidence": 0.82 if action != "KEEP_CURRENT_PLAN" else 0.4,
                "detail": (
                    f"Route {total_kg:.0f} kg to {alt_wh['name']} (stronger regional demand)" if action == "REROUTE_TO_ALT_WAREHOUSE" and alt_wh
                    else f"Dispatch within the MOVE_NOW window" if action == "PRIORITIZE_DISPATCH"
                    else f"Markdown ahead of spoilage rather than after" if action == "MARKDOWN_SELL_FIRST"
                    else f"Split volume across warehouses to spread exposure" if action == "REALLOCATE_INVENTORY"
                    else f"Cut incoming orders — {near_expiry:.0f} kg already near-expiry on hand" if action == "REDUCE_INCOMING_PROCUREMENT"
                    else "No change — highest residual spoilage exposure"
                ),
            })

        options.sort(key=lambda o: o["net_value_inr"], reverse=True)
        recommended = options[0]

        decision = {
            "event": "INTERVENTION_RECOMMENDED",
            "product": p["product"],
            "product_id": p["product_id"],
            "at_risk_kg": round(total_kg, 0),
            "baseline_waste_kg": round(baseline_waste_kg, 1),
            "options": options,
            "recommended_action": recommended["action"],
            "recommended_label": recommended["label"],
            "label": "Prototype simulation / estimated impact",
            "evidence": [
                f"{len(urgent)} urgent batch(es), {total_kg:.0f} kg, baseline exposure ~{baseline_waste_kg:.0f} kg if untouched",
                f"Best regional demand alternative: {alt_wh['name'] if alt_wh else 'none identified'}",
                f"{len(options)} intervention(s) evaluated on expected waste reduction net of estimated operational cost",
            ],
        }
        fallback = (
            f"Evaluated {len(options)} intervention(s) for {total_kg:.0f} kg of at-risk {p['product']}. "
            f"Recommended: {recommended['label']} — estimated {recommended['expected_waste_reduction_kg']:.0f} kg "
            f"waste avoided, ₹{recommended['value_impact_inr']:,.0f} value impact net of ₹{recommended['operational_cost_inr']:,.0f} "
            f"estimated operational cost. Prototype simulation / estimated impact."
        )
        text = llm.explain(
            "You are the Intervention Optimizer inside HARVEX. Explain which intervention was recommended and why, "
            "grounded only in the evaluated options given, in one or two sentences.",
            decision, fallback,
        )

        return AgentResult(
            decision=decision, reasoning=text["text"], confidence=recommended["confidence"],
            downstream_events=[],
        ), text["mode"]