"""
HARVEX — Backend entrypoint
------------------------------
Flask API layer. Serves the JSON API under /api/* and the static frontend
(built with plain HTML/CSS/JS — no bundler/network build step required)
from ../frontend. Run with: python app.py
"""

import os
import json
from datetime import datetime, date
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from database import get_conn, db_session, init_db, row_to_dict, rows_to_list, dumps
from engine.ripple_engine import ripple_engine
from llm_service import llm_service
import seed_data

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

app = Flask(__name__, static_folder=None)
CORS(
    app,
    resources={
        r"/api/*": {
            "origins": r"https://.*\.vercel\.app"
        }
    },
    methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"]
)


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(FRONTEND_DIR, path)


# ---------------------------------------------------------------------------
# Meta
# ---------------------------------------------------------------------------

@app.route("/api/meta")
def meta():
    return jsonify({
        "product": "HARVEX",
        "tagline": "Autonomous operations for India's fresh-produce supply chain",
        "llm_mode": "live" if llm_service.live_mode else "simulation",
        "data_mode": "synthetic_seed_v1",
    })


# ---------------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------------

@app.route("/api/products")
def products():
    with db_session() as conn:
        rows = conn.execute("SELECT * FROM products ORDER BY name").fetchall()
        return jsonify(rows_to_list(rows))


@app.route("/api/suppliers")
def suppliers():
    with db_session() as conn:
        rows = conn.execute("SELECT * FROM suppliers ORDER BY name").fetchall()
        return jsonify(rows_to_list(rows))


@app.route("/api/warehouses")
def warehouses():
    with db_session() as conn:
        rows = conn.execute("""
            SELECT w.*,
                   COALESCE(SUM(b.quantity_kg), 0) as current_stock_kg,
                   COUNT(b.id) as batch_count
            FROM warehouses w
            LEFT JOIN inventory_batches b ON b.warehouse_id = w.id AND b.status='IN_STOCK'
            GROUP BY w.id ORDER BY w.name
        """).fetchall()
        return jsonify(rows_to_list(rows))


# ---------------------------------------------------------------------------
# Overview
# ---------------------------------------------------------------------------

@app.route("/api/overview")
def overview():
    with db_session() as conn:
        total_stock = conn.execute("SELECT COALESCE(SUM(quantity_kg),0) v FROM inventory_batches WHERE status='IN_STOCK'").fetchone()["v"]
        batch_count = conn.execute("SELECT COUNT(*) c FROM inventory_batches WHERE status='IN_STOCK'").fetchone()["c"]
        expiring_soon = conn.execute(
            "SELECT COUNT(*) c, COALESCE(SUM(quantity_kg),0) kg FROM inventory_batches "
            "WHERE status='IN_STOCK' AND julianday(expiry_date) - julianday('now') <= 3"
        ).fetchone()
        open_risks = conn.execute("SELECT COUNT(*) c FROM supply_risks WHERE status='OPEN'").fetchone()["c"]
        pending_actions = conn.execute("SELECT COUNT(*) c FROM actions WHERE status='PENDING'").fetchone()["c"]
        active_cascades = conn.execute("SELECT COUNT(*) c FROM cascades WHERE status='IN_PROGRESS'").fetchone()["c"]
        total_cascades = conn.execute("SELECT COUNT(*) c FROM cascades").fetchone()["c"]

        waste = conn.execute(
            "SELECT COALESCE(SUM(waste_avoided_kg),0) kg, COALESCE(SUM(value_preserved_inr),0) inr, "
            "COALESCE(AVG(shelf_life_utilization_pct),0) util FROM waste_ledger"
        ).fetchone()

        recent_cascades = conn.execute(
            "SELECT * FROM cascades ORDER BY id DESC LIMIT 6"
        ).fetchall()

        return jsonify({
            "total_stock_kg": round(total_stock, 0),
            "batch_count": batch_count,
            "expiring_soon_batches": expiring_soon["c"],
            "expiring_soon_kg": round(expiring_soon["kg"], 0),
            "open_supply_risks": open_risks,
            "pending_actions": pending_actions,
            "active_cascades": active_cascades,
            "total_cascades": total_cascades,
            "waste_avoided_kg_total": round(waste["kg"], 0),
            "value_preserved_inr_total": round(waste["inr"], 0),
            "avg_shelf_life_utilization_pct": round(waste["util"], 1),
            "recent_cascades": rows_to_list(recent_cascades),
            "impact_label": "Prototype simulation / estimated impact",
        })


