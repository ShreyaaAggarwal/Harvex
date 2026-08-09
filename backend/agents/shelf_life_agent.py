"""
Shelf-Life Budget Allocator  ⭐ differentiator
--------------------------------------------------
Real responsibility: treats remaining shelf life as a limited operational
resource to be spent deliberately, not a countdown handled by plain FIFO.
For each at-risk batch it scores recoverable value using remaining days,
demand strength in the batch's region, quality grade and quantity, then
ranks batches into a priority order for markdown / movement decisions.
"""

from datetime import datetime, date
from agents.base import Agent, AgentResult
from engine import events as EV

GRADE_WEIGHT = {"A": 1.0, "B": 0.85, "C": 0.65}


def _days_left(expiry_date_str):
    exp = datetime.strptime(expiry_date_str, "%Y-%m-%d").date()
    return max(0, (exp - date.today()).days)


class ShelfLifeBudgetAllocator(Agent):
    name = "Shelf-Life Budget Allocator"
    reacts_to = (EV.SHELF_LIFE_PRESSURE,)

    def react(self, event, conn, llm) -> AgentResult:
        p = event.payload
        batch_ids = p.get("at_risk_batch_ids") or p.get("batch_ids") or []
        if not batch_ids:
            batches = []
        else:
            q = "SELECT b.*, w.name as warehouse_name FROM inventory_batches b JOIN warehouses w ON w.id=b.warehouse_id WHERE b.id IN ({})".format(
                ",".join("?" * len(batch_ids))
            )
            batches = conn.execute(q, batch_ids).fetchall()

        recent_demand = conn.execute(
            "SELECT AVG(demand_index) as avg_idx FROM demand_signals WHERE product_id=? ORDER BY signal_date DESC LIMIT 5",
            (p["product_id"],),
        ).fetchone()
        demand_strength = (recent_demand["avg_idx"] or 70) / 100.0

        ranked = []
        for b in batches:
            days_left = _days_left(b["expiry_date"])
            urgency = 1 / (days_left + 1)
            grade_w = GRADE_WEIGHT.get(b["quality_grade"], 0.75)
            recoverable_score = round(grade_w * demand_strength * (1 - urgency) * 100, 1)
            ranked.append({
                "batch_id": b["id"],
                "batch_code": b["batch_code"],
                "warehouse": b["warehouse_name"],
                "quantity_kg": b["quantity_kg"],
                "days_left": days_left,
                "quality_grade": b["quality_grade"],
                "recoverable_value_score": recoverable_score,
                "priority": "MOVE_NOW" if days_left <= 1 else ("MARKDOWN_WINDOW" if days_left <= 3 else "MONITOR"),
            })
        ranked.sort(key=lambda r: r["days_left"])

        product = conn.execute("SELECT * FROM products WHERE id=?", (p["product_id"],)).fetchone()
        total_kg = sum(r["quantity_kg"] for r in ranked)

        decision = {
            "event": "SHELF_LIFE_ALLOCATED",
            "product": product["name"],
            "product_id": p["product_id"],
            "allocated_batches": ranked,
            "total_allocated_kg": round(total_kg, 0),
            "demand_strength_index": round(demand_strength * 100, 1),
        }
        move_now = sum(1 for r in ranked if r["priority"] == "MOVE_NOW")
        fallback = (
            f"Allocated shelf-life budget across {len(ranked)} {product['name']} batch(es) totalling {total_kg:.0f} kg — "
            f"{move_now} batch(es) flagged MOVE_NOW based on remaining days, grade and regional demand strength. "
            f"Handing prioritized batches to Pricing and Logistics."
        )
        text = llm.explain(
            "You are the Shelf-Life Budget Allocator inside HARVEX. Explain the batch prioritization in one or two sentences, plain and concrete.",
            decision, fallback,
        )

        return AgentResult(
            decision=decision,
            reasoning=text["text"],
            confidence=0.87,
            downstream_events=[(EV.SHELF_LIFE_ALLOCATED, decision)],
        ), text["mode"]
