"""
Waste Ledger Agent
---------------------
Real responsibility: quantify the impact of the whole cascade — estimated
waste WITHOUT HARVEX vs estimated waste WITH HARVEX's interventions —
using explicit, inspectable spoilage-rate assumptions rather than an
opaque "waste reduced by X%" headline number.

ALL figures produced here are PROTOTYPE SIMULATION / ESTIMATED IMPACT.
They are derived from synthetic seed data and illustrative spoilage-rate
assumptions, not measured real-world outcomes.
"""

from datetime import datetime
from agents.base import Agent, AgentResult
from engine import events as EV

# Illustrative baseline spoilage rates if nothing is done, vs. residual
# spoilage once HARVEX's shelf-life/pricing/logistics chain has acted.
BASELINE_LOSS_RATE = {"MOVE_NOW": 0.65, "MARKDOWN_WINDOW": 0.30, "MONITOR": 0.06}
HARVEX_LOSS_RATE = {"MOVE_NOW": 0.12, "MARKDOWN_WINDOW": 0.08, "MONITOR": 0.03}


class WasteLedgerAgent(Agent):
    name = "Waste Ledger Agent"
    reacts_to = (EV.LOGISTICS_PRIORITIZED,)

    def react(self, event, conn, llm) -> AgentResult:
        p = event.payload
        product_id = p.get("product_id")
        if product_id is None or not p.get("moves"):
            return AgentResult(
                decision={"event": "WASTE_IMPACT_ESTIMATED", "note": "no identifiable product/moves for this cascade"},
                reasoning="No identifiable product or scheduled moves to quantify impact for.",
                confidence=0.4, downstream_events=[],
            ), "simulation"

        # avoid double-counting if this cascade already produced a ledger entry
        existing = conn.execute(
            "SELECT id FROM waste_ledger WHERE cascade_id=? AND product_id IS ?",
            (event.cascade_id, product_id),
        ).fetchone()
        if existing:
            return AgentResult(
                decision={"event": "WASTE_IMPACT_ESTIMATED", "note": "already recorded for this cascade"},
                reasoning="Impact already recorded for this cascade — skipping duplicate ledger entry.",
                confidence=0.5, downstream_events=[],
            ), "simulation"

        pricing = conn.execute(
            "SELECT * FROM pricing_decisions WHERE cascade_id=? ORDER BY id DESC LIMIT 1", (event.cascade_id,)
        ).fetchone()
        product = conn.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone() if product_id else None
        price_per_kg = pricing["new_price"] if pricing else (product["base_price_per_kg"] if product else 50.0)

        baseline_waste = 0.0
        harvex_waste = 0.0
        for m in p["moves"]:
            qty = m["quantity_kg"]
            pr = m["priority"]
            baseline_waste += qty * BASELINE_LOSS_RATE.get(pr, 0.1)
            harvex_waste += qty * HARVEX_LOSS_RATE.get(pr, 0.05)

        total_kg = sum(m["quantity_kg"] for m in p["moves"]) or 1
        waste_avoided = round(baseline_waste - harvex_waste, 1)
        value_preserved = round(waste_avoided * price_per_kg, 0)
        utilization_pct = round(100 * (1 - (harvex_waste / total_kg)), 1)
        base_price = product["base_price_per_kg"] if product else price_per_kg
        value_at_risk = round(baseline_waste * base_price, 0)
        value_saved_vs_baseline = round(harvex_waste * base_price, 0)
        affected_batches = len(p["moves"])

        # the without/with comparison the Ripple Console's Impact Simulation
        # card renders directly — same numbers as the ledger row, just framed
        # as a counterfactual instead of a single "impact" figure.
        counterfactual = {
            "without_harvex": {
                "waste_kg": round(baseline_waste, 1),
                "value_at_risk_inr": value_at_risk,
                "affected_batches": affected_batches,
            },
            "with_harvex": {
                "waste_kg": round(harvex_waste, 1),
                "value_preserved_inr": value_preserved,
                "affected_batches": affected_batches,
            },
            "label": "Simulation / Estimated Impact",
        }

        conn.execute(
            "INSERT INTO waste_ledger (cascade_id, product_id, baseline_waste_kg, harvex_waste_kg, waste_avoided_kg, "
            "value_preserved_inr, shelf_life_utilization_pct, notes, created_at, is_simulated) VALUES (?,?,?,?,?,?,?,?,?,1)",
            (event.cascade_id, product_id, round(baseline_waste, 1), round(harvex_waste, 1), waste_avoided,
             value_preserved, utilization_pct,
             "Prototype simulation / estimated impact — derived from synthetic seed data and illustrative spoilage-rate assumptions.",
             datetime.utcnow().isoformat()),
        )
        conn.commit()

        decision = {
            "event": "WASTE_IMPACT_ESTIMATED",
            "product": p.get("product"),
            "product_id": product_id,
            "baseline_waste_kg": round(baseline_waste, 1),
            "harvex_waste_kg": round(harvex_waste, 1),
            "waste_avoided_kg": waste_avoided,
            "value_preserved_inr": value_preserved,
            "shelf_life_utilization_pct": utilization_pct,
            "label": "Prototype simulation / estimated impact",
        }
        fallback = (
            f"Estimated {waste_avoided:.0f} kg of {p.get('product')} rescued from likely spoilage "
            f"(baseline ≈{baseline_waste:.0f} kg lost vs ≈{harvex_waste:.0f} kg under HARVEX's plan), "
            f"preserving an estimated ₹{value_preserved:,.0f} in recoverable value. Prototype simulation / estimated impact."
        )
        text = llm.explain(
            "You are the Waste Ledger Agent inside HARVEX. Summarize the estimated waste avoided and value preserved in one or two sentences. "
            "Always make clear these are prototype/simulated estimates.",
            decision, fallback,
        )

        return AgentResult(
            decision=decision, reasoning=text["text"], confidence=0.7,
            downstream_events=[],
        ), text["mode"]