# ---------------------------------------------------------------------------
# Inventory / Procurement / Risk / Logistics
# ---------------------------------------------------------------------------

@app.route("/api/inventory")
def inventory():
    with db_session() as conn:
        rows = conn.execute("""
            SELECT b.*, p.name as product_name, p.category, p.shelf_life_days,
                   w.name as warehouse_name, w.region,
                   s.name as supplier_name,
                   CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) as days_left
            FROM inventory_batches b
            JOIN products p ON p.id = b.product_id
            JOIN warehouses w ON w.id = b.warehouse_id
            JOIN suppliers s ON s.id = b.supplier_id
            WHERE b.status = 'IN_STOCK'
            ORDER BY days_left ASC
        """).fetchall()
        return jsonify(rows_to_list(rows))


@app.route("/api/procurement")
def procurement():
    with db_session() as conn:
        rows = conn.execute("""
            SELECT po.*, p.name as product_name, s.name as supplier_name, w.name as warehouse_name
            FROM procurement_orders po
            JOIN products p ON p.id = po.product_id
            JOIN suppliers s ON s.id = po.supplier_id
            JOIN warehouses w ON w.id = po.warehouse_id
            ORDER BY po.order_date DESC
        """).fetchall()
        return jsonify(rows_to_list(rows))


@app.route("/api/risks")
def risks():
    with db_session() as conn:
        rows = conn.execute("""
            SELECT r.*, p.name as product_name, s.name as supplier_name
            FROM supply_risks r
            LEFT JOIN products p ON p.id = r.product_id
            LEFT JOIN suppliers s ON s.id = r.supplier_id
            ORDER BY r.detected_at DESC
        """).fetchall()
        return jsonify(rows_to_list(rows))


@app.route("/api/logistics")
def logistics():
    with db_session() as conn:
        rows = conn.execute("""
            SELECT lo.*, b.batch_code, p.name as product_name, w.name as origin_warehouse
            FROM logistics_operations lo
            JOIN inventory_batches b ON b.id = lo.batch_id
            JOIN products p ON p.id = b.product_id
            JOIN warehouses w ON w.id = lo.origin_warehouse_id
            ORDER BY lo.id DESC LIMIT 100
        """).fetchall()
        return jsonify(rows_to_list(rows))


@app.route("/api/cold-chain")
def cold_chain():
    with db_session() as conn:
        rows = conn.execute("""
            SELECT c.*, w.name as warehouse_name
            FROM cold_chain_observations c JOIN warehouses w ON w.id = c.warehouse_id
            ORDER BY c.recorded_at DESC LIMIT 60
        """).fetchall()
        return jsonify(rows_to_list(rows))


@app.route("/api/waste-ledger")
def waste_ledger():
    with db_session() as conn:
        rows = conn.execute("""
            SELECT wl.*, p.name as product_name, c.trigger_description, c.scenario_type
            FROM waste_ledger wl
            JOIN products p ON p.id = wl.product_id
            JOIN cascades c ON c.id = wl.cascade_id
            ORDER BY wl.id DESC
        """).fetchall()
        totals = conn.execute("""
            SELECT COALESCE(SUM(waste_avoided_kg),0) kg, COALESCE(SUM(value_preserved_inr),0) inr,
                   COALESCE(SUM(baseline_waste_kg),0) baseline, COALESCE(SUM(harvex_waste_kg),0) harvex
            FROM waste_ledger
        """).fetchone()
        return jsonify({"entries": rows_to_list(rows), "totals": row_to_dict(totals),
                         "label": "Prototype simulation / estimated impact"})


