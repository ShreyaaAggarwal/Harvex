"""
Procurement Planning Agent
-----------------------------
Real responsibility: turns a demand or supply-risk event into a concrete
change to upcoming procurement — a quantity and timing adjustment, grounded
in current open orders and on-hand inventory — not just a redisplayed
forecast.
"""

from datetime import datetime
from agents.base import Agent, AgentResult
from engine import events as EV


class ProcurementPlanningAgent(Agent):
    name = "Procurement Planning Agent"
    reacts_to = (EV.DEMAND_SHOCK, EV.SUPPLY_RISK_DETECTED)

    def react(self, event, conn, llm) -> AgentResult:
        p = event.payload
        product_id = p["product_id"]
        product = conn.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()

        open_orders = conn.execute(
            "SELECT * FROM procurement_orders WHERE product_id=? AND status='CONFIRMED'", (product_id,)
        ).fetchall()
        open_qty = sum(o["quantity_kg"] for o in open_orders)

        # grounded evidence: real current inventory + near-expiry exposure for this product
        on_hand = conn.execute(
            "SELECT COALESCE(SUM(quantity_kg),0) kg FROM inventory_batches WHERE product_id=? AND status='IN_STOCK'",
            (product_id,),
        ).fetchone()["kg"]
        near_expiry = conn.execute(
            "SELECT COALESCE(SUM(quantity_kg),0) kg FROM inventory_batches "
            "WHERE product_id=? AND status='IN_STOCK' AND julianday(date(expiry_date)) - julianday(date('now')) <= 3",
            (product_id,),
        ).fetchone()["kg"]

        if event.event_type == EV.DEMAND_SHOCK:
            change_pct = p["change_pct"]
            qty_change = round(open_qty * (change_pct / 100.0), 0)
            direction = "REDUCE_PROCUREMENT" if change_pct < 0 else "INCREASE_PROCUREMENT"
        else:  # SUPPLY_RISK_DETECTED
            change_pct = -p["shortfall_pct"]
            qty_change = -round(p["exposed_kg"], 0)
            direction = "SOURCE_FROM_ALTERNATE_SUPPLIER"

        new_target = max(0, round(open_qty + qty_change, 0))

        evidence = []
        if event.event_type == EV.DEMAND_SHOCK:
            arrow = "\u2193" if change_pct < 0 else "\u2191"
            evidence.append(f"Demand {arrow}{abs(change_pct):.0f}%")
        else:
            evidence.append(f"Supplier shortfall {p['shortfall_pct']:.0f}% ({p.get('exposed_kg', 0):.0f} kg exposed)")
        evidence.append(f"Current inventory: {on_hand:,.0f} kg")
        evidence.append(f"Near-expiry inventory (\u22643d): {near_expiry:,.0f} kg")
        if direction == "REDUCE_PROCUREMENT":
            evidence.append("Incoming procurement at prior levels would increase overstock risk against falling demand")
        elif direction == "INCREASE_PROCUREMENT":
            evidence.append("On-hand + committed volume insufficient to cover the demand increase")
        else:
            evidence.append("Confirmed orders with the affected supplier are exposed to the shortfall")

        decision = {
            "event": "PROCUREMENT_ADJUSTED",
            "product": product["name"],
            "product_id": product_id,
            "recommended_action": direction,
            "open_committed_kg": round(open_qty, 0),
            "quantity_change_kg": qty_change,
            "new_target_kg": new_target,
            "current_inventory_kg": round(on_hand, 0),
            "near_expiry_inventory_kg": round(near_expiry, 0),
            "trigger": event.event_type,
            "evidence": evidence,
        }
        fallback = (
            f"With {open_qty:.0f} kg already committed for {product['name']}, HARVEX recommends "
            f"{'cutting' if qty_change < 0 else 'raising'} the upcoming order by {abs(qty_change):.0f} kg "
            f"(new target ≈ {new_target:.0f} kg) in response to {event.event_type.replace('_', ' ').lower()}."
        )
        text = llm.explain(
            "You are the Procurement Planning Agent inside HARVEX. Explain the procurement quantity change in one or two sentences.",
            decision, fallback,
        )

        requires_approval = abs(qty_change) > 1500
        actions = [{
            "action_type": "AMEND_PROCUREMENT_ORDER",
            "payload": {
                "product": product["name"], "quantity_change_kg": qty_change, "new_target_kg": new_target,
                "risk_level": "HIGH" if requires_approval else "LOW",
                "reason": f"Quantity change of {abs(qty_change):.0f} kg exceeds the 1,500 kg auto-execute threshold" if requires_approval else "Within auto-execute threshold",
            },
            "requires_approval": requires_approval,
        }]

        return AgentResult(
            decision=decision,
            reasoning=text["text"],
            confidence=0.85 if event.event_type == EV.DEMAND_SHOCK else 0.79,
            downstream_events=[],
            actions=actions,
        ), text["mode"]