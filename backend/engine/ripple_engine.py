"""
HARVEX — Ripple Engine
-------------------------
The nervous system of HARVEX. A trigger produces an Event. Every agent
that declares interest in that event type reacts to it *independently* —
this is deliberately NOT a fixed linear pipeline. Each reaction can
publish further Events, which fan out to whichever agents react to
those, and so on, until the cascade settles or a safety step-cap is hit.

Every event, every agent decision, and every resulting action is
persisted, which is what makes the Explainable Cascade Trace possible:
the trace is simply the ordered decision log for one cascade_id.
"""

from datetime import datetime
from collections import deque

from database import dumps
from engine.events import Event
from llm_service import llm_service

from agents.demand_agent import DemandSensingAgent
from agents.supply_risk_agent import SupplyRiskAgent
from agents.cold_chain_agent import ColdChainRiskMonitor
from agents.procurement_agent import ProcurementPlanningAgent
from agents.warehouse_agent import WarehouseAllocationAgent
from agents.shelf_life_agent import ShelfLifeBudgetAllocator
from agents.pricing_agent import PricingAgent
from agents.cannibalization_agent import DemandCannibalizationGuard
from agents.vendor_agent import VendorRenegotiationAgent
from agents.logistics_agent import LogisticsCoordinationAgent
from agents.erp_agent import ERPAutomationAgent
from agents.waste_ledger_agent import WasteLedgerAgent
from agents.farmer_advisor_agent import FarmerCommitmentAdvisor
from agents.intervention_agent import InterventionOptimizerAgent

MAX_STEPS = 60


