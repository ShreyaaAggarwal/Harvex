"""
Cold-Chain Risk Monitor
--------------------------
Real responsibility: watches storage temperature/humidity readings against
target bands, identifies which batches in that warehouse are exposed, and
triggers a ripple the moment a breach is detected — it does not wait for a
human to notice a chart.
"""

from datetime import datetime
from agents.base import Agent, AgentResult
from engine import events as EV


class ColdChainRiskMonitor(Agent):
    name = "Cold-Chain Risk Monitor"
    reacts_to = ()

    def detect(self, conn, llm, warehouse_id, excursion_c):
        wh = conn.execute("SELECT * FROM warehouses WHERE id=?", (warehouse_id,)).fetchone()
        target = 4.0
        observed = target + excursion_c

        conn.execute(
            "INSERT INTO cold_chain_observations (warehouse_id, recorded_at, temperature_c, target_temperature_c, humidity_pct, is_breach, is_simulated) "
            "VALUES (?,?,?,?,?,1,1)",
            (warehouse_id, datetime.utcnow().isoformat(), observed, target, 91.0),
        )
        conn.commit()

        affected = conn.execute(
            "SELECT b.*, p.name as product_name, p.shelf_life_days FROM inventory_batches b "
            "JOIN products p ON p.id = b.product_id "
            "WHERE b.warehouse_id=? AND b.status='IN_STOCK' ORDER BY b.quantity_kg DESC LIMIT 5",
            (warehouse_id,),
        ).fetchall()
        affected_kg = sum(b["quantity_kg"] for b in affected)
        severity = "HIGH" if excursion_c >= 4 else ("MEDIUM" if excursion_c >= 2 else "LOW")

        decision = {
            "event": "COLD_CHAIN_BREACH",
            "warehouse": wh["name"],
            "warehouse_id": warehouse_id,
            "observed_temp_c": round(observed, 1),
            "target_temp_c": target,
            "excursion_c": excursion_c,
            "severity": severity,
            "affected_batch_ids": [b["id"] for b in affected],
            "affected_kg": round(affected_kg, 1),
            "evidence": [
                f"{observed:.1f}\u00b0C observed vs {target:.1f}\u00b0C target ({excursion_c:+.1f}\u00b0C excursion)",
                f"{len(affected)} batch(es) in {wh['name']} exposed, {affected_kg:.0f} kg total",
                f"Classified {severity} severity",
            ],
        }
        fallback = (
            f"{wh['name']} recorded {observed:.1f}°C against a {target:.1f}°C target ({excursion_c:+.1f}°C excursion), "
            f"exposing ~{affected_kg:.0f} kg of stored batches. Severity {severity}. Escalating to Warehouse and Logistics agents."
        )
        text = llm.explain(
            "You are the Cold-Chain Risk Monitor inside HARVEX. State the temperature breach and exposure plainly.",
            decision, fallback,
        )
        result = AgentResult(
            decision=decision,
            reasoning=text["text"],
            confidence=0.93 if severity == "HIGH" else 0.8,
            downstream_events=[(EV.COLD_CHAIN_BREACH, decision)],
        )
        return result, text["mode"]