# ---------------------------------------------------------------------------
# Agent activity / cascades / cascade trace
# ---------------------------------------------------------------------------

@app.route("/api/agents/activity")
def agent_activity():
    with db_session() as conn:
        rows = conn.execute("""
            SELECT ad.*, c.scenario_type, c.trigger_description
            FROM agent_decisions ad JOIN cascades c ON c.id = ad.cascade_id
            ORDER BY ad.id DESC LIMIT 40
        """).fetchall()
        out = []
        for r in rows:
            d = row_to_dict(r)
            d["decision"] = json.loads(d.pop("decision_json"))
            out.append(d)
        return jsonify(out)


@app.route("/api/cascades")
def cascades():
    with db_session() as conn:
        rows = conn.execute("SELECT * FROM cascades ORDER BY id DESC LIMIT 30").fetchall()
        return jsonify(rows_to_list(rows))


@app.route("/api/cascades/<int:cascade_id>/trace")
def cascade_trace(cascade_id):
    with db_session() as conn:
        cascade = conn.execute("SELECT * FROM cascades WHERE id=?", (cascade_id,)).fetchone()
        if not cascade:
            return jsonify({"error": "cascade not found"}), 404

        events_rows = conn.execute(
            "SELECT * FROM events WHERE cascade_id=? ORDER BY step_order ASC", (cascade_id,)
        ).fetchall()
        events_by_id = {r["id"]: row_to_dict(r) for r in events_rows}
        for e in events_by_id.values():
            e["payload"] = json.loads(e.pop("payload_json"))

        decisions_rows = conn.execute(
            "SELECT * FROM agent_decisions WHERE cascade_id=? ORDER BY step_order ASC", (cascade_id,)
        ).fetchall()

        actions_rows = conn.execute(
            "SELECT * FROM actions WHERE cascade_id=? ORDER BY id ASC", (cascade_id,)
        ).fetchall()
        actions_by_decision = {}
        for a in actions_rows:
            ad = row_to_dict(a)
            ad["payload"] = json.loads(ad.pop("payload_json"))
            actions_by_decision.setdefault(ad["decision_id"], []).append(ad)

        steps = []
        for d in decisions_rows:
            dd = row_to_dict(d)
            decision_json = json.loads(dd.pop("decision_json"))
            downstream_ids = decision_json.pop("_downstream_event_ids", [])
            llm_mode = decision_json.pop("_llm_mode", "simulation")
            trigger_event = events_by_id.get(dd["event_id"], {})
            downstream_events = [events_by_id[i] for i in downstream_ids if i in events_by_id]

            steps.append({
                "step_order": dd["step_order"],
                "agent": dd["agent_name"],
                "trigger_event": {
                    "type": trigger_event.get("event_type"),
                    "payload": trigger_event.get("payload"),
                },
                "decision": decision_json,
                "reasoning": dd["reasoning"],
                "confidence": dd["confidence"],
                "llm_mode": llm_mode,
                "downstream_events": [{"type": e["event_type"], "payload": e["payload"]} for e in downstream_events],
                "actions": actions_by_decision.get(dd["id"], []),
                "created_at": dd["created_at"],
            })

        return jsonify({
            "cascade": row_to_dict(cascade),
            "steps": steps,
        })


# ---------------------------------------------------------------------------
# Scenario simulator
# ---------------------------------------------------------------------------

