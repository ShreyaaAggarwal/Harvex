"""
Demand Sensing Agent
----------------------
Real responsibility: reads demand_signals + sales history and classifies
demand shocks (drops or spikes) with a severity band. This is the entry
sensor for demand-driven cascades — it does not decide what to DO about
the shock, only detects and characterizes it, then hands off via a
DEMAND_SHOCK event.
"""

from datetime import datetime
from agents.base import Agent, AgentResult
from engine import events as EV


class DemandSensingAgent(Agent):
    name = "Demand Sensing Agent"
    reacts_to = ()  # this is a root sensor, invoked directly by the scenario simulator

    def _severity(self, change_pct):
        m = abs(change_pct)
        if m >= 25:
            return "HIGH"
        if m >= 12:
            return "MEDIUM"
        return "LOW"

    def detect(self, conn, llm, product_id, region, change_pct):
        product = conn.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()
        direction = "DROP" if change_pct < 0 else "SPIKE"
        severity = self._severity(change_pct)

        # record the shock as a fresh demand_signal row (grounded in the data model)
        conn.execute(
            "INSERT INTO demand_signals (product_id, region, signal_date, demand_index, trend, source, is_simulated) "
            "VALUES (?,?,?,?,?,?,1)",
            (product_id, region, datetime.utcnow().strftime("%Y-%m-%d"),
             max(0, 75 + change_pct), "FALLING" if change_pct < 0 else "RISING", "scenario_simulator"),
        )
        conn.commit()

        decision = {
            "event": "DEMAND_SHOCK",
            "product": product["name"],
            "product_id": product_id,
            "region": region,
            "direction": direction,
            "change_pct": change_pct,
            "severity": severity,
            "evidence": [
                f"New demand signal logged for {product['name']} in {region}: {change_pct:+.1f}% vs trailing baseline",
                f"Classified {severity} severity {direction.lower()}",
            ],
        }
        fallback = (
            f"{product['name']} demand in {region} moved {change_pct:+.1f}% against the trailing baseline — "
            f"classified as a {severity} severity {direction.lower()}. Routing to Procurement, Warehouse and "
            f"Vendor agents for reaction."
        )
        text = llm.explain(
            "You are the Demand Sensing Agent inside HARVEX, an autonomous fresh-produce operations system. "
            "State the demand shock plainly in one or two sentences for an operations manager.",
            decision, fallback,
        )
        result = AgentResult(
            decision=decision,
            reasoning=text["text"],
            confidence=0.9 if severity == "HIGH" else 0.78,
            downstream_events=[(EV.DEMAND_SHOCK, decision)],
        )
        return result, text["mode"]