"""
HARVEX — Agent base contract
------------------------------
Every agent has a REAL responsibility: it reads operational state from the
database, applies deterministic business logic (arithmetic, shelf-life math,
inventory constraints), optionally asks the LLM service for contextual
reasoning/explanation text, and returns a structured AgentResult. Agents
never talk to each other directly — they publish new Events, which the
Ripple Engine routes to whichever agents declare interest via `handles()`.
"""

from dataclasses import dataclass, field
from typing import List, Tuple


@dataclass
class AgentResult:
    decision: dict                     # structured decision payload (machine-readable)
    reasoning: str                     # short human-readable "why"
    confidence: float                  # 0..1
    downstream_events: List[Tuple[str, dict]] = field(default_factory=list)
    actions: List[dict] = field(default_factory=list)
    # each action: {action_type, payload, requires_approval}


class Agent:
    name = "BaseAgent"
    # event_types this agent reacts to
    reacts_to = ()

    def handles(self, event_type: str) -> bool:
        return event_type in self.reacts_to

    def react(self, event, conn, llm) -> AgentResult:
        raise NotImplementedError
