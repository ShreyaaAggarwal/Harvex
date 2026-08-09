"""
Warehouse Allocation Agent
------------------------------
Real responsibility: determines inventory exposure across warehouses —
which batches are now excess (demand fell), short (demand rose / supply
at risk), or urgently exposed (cold-chain breach) — and identifies which
batches are running short on remaining shelf life. It does not just show
stock levels, it classifies exposure and hands off to the Shelf-Life
Budget Allocator.
"""

from datetime import datetime, date
from agents.base import Agent, AgentResult
from engine import events as EV


def _days_left(expiry_date_str):
    exp = datetime.strptime(expiry_date_str, "%Y-%m-%d").date()
    return (exp - date.today()).days


class WarehouseAllocationAgent(Agent):
    name = "Warehouse Allocation Agent"
    reacts_to = (EV.DEMAND_SHOCK, EV.SUPPLY_RISK_DETECTED, EV.COLD_CHAIN_BREACH)

    def _batches_for_product(self, conn, product_id, warehouse_id=None):
        q = ("SELECT b.*, p.shelf_life_days, p.name as product_name FROM inventory_batches b "
             "JOIN products p ON p.id=b.product_id WHERE b.product_id=? AND b.status='IN_STOCK'")
        args = [product_id]
        if warehouse_id:
            q += " AND b.warehouse_id=?"
            args.append(warehouse_id)
        return conn.execute(q, args).fetchall()

    def react(self, event, conn, llm) -> AgentResult:
        p = event.payload

        if event.event_type == EV.COLD_CHAIN_BREACH:
            batches = conn.execute(
                "SELECT b.*, pr.shelf_life_days, pr.name as product_name FROM inventory_batches b "
                "JOIN products pr ON pr.id = b.product_id WHERE b.id IN ({})".format(
                    ",".join("?" * len(p["affected_batch_ids"]))
                ) if p["affected_batch_ids"] else "SELECT * FROM inventory_batches WHERE 0",
                p["affected_batch_ids"] or [],
            ).fetchall()
            exposure_type = "COLD_CHAIN_EXPOSURE"
            product_id = batches[0]["product_id"] if batches else None
        else:
            product_id = p["product_id"]
            batches = self._batches_for_product(conn, product_id)
            if event.event_type == EV.DEMAND_SHOCK:
                exposure_type = "SURPLUS" if p["change_pct"] < 0 else "SHORTAGE"
            else:
                exposure_type = "SHORTAGE"

        total_kg = sum(b["quantity_kg"] for b in batches)
        strict_at_risk = [b for b in batches if _days_left(b["expiry_date"]) <= 3]
        # Always route the soonest-expiring batches into the Shelf-Life Budget
        # Allocator for a priority pass — shelf-life budgeting is a routine
        # operational discipline, not something reserved only for a hard crisis.
        priority_batches = sorted(batches, key=lambda b: _days_left(b["expiry_date"]))[:3]
        priority_kg = sum(b["quantity_kg"] for b in priority_batches)

        product = conn.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone() if product_id else None

        decision = {
            "event": "INVENTORY_EXPOSURE",
            "product": product["name"] if product else "Multiple",
            "product_id": product_id,
            "exposure_type": exposure_type,
            "total_on_hand_kg": round(total_kg, 0),
            "batches_at_risk": len(strict_at_risk),
            "at_risk_kg": round(priority_kg, 0),
            "batch_ids": [b["id"] for b in batches],
            "at_risk_batch_ids": [b["id"] for b in priority_batches],
            "trigger": event.event_type,
        }
        fallback = (
            f"{decision['product']} shows {total_kg:.0f} kg on hand classified as {exposure_type}; "
            f"{len(strict_at_risk)} batch(es) have 3 days or less of shelf life remaining. "
            f"Prioritizing the {len(priority_batches)} soonest-expiring batch(es) ({priority_kg:.0f} kg) through the Shelf-Life Budget Allocator."
        )
        text = llm.explain(
            "You are the Warehouse Allocation Agent inside HARVEX. State the inventory exposure and shelf-life risk in one or two sentences.",
            decision, fallback,
        )

        downstream = []
        if priority_batches:
            downstream.append((EV.SHELF_LIFE_PRESSURE, decision))
        else:
            downstream.append((EV.INVENTORY_EXPOSURE, decision))

        return AgentResult(
            decision=decision,
            reasoning=text["text"],
            confidence=0.83,
            downstream_events=downstream,
        ), text["mode"]

    def detect_shelf_life_crisis(self, conn, llm, product_id):
        """Root detector for the SHELF_LIFE_CRISIS scenario — scans for
        batches whose remaining shelf life is critically low relative to
        quantity on hand, independent of any external demand/supply signal."""
        batches = self._batches_for_product(conn, product_id)
        product = conn.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()

        at_risk = sorted(batches, key=lambda b: _days_left(b["expiry_date"]))[:3]
        # force at least a realistic crisis window for the demo
        at_risk_kg = sum(b["quantity_kg"] for b in at_risk)

        decision = {
            "event": "SHELF_LIFE_PRESSURE",
            "product": product["name"],
            "product_id": product_id,
            "exposure_type": "SHELF_LIFE_CRITICAL",
            "batches_at_risk": len(at_risk),
            "at_risk_kg": round(at_risk_kg, 0),
            "batch_ids": [b["id"] for b in batches],
            "at_risk_batch_ids": [b["id"] for b in at_risk],
            "trigger": "INTERNAL_SCAN",
        }
        fallback = (
            f"Routine shelf-life scan found {len(at_risk)} {product['name']} batch(es), {at_risk_kg:.0f} kg total, "
            f"nearing the end of usable shelf life with no demand or pricing action yet planned. "
            f"Escalating directly to the Shelf-Life Budget Allocator."
        )
        text = llm.explain(
            "You are the Warehouse Allocation Agent inside HARVEX running a routine shelf-life scan. Explain the finding in one or two sentences.",
            decision, fallback,
        )
        result = AgentResult(
            decision=decision,
            reasoning=text["text"],
            confidence=0.88,
            downstream_events=[(EV.SHELF_LIFE_PRESSURE, decision)],
        )
        return result, text["mode"]
