# HARVEX — Autonomous Fresh-Produce Operations OS

HARVEX is an **autonomous decision engine for fresh-produce supply chains**. It detects operational risks such as demand shocks, supplier shortfalls, and shelf-life crises, then coordinates specialized agents to decide what should happen across **inventory, procurement, warehousing, pricing, and logistics**.

Instead of simply showing that a problem exists, HARVEX follows the **ripple effect** of that problem and turns it into a chain of operational decisions.

> **Detect → Reason → Coordinate → Act → Measure Impact**

---

## 🚨 The Problem

Fresh produce has a narrow window between **arrival and spoilage**.

A small change in demand can create a chain reaction:

**Demand falls**
→ excess inventory
→ shelf-life pressure
→ markdowns
→ unnecessary procurement
→ warehouse congestion
→ wastage

Traditional supply-chain dashboards mostly show these problems **after they happen**.

HARVEX is designed to respond to them **before value is lost**.

---

## 💡 What HARVEX Does

HARVEX continuously works across the supply-chain network to:

* Monitor inventory and shelf life
* Detect demand changes
* Identify surplus and at-risk stock
* Adjust procurement quantities
* Evaluate supplier risk
* Prioritize warehouse allocation
* Coordinate movement of urgent batches
* Recommend pricing/markdown actions
* Track pending approvals
* Maintain an explainable decision trail
* Estimate avoided waste and preserved value

---

## 🧠 The Ripple Engine

The core idea behind HARVEX is the **Ripple Engine**.

A single operational event can trigger decisions across multiple specialized agents.

### Example

**Event:**
Banana demand falls **14% in Bengaluru**

↓

**Demand Sensing Agent**
Detects and classifies the demand shock.

↓

**Procurement Planning Agent**
Reduces the upcoming procurement target.

↓

**Warehouse Allocation Agent**
Identifies surplus banana inventory and batches approaching expiry.

↓

**Vendor Renegotiation Agent**
Recommends reducing an existing supplier commitment.

↓

**Shelf-Life Budget Allocator**
Prioritizes batches that need immediate movement.

↓

**Logistics Coordination Agent**
Routes urgent stock toward a high-demand retail cluster.

↓

**Waste Ledger**
Calculates the estimated impact of the intervention.

This creates an **explainable chain of decisions instead of a black-box recommendation.**

---

## 🤖 Specialized Agents

| Agent                            | Responsibility                                                 |
| -------------------------------- | -------------------------------------------------------------- |
| **Demand Sensing Agent**         | Detects demand shocks and changes                              |
| **Procurement Planning Agent**   | Adjusts future procurement                                     |
| **Warehouse Allocation Agent**   | Identifies surplus and risky inventory                         |
| **Vendor Renegotiation Agent**   | Handles supplier quantity adjustments                          |
| **Shelf-Life Budget Allocator**  | Prioritizes expiring batches                                   |
| **Logistics Coordination Agent** | Plans movement of urgent stock                                 |
| **Pricing Agent**                | Recommends markdowns                                           |
| **Waste Ledger Agent**           | Estimates avoided waste and recovered value                    |
| **ERP Automation Agent**         | Generates operational actions                                  |
| **Demand Cannibalization Guard** | Checks whether markdowns may shift demand from another product |

---

## 🖥️ Product Modules

### Operations Overview

A real-time command center showing:

* Total inventory
* Expiring inventory
* Ripple cascades
* Pending approvals
* Recent operational events
* Estimated impact
* Network footprint

### Ripple Console

The central decision interface.

It displays:

* Triggering event
* Agent-by-agent reasoning
* Actions taken
* Confidence
* Dependencies
* Approval requirements
* Final cascade status

### Inventory

Provides a batch-level view of:

* Product
* Warehouse
* Region
* Quantity
* Grade
* Days remaining
* Inventory status

### Procurement & Risk

Tracks:

* Open procurement orders
* Suppliers
* Quantities
* Price/kg
* Delivery dates
* Supply risks

### Logistics

Shows movement priorities based on:

* Shelf life
* Economic value
* Demand
* Destination
* Urgency

