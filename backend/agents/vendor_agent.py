"""
Vendor Renegotiation Agent
------------------------------
Real responsibility: when demand or supply conditions change, evaluate
whether existing confirmed supplier commitments should be reduced, delayed
or renegotiated — producing a concrete recommendation/action rather than a
simulated phone call.
"""

from agents.base import Agent, AgentResult
from engine import events as EV


class VendorRenegotiationAgent(Agent):
    name = "Vendor Renegotiation Agent"
    reacts_to = (EV.DEMAND_SHOCK, EV.SUPPLY_RISK_DETECTED)

    def react(self, event, conn, llm) -> AgentResult:
        p = event.payload
        product_id = p["product_id"]
        product = conn.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()

        orders = conn.execute(
            "SELECT po.*, s.name as supplier_name, s.reliability_score FROM procurement_orders po "
            "JOIN suppliers s ON s.id = po.supplier_id WHERE po.product_id=? AND po.status='CONFIRMED' "
            "ORDER BY po.delivery_date ASC LIMIT 1",
            (product_id,),
        ).fetchone()

        if not orders:
            decision = {
                "event": "VENDOR_RENEGOTIATION_RECOMMENDED",
                "product": product["name"], "product_id": product_id,
                "recommended_action": "NO_OPEN_COMMITMENTS", "supplier": None,
            }
            fallback = f"No open confirmed orders for {product['name']} — no renegotiation needed."
            text = llm.explain("You are the Vendor Renegotiation Agent inside HARVEX.", decision, fallback)
            return AgentResult(decision=decision, reasoning=text["text"], confidence=0.6, downstream_events=[]), text["mode"]

        if event.event_type == EV.DEMAND_SHOCK and p["change_pct"] < 0:
            action = "DELAY_DELIVERY" if orders["reliability_score"] >= 0.85 else "REDUCE_QUANTITY"
            adj_kg = round(orders["quantity_kg"] * min(0.4, abs(p["change_pct"]) / 100.0), 0)
        elif event.event_type == EV.SUPPLY_RISK_DETECTED:
            action = "SOURCE_ALTERNATE_SUPPLIER"
            adj_kg = round(orders["quantity_kg"] * (p["shortfall_pct"] / 100.0), 0)
        else:
            action = "EXPEDITE_DELIVERY"
            adj_kg = round(orders["quantity_kg"] * 0.2, 0)

        decision = {
            "event": "VENDOR_RENEGOTIATION_RECOMMENDED",
            "product": product["name"],
            "product_id": product_id,
            "supplier": orders["supplier_name"],
            "order_id": orders["id"],
            "recommended_action": action,
            "quantity_adjustment_kg": adj_kg,
            "supplier_reliability": orders["reliability_score"],
        }
        fallback = (
            f"Existing order with {orders['supplier_name']} for {product['name']} ({orders['quantity_kg']:.0f} kg, "
            f"reliability {orders['reliability_score']:.2f}) should be revisited: recommended action is "
            f"{action.replace('_', ' ').lower()}, adjusting ~{adj_kg:.0f} kg."
        )
        text = llm.explain(
            "You are the Vendor Renegotiation Agent inside HARVEX. Explain the recommended supplier action in one or two sentences.",
            decision, fallback,
        )

        actions = [{
            "action_type": "VENDOR_ACTION_" + action,
            "payload": {"supplier": orders["supplier_name"], "order_id": orders["id"], "quantity_adjustment_kg": adj_kg},
            "requires_approval": True,
        }]

        return AgentResult(
            decision=decision, reasoning=text["text"], confidence=0.74,
            downstream_events=[], actions=actions,
        ), text["mode"]