class RippleEngine:
    def __init__(self):
        # sensing / root-trigger agents (invoked directly by the scenario simulator)
        self.demand_agent = DemandSensingAgent()
        self.supply_risk_agent = SupplyRiskAgent()
        self.cold_chain_agent = ColdChainRiskMonitor()
        self.warehouse_agent = WarehouseAllocationAgent()
        self.logistics_agent = LogisticsCoordinationAgent()

        # reactive agents (invoked generically whenever their event types fire)
        self.reactive_agents = [
            ProcurementPlanningAgent(),
            self.warehouse_agent,
            VendorRenegotiationAgent(),
            ShelfLifeBudgetAllocator(),
            PricingAgent(),
            DemandCannibalizationGuard(),
            self.logistics_agent,
            ERPAutomationAgent(),
            WasteLedgerAgent(),
            FarmerCommitmentAdvisor(),
            InterventionOptimizerAgent(),
        ]
        self.llm = llm_service

    # ---------- persistence helpers ----------

    def _new_cascade(self, conn, scenario_type, trigger_description):
        cur = conn.execute(
            "INSERT INTO cascades (scenario_type, trigger_description, started_at, status) VALUES (?,?,?, 'IN_PROGRESS')",
            (scenario_type, trigger_description, datetime.utcnow().isoformat()),
        )
        conn.commit()
        return cur.lastrowid

    def _persist_event(self, conn, event: Event, step_order):
        cur = conn.execute(
            "INSERT INTO events (cascade_id, parent_event_id, event_type, payload_json, created_by_agent, step_order, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (event.cascade_id, event.parent_event_id, event.event_type, dumps(event.payload),
             event.created_by_agent, step_order, datetime.utcnow().isoformat()),
        )
        conn.commit()
        event.id = cur.lastrowid
        event.step_order = step_order
        return event

    def _persist_decision(self, conn, event, agent_name, result, mode, step_order, downstream_event_ids):
        decision_payload = dict(result.decision)
        decision_payload["_llm_mode"] = mode
        decision_payload["_downstream_event_ids"] = downstream_event_ids
        cur = conn.execute(
            "INSERT INTO agent_decisions (event_id, cascade_id, agent_name, decision_json, reasoning, confidence, step_order, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (event.id, event.cascade_id, agent_name, dumps(decision_payload), result.reasoning,
             result.confidence, step_order, datetime.utcnow().isoformat()),
        )
        conn.commit()
        return cur.lastrowid

    def _persist_actions(self, conn, decision_id, cascade_id, actions):
        ids = []
        for a in actions:
            status = "PENDING" if a.get("requires_approval") else "AUTO_EXECUTED"
            cur = conn.execute(
                "INSERT INTO actions (decision_id, cascade_id, action_type, payload_json, requires_approval, status, created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (decision_id, cascade_id, a["action_type"], dumps(a["payload"]),
                 1 if a.get("requires_approval") else 0, status, datetime.utcnow().isoformat()),
            )
            conn.commit()
            ids.append(cur.lastrowid)
        return ids

    # ---------- core propagation loop ----------

    def _propagate(self, conn, cascade_id, seed_events, step_counter_start=2):
        """seed_events: list of Event objects already persisted (the root)."""
        queue = deque(seed_events)
        step = step_counter_start
        steps_taken = 0

        while queue and steps_taken < MAX_STEPS:
            event = queue.popleft()
            matching = [a for a in self.reactive_agents if a.handles(event.event_type)]
            for agent in matching:
                steps_taken += 1
                if steps_taken >= MAX_STEPS:
                    break
                result, mode = agent.react(event, conn, self.llm)

                downstream_events = []
                for ev_type, payload in result.downstream_events:
                    new_event = Event(event_type=ev_type, payload=payload, cascade_id=cascade_id,
                                       parent_event_id=event.id, created_by_agent=agent.name)
                    step += 1
                    self._persist_event(conn, new_event, step)
                    downstream_events.append(new_event)

                step += 1
                decision_id = self._persist_decision(
                    conn, event, agent.name, result, mode, step,
                    [e.id for e in downstream_events],
                )
                if result.actions:
                    self._persist_actions(conn, decision_id, cascade_id, result.actions)

                for e in downstream_events:
                    queue.append(e)

        conn.execute("UPDATE cascades SET status='COMPLETE' WHERE id=?", (cascade_id,))
        conn.commit()

    # ---------- scenario entry points ----------

    def trigger_demand_shock(self, conn, product_id, region, change_pct, scenario_label="DEMAND_SHOCK"):
        direction = "falls" if change_pct < 0 else "rises"
        product = conn.execute("SELECT name FROM products WHERE id=?", (product_id,)).fetchone()
        trigger_desc = f"{product['name']} demand {direction} {abs(change_pct):.0f}% in {region}"
        cascade_id = self._new_cascade(conn, scenario_label, trigger_desc)

        result, mode = self.demand_agent.detect(conn, self.llm, product_id, region, change_pct)
        root_event = Event(event_type=result.downstream_events[0][0], payload=result.downstream_events[0][1],
                            cascade_id=cascade_id, parent_event_id=None, created_by_agent="Scenario Trigger")
        self._persist_event(conn, root_event, step_order=1)
        self._persist_decision(conn, root_event, self.demand_agent.name, result, mode, step_order=1, downstream_event_ids=[root_event.id])

        self._propagate(conn, cascade_id, [root_event])
        return cascade_id

    def trigger_supply_risk(self, conn, product_id, supplier_id, shortfall_pct):
        supplier = conn.execute("SELECT name FROM suppliers WHERE id=?", (supplier_id,)).fetchone()
        product = conn.execute("SELECT name FROM products WHERE id=?", (product_id,)).fetchone()
        trigger_desc = f"{supplier['name']} projects a {shortfall_pct:.0f}% shortfall on {product['name']}"
        cascade_id = self._new_cascade(conn, "SUPPLIER_SHORTFALL", trigger_desc)

        result, mode = self.supply_risk_agent.detect(conn, self.llm, product_id, supplier_id, shortfall_pct)
        root_event = Event(event_type=result.downstream_events[0][0], payload=result.downstream_events[0][1],
                            cascade_id=cascade_id, parent_event_id=None, created_by_agent="Scenario Trigger")
        self._persist_event(conn, root_event, step_order=1)
        self._persist_decision(conn, root_event, self.supply_risk_agent.name, result, mode, step_order=1, downstream_event_ids=[root_event.id])

        self._propagate(conn, cascade_id, [root_event])
        return cascade_id

    def trigger_cold_chain_breach(self, conn, warehouse_id, excursion_c):
        wh = conn.execute("SELECT name FROM warehouses WHERE id=?", (warehouse_id,)).fetchone()
        trigger_desc = f"Cold-chain excursion of {excursion_c:+.1f}\u00b0C detected at {wh['name']}"
        cascade_id = self._new_cascade(conn, "COLD_CHAIN_BREACH", trigger_desc)

        result, mode = self.cold_chain_agent.detect(conn, self.llm, warehouse_id, excursion_c)
        root_event = Event(event_type=result.downstream_events[0][0], payload=result.downstream_events[0][1],
                            cascade_id=cascade_id, parent_event_id=None, created_by_agent="Scenario Trigger")
        self._persist_event(conn, root_event, step_order=1)
        self._persist_decision(conn, root_event, self.cold_chain_agent.name, result, mode, step_order=1, downstream_event_ids=[root_event.id])

        self._propagate(conn, cascade_id, [root_event])
        return cascade_id

    def trigger_shelf_life_crisis(self, conn, product_id):
        product = conn.execute("SELECT name FROM products WHERE id=?", (product_id,)).fetchone()
        trigger_desc = f"Routine scan flags critical shelf-life exposure on {product['name']}"
        cascade_id = self._new_cascade(conn, "SHELF_LIFE_CRISIS", trigger_desc)

        result, mode = self.warehouse_agent.detect_shelf_life_crisis(conn, self.llm, product_id)
        root_event = Event(event_type=result.downstream_events[0][0], payload=result.downstream_events[0][1],
                            cascade_id=cascade_id, parent_event_id=None, created_by_agent="Scenario Trigger")
        self._persist_event(conn, root_event, step_order=1)
        self._persist_decision(conn, root_event, self.warehouse_agent.name, result, mode, step_order=1, downstream_event_ids=[root_event.id])

        self._propagate(conn, cascade_id, [root_event])
        return cascade_id

    def trigger_logistics_delay(self, conn, warehouse_id, delay_hours, disruption_type="TRUCK_BREAKDOWN"):
        """Feature 5 — What-If / Counterfactual Simulator entry point for
        Truck Breakdown / Heavy Rainfall / route-disruption scenarios.
        Uses the real Ripple Engine + agent chain, not a canned result:
        LOGISTICS_DELAY -> Warehouse exposure -> Shelf-Life pressure ->
        Shelf-Life Allocator -> Pricing / Logistics / Intervention
        Optimizer -> ERP -> Waste Ledger."""
        wh = conn.execute("SELECT name FROM warehouses WHERE id=?", (warehouse_id,)).fetchone()
        label = disruption_type.replace("_", " ").title()
        trigger_desc = f"{label} adds a {delay_hours:.0f}h delay affecting {wh['name']}"
        cascade_id = self._new_cascade(conn, disruption_type, trigger_desc)

        result, mode = self.logistics_agent.detect_delay(conn, self.llm, warehouse_id, delay_hours, disruption_type)
        root_event = Event(event_type=result.downstream_events[0][0], payload=result.downstream_events[0][1],
                            cascade_id=cascade_id, parent_event_id=None, created_by_agent="Scenario Trigger")
        self._persist_event(conn, root_event, step_order=1)
        self._persist_decision(conn, root_event, self.logistics_agent.name, result, mode, step_order=1, downstream_event_ids=[root_event.id])

        self._propagate(conn, cascade_id, [root_event])
        return cascade_id


ripple_engine = RippleEngine()