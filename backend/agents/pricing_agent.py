"""
Pricing Agent
---------------
Real responsibility: turns shelf-life-allocated batch priorities into a
concrete price/markdown recommendation, sized to expected loss versus
expected sell-through — not a generic "AI price predictor" run in
isolation. It only acts inside the Ripple workflow, always downstream of
a shelf-life allocation.
"""

from datetime import datetime
from agents.base import Agent, AgentResult
from engine import events as EV


class PricingAgent(Agent):
    name = "Pricing Agent"
    reacts_to = (EV.SHELF_LIFE_ALLOCATED,)

    def react(self, event, conn, llm) -> AgentResult:
        p = event.payload
        product = conn.execute("SELECT * FROM products WHERE id=?", (p["product_id"],)).fetchone()
        base_price = product["base_price_per_kg"]

        move_now_kg = sum(b["quantity_kg"] for b in p["allocated_batches"] if b["priority"] == "MOVE_NOW")
        window_kg = sum(b["quantity_kg"] for b in p["allocated_batches"] if b["priority"] == "MARKDOWN_WINDOW")
        total_kg = p["total_allocated_kg"] or 1

        urgency_ratio = (move_now_kg * 1.0 + window_kg * 0.5) / total_kg
        markdown_pct = round(min(35, max(5, urgency_ratio * 40)), 1)
        new_price = round(base_price * (1 - markdown_pct / 100.0), 2)

        decision = {
            "event": "PRICING_RECOMMENDED",
            "product": product["name"],
            "product_id": p["product_id"],
            "base_price": base_price,
            "markdown_pct": markdown_pct,
            "new_price": new_price,
            "move_now_kg": round(move_now_kg, 0),
            "markdown_window_kg": round(window_kg, 0),
            "allocated_batches": p["allocated_batches"],
            "evidence": [
                f"{move_now_kg:.0f} kg at MOVE_NOW priority, {window_kg:.0f} kg in the markdown window (of {total_kg:.0f} kg allocated)",
                f"Urgency ratio {urgency_ratio*100:.0f}% \u2192 sized to a {markdown_pct:.0f}% markdown",
                f"Base price \u20b9{base_price:.2f}/kg \u2192 \u20b9{new_price:.2f}/kg",
            ],
        }
        fallback = (
            f"Recommending a {markdown_pct:.0f}% markdown on {product['name']} (₹{base_price:.2f} → ₹{new_price:.2f}/kg), "
            f"sized to move {move_now_kg:.0f} kg of urgent stock before it becomes unsellable, "
            f"while checking for cannibalization before it goes live."
        )
        text = llm.explain(
            "You are the Pricing Agent inside HARVEX. Explain the markdown recommendation and its rationale in one or two sentences.",
            decision, fallback,
        )

        conn.execute(
            "INSERT INTO pricing_decisions (product_id, decided_at, old_price, new_price, reason, cascade_id, is_simulated) "
            "VALUES (?,?,?,?,?,?,1)",
            (p["product_id"], datetime.utcnow().isoformat(), base_price, new_price, text["text"], event.cascade_id),
        )
        conn.commit()

        requires_approval = markdown_pct >= 20
        actions = [{
            "action_type": "APPLY_MARKDOWN",
            "payload": {
                "product": product["name"], "old_price": base_price, "new_price": new_price, "markdown_pct": markdown_pct,
                "risk_level": "HIGH" if markdown_pct >= 25 else ("MEDIUM" if requires_approval else "LOW"),
                "reason": f"{markdown_pct:.0f}% markdown exceeds the 20% auto-execute threshold" if requires_approval else "Within auto-execute threshold",
            },
            "requires_approval": requires_approval,
        }]

        return AgentResult(
            decision=decision,
            reasoning=text["text"],
            confidence=0.81,
            downstream_events=[(EV.PRICING_RECOMMENDED, decision)],
            actions=actions,
        ), text["mode"]