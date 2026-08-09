"""
Farmer Commitment Advisor (optional / secondary)
----------------------------------------------------
Real responsibility: given a vendor renegotiation, offers a light-touch
forward-looking view on whether future procurement commitments with that
supplier/product pair still make sense under the current demand trend.
Kept secondary to the core Ripple workflow as specified.
"""

from agents.base import Agent, AgentResult
from engine import events as EV


class FarmerCommitmentAdvisor(Agent):
    name = "Farmer Commitment Advisor"
    reacts_to = (EV.VENDOR_RENEGOTIATION_RECOMMENDED,)

    def react(self, event, conn, llm) -> AgentResult:
        p = event.payload
        if p.get("recommended_action") == "NO_OPEN_COMMITMENTS":
            return AgentResult(
                decision={"event": "FARMER_COMMITMENT_ADVISORY", "note": "no advisory needed"},
                reasoning="No open commitments to advise on.",
                confidence=0.4, downstream_events=[],
            ), "simulation"

        recent_trend = conn.execute(
            "SELECT trend, COUNT(*) c FROM demand_signals WHERE product_id=? GROUP BY trend ORDER BY c DESC LIMIT 1",
            (p["product_id"],),
        ).fetchone()
        dominant_trend = recent_trend["trend"] if recent_trend else "STABLE"

        if dominant_trend == "FALLING":
            stance = "HOLD_FUTURE_COMMITMENTS"
        elif dominant_trend == "RISING":
            stance = "MAINTAIN_OR_EXPAND_COMMITMENTS"
        else:
            stance = "MAINTAIN_CURRENT_COMMITMENTS"

        decision = {
            "event": "FARMER_COMMITMENT_ADVISORY",
            "product": p["product"],
            "supplier": p.get("supplier"),
            "dominant_recent_trend": dominant_trend,
            "recommended_stance": stance,
        }
        fallback = (
            f"Recent demand trend for {p['product']} is predominantly {dominant_trend.lower()}; "
            f"advisory stance on future commitments with {p.get('supplier', 'this supplier')}: {stance.replace('_', ' ').lower()}."
        )
        text = llm.explain(
            "You are the Farmer Commitment Advisor inside HARVEX, a secondary supporting agent. State the forward-looking commitment stance in one sentence.",
            decision, fallback,
        )

        return AgentResult(
            decision=decision, reasoning=text["text"], confidence=0.6,
            downstream_events=[],
        ), text["mode"]
