# HARVEX — Autonomous Operations for India's Fresh-Produce Supply Chain

**HACKNITE CODE ROYALE 2026 — Fresh Produce OS — Autonomous AI Agents**

> Most systems tell an operator what changed. HARVEX determines what that
> change affects, coordinates the relevant operational decisions, and
> tracks the resulting waste and value impact.

HARVEX turns supply-chain changes into autonomous chains of coordinated
decisions. A demand shock, a supplier shortfall, or a cold-chain breach
is detected once — the **Ripple Engine** then propagates that change
through specialized agents (Procurement, Warehouse, Shelf-Life, Pricing,
Cannibalization Guard, Vendor Renegotiation, Logistics, ERP, Waste
Ledger), each reacting independently and publishing further events. The
result is visible, step by step, in the **Explainable Cascade Trace**.

---

## 1. Primary subtrack

🤖 **Autonomous AI Agents** — AI agents orchestrating agricultural and
operational workflows (demand sensing, procurement planning, warehouse
allocation, pricing, cold-chain risk, logistics coordination, ERP
automation). Supporting subtracks touched: Logistics & Traceability,
Sustainability & Rescue, Enterprise Software, Climate & Risk.

## 2. Data

The official HACKNITE datasets were not accessible during development.
HARVEX ships a **synthetic seed dataset** (`backend/seed_data.py`) —
10 produce types, 8 suppliers, 6 regional warehouses, ~70 inventory
batches, 60 days of sales history, demand signals, open procurement
orders, quality observations and cold-chain readings. Every row is
flagged `is_simulated = 1` in the schema, and every impact number the
UI shows is labelled **"Prototype simulation / estimated impact."**

`backend/data/adapters.py` is the seam where a real HACKNITE
dataset/API feed would replace the seed data — the agents, Ripple
Engine, API layer and frontend never depend on where a row came from,
only on the database schema in `backend/database.py`.

## 3. Architecture

```
harvex/
├── backend/
│   ├── app.py                 Flask API + static frontend server
│   ├── database.py            SQLite schema (18 tables) + connection helpers
│   ├── seed_data.py           Synthetic dataset generator
│   ├── llm_service.py         LLM wrapper with deterministic "Simulation mode" fallback
│   ├── data/
│   │   └── adapters.py        Boundary for swapping in official datasets later
│   ├── engine/
│   │   ├── events.py          Canonical event-type vocabulary
│   │   └── ripple_engine.py   Central orchestrator — the Ripple Engine
│   ├── agents/                One file per agent, each with a real responsibility
│   │   ├── demand_agent.py            Demand Sensing Agent
│   │   ├── supply_risk_agent.py       Supply Risk Agent
│   │   ├── cold_chain_agent.py        Cold-Chain Risk Monitor
│   │   ├── procurement_agent.py       Procurement Planning Agent
│   │   ├── warehouse_agent.py         Warehouse Allocation Agent
│   │   ├── shelf_life_agent.py        Shelf-Life Budget Allocator ⭐
│   │   ├── pricing_agent.py           Pricing Agent
│   │   ├── cannibalization_agent.py   Demand Cannibalization Guard
│   │   ├── vendor_agent.py            Vendor Renegotiation Agent
│   │   ├── logistics_agent.py         Logistics Coordination Agent
│   │   ├── erp_agent.py               ERP Automation Agent
│   │   ├── waste_ledger_agent.py      Waste Ledger Agent
│   │   └── farmer_advisor_agent.py    Farmer Commitment Advisor (optional/secondary)
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── index.html              Command-center shell (no build step)
    ├── css/styles.css          Design system: cream / olive / terracotta / charcoal
    └── js/app.js               Talks to the Flask API, renders every screen
```

### Why this is not a fixed linear pipeline

Agents never call each other. They publish structured **Events**
(`engine/events.py`) onto the Ripple Engine. Every agent whose
`reacts_to` list includes that event type reacts independently — so one
trigger fans out to several agents at once (e.g. `DEMAND_SHOCK` reaches
Procurement, Warehouse *and* Vendor Renegotiation in parallel), and
their outputs converge again downstream (Pricing → Cannibalization
Guard, and Pricing/Logistics/Procurement all feed the ERP Automation
Agent). The full graph for one trigger is 8–14 agent decisions deep.

### Explainable Cascade Trace

Every event, agent decision, action and downstream event is persisted
with a `cascade_id` and `step_order`. `GET /api/cascades/<id>/trace`
replays that log as an ordered list of:

`TRIGGER → AGENT → DECISION → WHY → DOWNSTREAM EVENT → NEXT AGENT → ACTION → CONFIDENCE`

The Ripple Console renders this as a connected, animated flow — the
signature UI element.

### Deterministic vs. LLM

Arithmetic, shelf-life math, exposure classification, markdown sizing
and waste calculations are **deterministic Python**, not LLM calls —
see any `agents/*.py`. The LLM (via `llm_service.py`) is used only to
phrase the one- or two-sentence "why" explanation attached to each
decision. If `ANTHROPIC_API_KEY` is unset, or the call fails for any
reason, HARVEX falls back to a deterministic template built from the
same real numbers and marks it **"Simulation mode"** in the UI — the
product stays fully demoable offline.

### Human-in-the-loop

Actions above a materiality threshold (large procurement changes, deep
markdowns, vendor renegotiations) are created with
`requires_approval = true` and sit in **Pending Approvals** until a
manager approves or rejects them from the drawer in the UI. Low-risk
actions (dispatch tasks, small ERP updates) auto-execute in the
simulation.

## 4. Setup & run

Requirements: Python 3.9+, no external network access needed to run.

```bash
cd backend
pip install -r requirements.txt          # only dependency is Flask
cp .env.example .env                     # optional — see below
python seed_data.py                      # creates backend/harvex.db
python app.py                            # serves API + frontend on :5000
```

Open **http://localhost:5000** in a browser.

To re-seed at any time (fresh demo state), either re-run
`python seed_data.py` or `POST /api/admin/reset`.

### Optional: live LLM reasoning

By default HARVEX runs in **Simulation mode** — explanation text is
generated deterministically from real computed numbers, no API key
needed. To enable live reasoning text from Claude, set in `.env` (or
the environment):

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6
```

The mode currently active is shown in the sidebar ("Live reasoning" /
"Simulation mode") and per-step in the Cascade Trace.

## 5. Demo script (3–5 minutes)

1. **Overview** — stable network state: on-hand inventory, batches
   expiring soon, warehouse footprint.
2. **Ripple Console → "Demand Shock"** — triggers *"Alphonso Mango
   demand falls 27% in Pune."*
3. Watch the cascade render live: Demand Sensing → Procurement
   (reduce order) → Warehouse (surplus exposure) → Vendor
   Renegotiation → Shelf-Life Budget Allocator (prioritizes soonest-
   expiring batches) → Pricing (sized markdown) → Cannibalization
   Guard (checks diversion to Banana/Papaya/Pomegranate/Grapes) →
   Logistics (dispatch priority) → ERP Automation (queued actions) →
   Waste Ledger (kg avoided, ₹ preserved).
4. Open **Pending Approvals** — approve the queued markdown/PO
   amendment to show human-in-the-loop control.
5. **Waste Ledger** tab — cumulative estimated impact across cascades,
   clearly labelled as prototype simulation.
6. Run **Cold-Chain Breach** or **Supplier Shortfall** to show the
   engine reacts differently to a different trigger type without any
   code change — same agents, same engine, different cascade shape.

## 6. Scaling notes (conceptual — not load-tested)

- The schema uses IDs/foreign keys per product/warehouse/supplier/region
  rather than hardcoding a single warehouse, so adding regional nodes is
  a data operation, not a code change.
- Agents are stateless — all operational state lives in the database,
  so the Ripple Engine's propagation loop could run across multiple
  worker processes reading/writing the same store (swap SQLite for
  Postgres and add a message queue in front of the event loop for a
  production deployment).
- Deterministic calculations dominate; LLM calls are limited to short
  explanation text per decision, capping cost and latency as event
  volume grows.
- `data/adapters.py` isolates the ingestion boundary so plugging in the
  official multi-region HACKNITE feeds does not touch agents, the
  Ripple Engine, or the frontend.
- Not claimed or tested at production/million-tonne scale — this is a
  hackathon prototype demonstrating the architecture pattern.

## 7. What's simulated vs. real

- **Real**: the orchestration logic, the event-driven fan-out/fan-in,
  the deterministic business math (shelf-life scoring, markdown sizing,
  waste/value calculations), the full persisted decision trail, the
  approval workflow.
- **Simulated / synthetic**: the underlying dataset (no official
  HACKNITE data was available), ERP/ WMS integrations (actions are
  recorded as simulated ERP actions, not sent to a real ERP), and LLM
  explanation text falls back to deterministic templates without an API
  key.

No dead buttons, no unimplemented screens — every visible feature in
the UI is backed by a working API endpoint and real (if synthetic) data.
