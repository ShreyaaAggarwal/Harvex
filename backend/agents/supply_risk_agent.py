"""
Supply Risk Agent
--------------------
Real responsibility: monitors supplier reliability + open procurement
commitments and detects shortfall / disruption risk. Unlike a passive
alert, it initiates a ripple by publishing SUPPLY_RISK_DETECTED so
Procurement, Vendor Renegotiation and Warehouse agents react immediately.
"""

from datetime import datetime
from agents.base import Agent, AgentResult
from engine import events as EV


class SupplyRiskAgent(Agent):
    name = "Supply Risk Agent"
    reacts_to = ()

    def detect(self, conn, llm, product_id, supplier_id, shortfall_pct):
        product = conn.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()
        supplier = conn.execute("SELECT * FROM suppliers WHERE id=?", (supplier_id,)).fetchone()
        open_orders = conn.execute(
            "SELECT * FROM procurement_orders WHERE product_id=? AND supplier_id=? AND status='CONFIRMED'",
            (product_id, supplier_id),
        ).fetchall()
        exposed_kg = sum(o["quantity_kg"] for o in open_orders) * (shortfall_pct / 100.0)

        severity = "HIGH" if shortfall_pct >= 30 else ("MEDIUM" if shortfall_pct >= 15 else "LOW")

        cur = conn.execute(
            "INSERT INTO supply_risks (supplier_id, product_id, risk_type, severity, detected_at, status, is_simulated) "
            "VALUES (?,?,?,?,?, 'OPEN', 1)",
            (supplier_id, product_id, "SHORTFALL", severity, datetime.utcnow().isoformat()),
        )
        conn.commit()

        decision = {
            "event": "SUPPLY_RISK_DETECTED",
            "product": product["name"],
            "product_id": product_id,
            "supplier": supplier["name"],
            "supplier_id": supplier_id,
            "shortfall_pct": shortfall_pct,
            "exposed_kg": round(exposed_kg, 1),
            "severity": severity,
            "evidence": [
                f"{len(open_orders)} open order(s) with {supplier['name']} for {product['name']}",
                f"Projected shortfall {shortfall_pct:.0f}% \u2192 {exposed_kg:.0f} kg exposed",
                f"Supplier reliability score {supplier['reliability_score']:.2f}",
            ],
        }
        fallback = (
            f"{supplier['name']} is projected to under-deliver {product['name']} by {shortfall_pct:.0f}%, "
            f"exposing roughly {exposed_kg:.0f} kg of confirmed orders. Severity {severity}. "
            f"Routing to Procurement and Vendor Renegotiation agents."
        )
        text = llm.explain(
            "You are the Supply Risk Agent inside HARVEX. State the supplier shortfall risk in one or two sentences.",
            decision, fallback,
        )
        result = AgentResult(
            decision=decision,
            reasoning=text["text"],
            confidence=0.72 + (0.15 if severity == "HIGH" else 0),
            downstream_events=[(EV.SUPPLY_RISK_DETECTED, decision)],
        )
        return result, text["mode"]