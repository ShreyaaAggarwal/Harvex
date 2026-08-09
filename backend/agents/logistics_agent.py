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