### Waste Ledger

Provides an impact view containing:

* Estimated waste avoided
* Estimated value preserved
* Baseline waste
* HARVEX outcome
* Shelf-life utilization

### Agent Activity

Provides an audit-style feed of decisions made across cascades.

---

## 🔄 Scenario Simulator

HARVEX includes a scenario simulator for testing operational events such as:

* ⚡ Demand Shock
* ⚡ Supplier Shortfall
* ⚡ Shelf-Life Crisis
* ⚡ Cold-Chain Breach
* ⚡ Demand Spike
* ⚡ Markdown Cannibalization

A scenario can be injected into the system and the **Ripple Engine generates the resulting decision chain**.

---

## 📊 Example Scenario

### Input

> **Banana demand falls 14% in Bengaluru**

### HARVEX Response

**Detection**

`DEMAND_SHOCK`

↓

**Procurement**

Reduce upcoming order by **634 kg**

↓

**Warehouse**

Identify approximately **29,954 kg** on hand with **13,070 kg** exposed to shelf-life pressure

↓

**Supplier**

Recommend reducing an existing commitment

↓

**Allocation**

Prioritize the batches with the shortest remaining shelf life

↓

**Logistics**

Move urgent batches toward the nearest high-demand cluster

↓

**Impact**

Estimate the amount of waste and value that could be avoided.

---

## 🏗️ Architecture

```text
                    ┌──────────────────────┐
                    │     HARVEX UI        │
                    │  Operations Console  │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │    Ripple Engine     │
                    │ Event → Decisions    │
                    └──────────┬───────────┘
                               │
             ┌─────────────────┼─────────────────┐
             ▼                 ▼                 ▼
       Demand Agent      Procurement Agent   Warehouse Agent
             │                 │                 │
             └─────────────────┼─────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │ Coordination Layer   │
                    └──────────┬───────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
     Logistics             Pricing             Supplier
          │                    │                    │
          └────────────────────┼────────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │    Impact Ledger     │
                    │ Waste + Value Saved  │
                    └──────────────────────┘
```

---

# Folder Architecture

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


## 🛠️ Tech Stack

### Frontend

* React
* Vite
* JavaScript
* CSS

### Backend

* Python
* Flask
* Flask-CORS
* Gunicorn

### Deployment

* Vercel — Frontend
* Render — Backend

---

## 🚀 Running Locally

### 1. Clone the repository

```bash
git clone https://github.com/ShreyaaAggarwal/Harvex.git
cd Harvex
```

### 2. Backend

```bash
cd backend
pip install -r requirements.txt
python app.py
```

For production:

```bash
gunicorn app:app
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

---

## 📦 Backend Requirements

```txt
Flask==3.1.3
gunicorn
flask-cors
```

---

## 🎯 Design Philosophy

HARVEX is built around three principles:

### 1. **Autonomous**

The system should move beyond dashboards and determine the next operational action.

### 2. **Explainable**

Every major decision should have a visible reason, confidence level, trigger, and resulting action.

### 3. **Human-in-the-loop**

Not every action should be executed automatically. Higher-risk decisions can be routed for approval while low-risk actions can be auto-executed.

---

## 📈 Impact

HARVEX measures the potential effect of its interventions through:

* Waste avoided
* Recoverable value
* Shelf-life utilization
* Inventory movement
* Procurement reduction
* Operational actions

**Important:** Impact numbers shown in the prototype are based on **synthetic seed data and simulation assumptions**. They represent estimated/prototype impact rather than measured real-world outcomes.

---

## 🔮 Future Scope

* Real-time IoT cold-chain sensor integration
* Live retailer demand feeds
* Weather-aware demand forecasting
* Supplier reliability scoring
* Route optimization
* ERP/WMS integration
* Real transaction execution
* Advanced ML demand forecasting
* Multi-city supply-chain optimization

---

## 🏆 Why HARVEX?

Most supply-chain systems answer:

> **“What is happening?”**

HARVEX aims to answer:

> **“What should happen next — and why?”**

**HARVEX turns supply-chain problems into coordinated, explainable actions before fresh produce becomes wasted value.**

