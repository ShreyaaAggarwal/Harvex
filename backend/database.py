"""
HARVEX — Database layer
------------------------
SQLite-backed operational data store. Chosen for a zero-dependency,
zero-network prototype that still models a properly normalized
relational schema (the same schema maps cleanly onto Postgres/MySQL
for a production deployment — see README "Scaling" section).
"""

import sqlite3
import os
import json
from contextlib import contextmanager

DB_PATH = os.path.join(os.path.dirname(__file__), "harvex.db")

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'kg',
    shelf_life_days INTEGER NOT NULL,
    brix_target REAL,
    base_price_per_kg REAL NOT NULL,
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    region TEXT NOT NULL,
    reliability_score REAL NOT NULL,
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS warehouses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    region TEXT NOT NULL,
    capacity_kg REAL NOT NULL,
    cold_chain_enabled INTEGER NOT NULL DEFAULT 1,
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS inventory_batches (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    batch_code TEXT NOT NULL,
    quantity_kg REAL NOT NULL,
    harvest_date TEXT NOT NULL,
    expiry_date TEXT NOT NULL,
    quality_grade TEXT NOT NULL DEFAULT 'A',
    status TEXT NOT NULL DEFAULT 'IN_STOCK',
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    sale_date TEXT NOT NULL,
    quantity_kg REAL NOT NULL,
    price_per_kg REAL NOT NULL,
    region TEXT NOT NULL,
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS demand_signals (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    region TEXT NOT NULL,
    signal_date TEXT NOT NULL,
    demand_index REAL NOT NULL,
    trend TEXT NOT NULL DEFAULT 'STABLE',
    source TEXT NOT NULL DEFAULT 'simulated_pos_search_blend',
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS procurement_orders (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    quantity_kg REAL NOT NULL,
    price_per_kg REAL NOT NULL,
    order_date TEXT NOT NULL,
    delivery_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'CONFIRMED',
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS quality_observations (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES inventory_batches(id),
    observed_at TEXT NOT NULL,
    defect_pct REAL NOT NULL,
    firmness_score REAL NOT NULL,
    brix REAL,
    color_score REAL NOT NULL,
    notes TEXT,
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS logistics_operations (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES inventory_batches(id),
    origin_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    destination TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'NORMAL',
    status TEXT NOT NULL DEFAULT 'PLANNED',
    dispatch_time TEXT,
    eta TEXT,
    cascade_id INTEGER,
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cold_chain_observations (
    id INTEGER PRIMARY KEY,
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    batch_id INTEGER REFERENCES inventory_batches(id),
    recorded_at TEXT NOT NULL,
    temperature_c REAL NOT NULL,
    target_temperature_c REAL NOT NULL,
    humidity_pct REAL NOT NULL,
    is_breach INTEGER NOT NULL DEFAULT 0,
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pricing_decisions (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    warehouse_id INTEGER,
    decided_at TEXT NOT NULL,
    old_price REAL NOT NULL,
    new_price REAL NOT NULL,
    reason TEXT NOT NULL,
    cannibalization_risk TEXT DEFAULT 'NONE',
    cascade_id INTEGER,
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS supply_risks (
    id INTEGER PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id),
    product_id INTEGER REFERENCES products(id),
    risk_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    cascade_id INTEGER,
    is_simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cascades (
    id INTEGER PRIMARY KEY,
    scenario_type TEXT NOT NULL,
    trigger_description TEXT NOT NULL,
    started_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'IN_PROGRESS'
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    cascade_id INTEGER NOT NULL REFERENCES cascades(id),
    parent_event_id INTEGER,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_by_agent TEXT,
    step_order INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_decisions (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id),
    cascade_id INTEGER NOT NULL REFERENCES cascades(id),
    agent_name TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    confidence REAL NOT NULL,
    step_order INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY,
    decision_id INTEGER NOT NULL REFERENCES agent_decisions(id),
    cascade_id INTEGER NOT NULL REFERENCES cascades(id),
    action_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL,
    decided_at TEXT
);

CREATE TABLE IF NOT EXISTS waste_ledger (
    id INTEGER PRIMARY KEY,
    cascade_id INTEGER NOT NULL REFERENCES cascades(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    baseline_waste_kg REAL NOT NULL,
    harvex_waste_kg REAL NOT NULL,
    waste_avoided_kg REAL NOT NULL,
    value_preserved_inr REAL NOT NULL,
    shelf_life_utilization_pct REAL NOT NULL,
    notes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_simulated INTEGER NOT NULL DEFAULT 1
);
"""


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def db_session():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(reset=False):
    if reset and os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    conn = get_conn()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def row_to_dict(row):
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}


def rows_to_list(rows):
    return [row_to_dict(r) for r in rows]


def dumps(obj):
    return json.dumps(obj, default=str)
