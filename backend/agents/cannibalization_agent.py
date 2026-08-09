"""
Demand Cannibalization Guard
--------------------------------
Real responsibility: before a markdown goes live, estimate how much of the
lift comes from genuinely new demand versus diverted purchases of a
substitute product — a second-order effect a naive pricing engine would
miss entirely. Uses a lightweight substitute map + relative sales share to
produce a bounded diversion estimate.
"""

from agents.base import Agent, AgentResult
from engine import events as EV

# Loose substitute groups by category — in production this would be learned
# from cross-price elasticity in the Sales Data feed rather than hardcoded.
SUBSTITUTE_GROUPS = {
    "Fruit": ["Alphonso Mango", "Banana (Robusta)", "Papaya", "Pomegranate", "Green Grapes"],
    "Vegetable": ["Tomato (Hybrid)", "Onion (Nashik Red)", "Capsicum", "Cauliflower"],
    "Leafy": ["Spinach"],
}


class DemandCannibalizationGuard(Agent):
    name = "Demand Cannibalization Guard"
    reacts_to = (EV.PRICING_RECOMMENDED,)

    def react(self, event, conn, llm) -> AgentResult:
        p = event.payload
        product = conn.execute("SELECT * FROM products WHERE id=?", (p["product_id"],)).fetchone()
        group = SUBSTITUTE_GROUPS.get(product["category"], [])
        substitutes = [name for name in group if name != product["name"]]

        # estimate diversion risk from markdown depth: deeper discount -> more likely to pull
        # share from close substitutes rather than create fully new demand
        markdown_pct = p["markdown_pct"]
        diversion_risk_pct = round(min(28, markdown_pct * 0.55), 1)
        risk_level = "HIGH" if diversion_risk_pct >= 15 else ("MEDIUM" if diversion_risk_pct >= 8 else "LOW")

        at_risk_substitute = None
        if substitutes:
            rows = conn.execute(
                "SELECT p.name, SUM(s.quantity_kg) as kg FROM sales s JOIN products p ON p.id=s.product_id "
                "WHERE p.name IN ({}) AND s.sale_date >= date('now','-14 day') GROUP BY p.name ORDER BY kg DESC LIMIT 1".format(
                    ",".join("?" * len(substitutes))
                ),
                substitutes,
            ).fetchone()
            if rows:
                at_risk_substitute = rows["name"]

        decision = {
            "event": "CANNIBALIZATION_FLAGGED",
            "product": product["name"],
            "product_id": p["product_id"],
            "markdown_pct": markdown_pct,
            "diversion_risk_pct": diversion_risk_pct,
            "risk_level": risk_level,
            "at_risk_substitute": at_risk_substitute,
            "recommendation": "PROCEED" if risk_level != "HIGH" else "PROCEED_WITH_CAPPED_MARKDOWN",
            "evidence": [
                f"Markdown depth {markdown_pct:.0f}% \u2192 diversion risk estimated at {diversion_risk_pct:.0f}% ({risk_level.lower()})",
                f"Nearest substitute by category: {at_risk_substitute or 'none identified'}",
                f"Substitute group: {', '.join(substitutes) if substitutes else 'none in category'}",
            ],
        }
        fallback = (
            f"A {markdown_pct:.0f}% markdown on {product['name']} carries an estimated {diversion_risk_pct:.0f}% "
            f"({risk_level.lower()}) risk of diverting demand from {at_risk_substitute or 'nearby substitutes'} "
            f"rather than generating fully new sales. "
            + ("Recommendation: proceed as planned." if risk_level != "HIGH"
               else "Recommendation: cap the markdown depth before ERP execution.")
        )
        text = llm.explain(
            "You are the Demand Cannibalization Guard inside HARVEX. Explain the diversion risk in one or two sentences.",
            decision, fallback,
        )

        return AgentResult(
            decision=decision,
            reasoning=text["text"],
            confidence=0.68,
            downstream_events=[],
        ), text["mode"]