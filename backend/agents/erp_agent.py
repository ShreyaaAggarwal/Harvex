"""
ERP Automation Agent
-----------------------
Real responsibility: converts approved autonomous decisions into concrete
operational actions (PO amendments, price updates, dispatch tasks, vendor
tasks) recorded as simulated ERP actions in the prototype's action queue.
Low-risk actions execute automatically; high-impact ones are queued for
human approval (see human-in-the-loop workflow in app.py).
"""

from agents.base import Agent, AgentResult
from engine import events as EV


class ERPAutomationAgent(Agent):
    name = "ERP Automation Agent"
    reacts_to = (EV.PRICING_RECOMMENDED, EV.LOGISTICS_PRIORITIZED, EV.PROCUREMENT_ADJUSTED)

    def react(self, event, conn, llm) -> AgentResult:
        p = event.payload
        source = event.event_type

        if source == EV.PRICING_RECOMMENDED:
            task = f"Publish new price ₹{p['new_price']}/kg for {p['product']} across POS/ERP price lists"
            action_type = "ERP_PRICE_UPDATE"
            requires_approval = p["markdown_pct"] >= 20
        elif source == EV.LOGISTICS_PRIORITIZED:
            task = f"Create {len(p['moves'])} dispatch task(s) for {p['product']} in WMS/ERP"
            action_type = "ERP_DISPATCH_TASK"
            requires_approval = False
        else:
            task = f"Amend purchase order pipeline for {p['product']} by {p['quantity_change_kg']:+.0f} kg"
            action_type = "ERP_PO_AMENDMENT"
            requires_approval = abs(p.get("quantity_change_kg", 0)) > 1500

        decision = {
            "event": "ERP_ACTION_GENERATED",
            "source_event": source,
            "task": task,
            "action_type": action_type,
        }
        fallback = f"Generated ERP action: {task}. {'Queued for manager approval.' if requires_approval else 'Auto-executed (low risk).'}"
        text = llm.explain(
            "You are the ERP Automation Agent inside HARVEX. State the ERP action generated in one short sentence.",
            decision, fallback,
        )

        actions = [{
            "action_type": action_type,
            "payload": {"task": task, "source_event": source},
            "requires_approval": requires_approval,
        }]

        return AgentResult(
            decision=decision, reasoning=text["text"], confidence=0.9,
            downstream_events=[], actions=actions,
        ), text["mode"]
