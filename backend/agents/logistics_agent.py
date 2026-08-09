"""
Logistics Coordination Agent
--------------------------------
Real responsibility: decides what should move, where, and how urgently —
based on remaining economic value (shelf life × quantity × quality),
not a shortest-route calculation. Consumes the Shelf-Life Budget
Allocator's prioritized batch list directly.
"""

from datetime import datetime, timedelta
from agents.base import Agent, AgentResult
from engine import events as EV

URGENCY_ETA_HOURS = {"MOVE_NOW": 6, "MARKDOWN_WINDOW": 24, "MONITOR": 72}


class LogisticsCoordinationAgent(Agent):
    name = "Logistics Coordination Agent"
    reacts_to = (EV.SHELF_LIFE_ALLOCATED, EV.COLD_CHAIN_BREACH)

    def detect_delay(self, conn, llm, warehouse_id, delay_hours, disruption_type="TRUCK_BREAKDOWN"):
        """Feature 5 root sensor — Truck Breakdown / Heavy Rainfall / route
        disruption at a warehouse delays dispatch, which disproportionately
        threatens the batches with the least shelf-life slack to absorb the
        delay. Selects the soonest-expiring in-stock batches at this
        warehouse as exposed, then hands off via LOGISTICS_DELAY so
        Warehouse Allocation routes them into the Shelf-Life Budget
        Allocator exactly like a cold-chain breach."""
        wh = conn.execute("SELECT * FROM warehouses WHERE id=?", (warehouse_id,)).fetchone()
        batches = conn.execute(
            "SELECT b.*, p.name as product_name FROM inventory_batches b "
            "JOIN products p ON p.id = b.product_id "
            "WHERE b.warehouse_id=? AND b.status='IN_STOCK' "
            "ORDER BY julianday(b.expiry_date) ASC LIMIT 6",
            (warehouse_id,),
        ).fetchall()
        affected_kg = sum(b["quantity_kg"] for b in batches)
        severity = "HIGH" if delay_hours >= 8 else ("MEDIUM" if delay_hours >= 4 else "LOW")
        label = disruption_type.replace("_", " ").title()

        decision = {
            "event": "LOGISTICS_DELAY",
            "warehouse": wh["name"],
            "warehouse_id": warehouse_id,
            "disruption_type": disruption_type,
            "delay_hours": delay_hours,
            "severity": severity,
            "affected_batch_ids": [b["id"] for b in batches],
            "affected_kg": round(affected_kg, 1),
            "evidence": [
                f"{label} adds a {delay_hours:.0f}h dispatch delay at {wh['name']}",
                f"{len(batches)} soonest-expiring batch(es) exposed, {affected_kg:.0f} kg total",
                f"Classified {severity} severity",
            ],
        }
        fallback = (
            f"{label} adds a {delay_hours:.0f}h dispatch delay at {wh['name']}, exposing ~{affected_kg:.0f} kg "
            f"across {len(batches)} soonest-expiring batch(es). Severity {severity}. Escalating to Warehouse "
            f"Allocation for shelf-life re-prioritization."
        )
        text = llm.explain(
            "You are the Logistics Coordination Agent inside HARVEX detecting a dispatch delay. "
            "State the disruption and its exposure plainly in one or two sentences.",
            decision, fallback,
        )
        result = AgentResult(
            decision=decision,
            reasoning=text["text"],
            confidence=0.85 if severity == "HIGH" else 0.72,
            downstream_events=[(EV.LOGISTICS_DELAY, decision)],
        )
        return result, text["mode"]

    def react(self, event, conn, llm) -> AgentResult:
        p = event.payload

        if event.event_type == EV.COLD_CHAIN_BREACH:
            batch_ids = p.get("affected_batch_ids", [])
            batches = []
            product_id = None
            product_names = set()
            for bid in batch_ids:
                b = conn.execute(
                    "SELECT b.*, w.name as warehouse_name, pr.name as product_name FROM inventory_batches b "
                    "JOIN warehouses w ON w.id=b.warehouse_id JOIN products pr ON pr.id=b.product_id WHERE b.id=?",
                    (bid,),
                ).fetchone()
                if b:
                    batches.append({"batch_id": b["id"], "batch_code": b["batch_code"],
                                     "warehouse": b["warehouse_name"], "quantity_kg": b["quantity_kg"],
                                     "priority": "MOVE_NOW"})
                    product_id = b["product_id"]
                    product_names.add(b["product_name"])
            product_name = " / ".join(sorted(product_names)) if product_names else "Cold-chain exposed inventory"
        else:
            batches = p["allocated_batches"]
            product_name = p["product"]
            product_id = p["product_id"]

        moves = []
        now = datetime.utcnow()
        for b in batches:
            priority = b["priority"]
            eta_hours = URGENCY_ETA_HOURS.get(priority, 48)
            dest = "Nearest high-demand retail cluster" if priority == "MOVE_NOW" else "Regional distribution center"
            eta = now + timedelta(hours=eta_hours)
            conn.execute(
                "INSERT INTO logistics_operations (batch_id, origin_warehouse_id, destination, priority, status, "
                "dispatch_time, eta, cascade_id, is_simulated) VALUES (?, "
                "(SELECT warehouse_id FROM inventory_batches WHERE id=?), ?, ?, 'PLANNED', ?, ?, ?, 1)",
                (b["batch_id"], b["batch_id"], dest, priority, now.isoformat(), eta.isoformat(), event.cascade_id),
            )
            moves.append({"batch_id": b["batch_id"], "batch_code": b.get("batch_code"), "priority": priority,
                          "destination": dest, "eta_hours": eta_hours, "quantity_kg": b["quantity_kg"]})
        conn.commit()

        urgent = sum(1 for m in moves if m["priority"] == "MOVE_NOW")
        decision = {
            "event": "LOGISTICS_PRIORITIZED",
            "product": product_name,
            "product_id": product_id,
            "moves": moves,
            "urgent_moves": urgent,
            "trigger": event.event_type,
        }
        fallback = (
            f"Scheduled {len(moves)} movement(s) for {product_name}; {urgent} marked MOVE_NOW with dispatch inside "
            f"6 hours to the nearest high-demand cluster, remainder routed to regional distribution on a relaxed window."
        )
        text = llm.explain(
            "You are the Logistics Coordination Agent inside HARVEX. Explain the movement prioritization in one or two sentences.",
            decision, fallback,
        )

        actions = [{
            "action_type": "DISPATCH_BATCH",
            "payload": {"batch_code": m.get("batch_code"), "destination": m["destination"], "priority": m["priority"]},
            "requires_approval": False,
        } for m in moves[:5]]

        return AgentResult(
            decision=decision, reasoning=text["text"], confidence=0.86,
            downstream_events=[(EV.LOGISTICS_PRIORITIZED, decision)], actions=actions,
        ), text["mode"]