SCENARIOS = {
    "demand_shock": {
        "label": "Demand Shock",
        "description": "Alphonso Mango demand falls 27% in Pune",
        "run": lambda conn: ripple_engine.trigger_demand_shock(conn, product_id=1, region="Pune", change_pct=-27, scenario_label="DEMAND_SHOCK"),
    },
    "supplier_shortfall": {
        "label": "Supplier Shortfall",
        "description": "Nashik Valley Growers projects a 35% shortfall on Tomato",
        "run": lambda conn: ripple_engine.trigger_supply_risk(conn, product_id=3, supplier_id=3, shortfall_pct=35),
    },
    "shelf_life_crisis": {
        "label": "Shelf-Life Crisis",
        "description": "Routine scan flags critical shelf-life exposure on Green Grapes",
        "run": lambda conn: ripple_engine.trigger_shelf_life_crisis(conn, product_id=6),
    },
    "cold_chain_breach": {
        "label": "Cold-Chain Breach",
        "description": "Temperature excursion detected at Nashik Cold Hub",
        "run": lambda conn: ripple_engine.trigger_cold_chain_breach(conn, warehouse_id=1, excursion_c=5.0),
    },
    "demand_spike": {
        "label": "Demand Spike",
        "description": "Papaya demand spikes 32% in Delhi-NCR against limited inventory",
        "run": lambda conn: ripple_engine.trigger_demand_shock(conn, product_id=8, region="Delhi-NCR", change_pct=32, scenario_label="DEMAND_SPIKE"),
    },
    "markdown_cannibalization": {
        "label": "Markdown Cannibalization",
        "description": "Banana demand softens 14% — markdown considered against nearby fruit substitutes",
        "run": lambda conn: ripple_engine.trigger_demand_shock(conn, product_id=2, region="Bengaluru", change_pct=-14, scenario_label="MARKDOWN_REVIEW"),
    },
}


@app.route("/api/scenarios")
def list_scenarios():
    return jsonify([{"id": k, "label": v["label"], "description": v["description"]} for k, v in SCENARIOS.items()])


@app.route("/api/scenarios/trigger", methods=["POST"])
def trigger_scenario():
    body = request.get_json(force=True, silent=True) or {}
    scenario_id = body.get("scenario_id")
    if scenario_id not in SCENARIOS:
        return jsonify({"error": f"unknown scenario_id '{scenario_id}'"}), 400
    with db_session() as conn:
        cascade_id = SCENARIOS[scenario_id]["run"](conn)
    return jsonify({"cascade_id": cascade_id})


# ---------------------------------------------------------------------------
# Human-in-the-loop action approval
# ---------------------------------------------------------------------------

@app.route("/api/actions")
def list_actions():
    status = request.args.get("status")
    with db_session() as conn:
        if status:
            rows = conn.execute(
                "SELECT a.*, c.trigger_description FROM actions a JOIN cascades c ON c.id=a.cascade_id "
                "WHERE a.status=? ORDER BY a.id DESC", (status,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT a.*, c.trigger_description FROM actions a JOIN cascades c ON c.id=a.cascade_id ORDER BY a.id DESC LIMIT 50"
            ).fetchall()
        out = []
        for r in rows:
            d = row_to_dict(r)
            d["payload"] = json.loads(d.pop("payload_json"))
            out.append(d)
        return jsonify(out)


@app.route("/api/actions/<int:action_id>/approve", methods=["POST"])
def approve_action(action_id):
    with db_session() as conn:
        conn.execute("UPDATE actions SET status='APPROVED', decided_at=? WHERE id=?", (datetime.utcnow().isoformat(), action_id))
        return jsonify({"ok": True})


@app.route("/api/actions/<int:action_id>/reject", methods=["POST"])
def reject_action(action_id):
    with db_session() as conn:
        conn.execute("UPDATE actions SET status='REJECTED', decided_at=? WHERE id=?", (datetime.utcnow().isoformat(), action_id))
        return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------

@app.route("/api/admin/reset", methods=["POST"])
def admin_reset():
    seed_data.seed(reset=True)
    return jsonify({"ok": True})


if __name__ == "__main__":
    if not os.path.exists(os.path.join(os.path.dirname(__file__), "harvex.db")):
        print("No database found — seeding synthetic HARVEX dataset...")
        seed_data.seed(reset=True)
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG", "0") == "1")
