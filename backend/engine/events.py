"""
HARVEX — Event schema
-----------------------
An Event is the atomic unit the Ripple Engine propagates. Agents do not
call each other directly — they publish Events, and any agent whose
`handles()` matches reacts independently. This is what makes the cascade
non-linear: two agents can react to the same event, and a single trigger
can fan out into several independent branches.
"""

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class Event:
    event_type: str
    payload: dict
    cascade_id: int
    parent_event_id: Optional[int] = None
    created_by_agent: Optional[str] = None
    id: Optional[int] = None
    step_order: Optional[int] = None


# Canonical event types flowing through the Ripple Engine.
DEMAND_SHOCK = "DEMAND_SHOCK"                    # demand rose/fell sharply
SUPPLY_RISK_DETECTED = "SUPPLY_RISK_DETECTED"    # shortfall / disruption
COLD_CHAIN_BREACH = "COLD_CHAIN_BREACH"          # temperature excursion
SHELF_LIFE_PRESSURE = "SHELF_LIFE_PRESSURE"      # batches at risk of ageing out
PROCUREMENT_ADJUSTED = "PROCUREMENT_ADJUSTED"
INVENTORY_EXPOSURE = "INVENTORY_EXPOSURE"        # excess/short exposure identified
SHELF_LIFE_ALLOCATED = "SHELF_LIFE_ALLOCATED"
PRICING_RECOMMENDED = "PRICING_RECOMMENDED"
CANNIBALIZATION_FLAGGED = "CANNIBALIZATION_FLAGGED"
VENDOR_RENEGOTIATION_RECOMMENDED = "VENDOR_RENEGOTIATION_RECOMMENDED"
LOGISTICS_PRIORITIZED = "LOGISTICS_PRIORITIZED"
ERP_ACTION_GENERATED = "ERP_ACTION_GENERATED"
WASTE_IMPACT_ESTIMATED = "WASTE_IMPACT_ESTIMATED"

# Added for the What-If / Counterfactual Simulator and Intervention Optimizer.
LOGISTICS_DELAY = "LOGISTICS_DELAY"                    # truck breakdown / rainfall / route disruption
INTERVENTION_RECOMMENDED = "INTERVENTION_RECOMMENDED"  # Intervention Optimizer's ranked-options output