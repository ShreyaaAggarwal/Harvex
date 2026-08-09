"""
HARVEX — Multi-Agent Command Assistant  ⭐ Feature 7
----------------------------------------------------------
NOT a general chatbot. Every question is first classified into one of a
bounded set of intents by keyword matching (deterministic, no LLM call
needed to decide WHAT to look up). Each intent handler runs real SQL /
reuses existing agent modules to gather grounded facts, then — and only
then — optionally calls llm_service.explain() to phrase those facts in
natural language. The LLM never invents facts and never picks the
underlying answer; if it's unavailable, the deterministic fallback text
(built from the same structured facts) is what the user sees.

For "what happens if" questions this invokes the REAL Ripple Engine
simulation (via ripple_engine) rather than returning a canned answer,
and is clearly labelled SIMULATION / WHAT-IF.
"""

import json
import re
from database import row_to_dict, rows_to_list
from engine.ripple_engine import ripple_engine
from agents import freshness

WAREHOUSE_KEYWORDS = {
    "nashik": 1, "pune": 2, "bengaluru": 3, "bangalore": 3,
    "delhi": 4, "ncr": 4, "hyderabad": 5, "kolkata": 6,
}


def _find_product_id(conn, text):
    text_l = text.lower()
    products = conn.execute("SELECT id, name FROM products").fetchall()
    for p in products:
        # match on any significant word in the product name (e.g. "banana", "mango")
        for word in re.findall(r"[a-zA-Z]+", p["name"].lower()):
            if len(word) >= 4 and word in text_l:
                return p["id"], p["name"]
    return None, None


def _find_warehouse_id(conn, text):
    text_l = text.lower()
    for kw, wid in WAREHOUSE_KEYWORDS.items():
        if kw in text_l:
            row = conn.execute("SELECT id, name FROM warehouses WHERE id=?", (wid,)).fetchone()
            if row:
                return row["id"], row["name"]
    return None, None


def _find_delay_hours(text):
    m = re.search(r"(\d+)\s*(?:h|hr|hrs|hour|hours)", text.lower())
    return int(m.group(1)) if m else 8


def _find_batch_code(conn, text):
    m = re.search(r"batch[- ]?([a-z0-9\-]+)", text.lower())
    if not m:
        return None
    row = conn.execute("SELECT id FROM inventory_batches WHERE lower(batch_code) LIKE ?", (f"%{m.group(1)}%",)).fetchone()
    return row["id"] if row else None


def classify_intent(text):
    t = text.lower()
    if any(k in t for k in ["what happens if", "what if", "delayed by", "breakdown", "rainfall", "disrupt"]):
        return "what_if"
    if t.strip().startswith("why") and "batch" in t:
        return "why_batch"
    if t.strip().startswith("why"):
        return "why_general"
    if "biggest" in t and ("waste" in t or "risk" in t):
        return "biggest_risk"
    if "which batch" in t or "move first" in t or "move now" in t:
        return "move_first"
    if "supplier" in t and ("renegotiat" in t or "which" in t):
        return "vendor_renegotiation"
    return "overview"


def _consult(conn, llm, system_prompt, decision, fallback, agents_consulted):
    text = llm.explain(system_prompt, decision, fallback)
    return {
        "answer": text["text"],
        "mode": text["mode"],
        "evidence": decision.get("evidence", []),
        "agents_consulted": agents_consulted,
        "data": decision,
    }


def _handle_what_if(conn, llm, text):
    warehouse_id, warehouse_name = _find_warehouse_id(conn, text)
    if warehouse_id is None:
        warehouse_id, warehouse_name = 1, "Nashik Cold Hub"
    delay_hours = _find_delay_hours(text)
    disruption_type = "HEAVY_RAINFALL" if "rain" in text.lower() else "TRUCK_BREAKDOWN"

    cascade_id = ripple_engine.trigger_logistics_delay(conn, warehouse_id, delay_hours, disruption_type)
    decisions = conn.execute(
        "SELECT agent_name, decision_json, reasoning FROM agent_decisions WHERE cascade_id=? ORDER BY step_order",
        (cascade_id,),
    ).fetchall()
    agents_consulted = sorted({d["agent_name"] for d in decisions})

    waste_step = None
    for d in decisions:
        dj = json.loads(d["decision_json"])
        if dj.get("event") == "WASTE_IMPACT_ESTIMATED" and "counterfactual" in dj:
            waste_step = dj
            break

    summary = {
        "event": "WHAT_IF_SIMULATION",
        "label": "SIMULATION / WHAT-IF — not a measured real-world result",
        "cascade_id": cascade_id,
        "disruption_type": disruption_type,
        "warehouse": warehouse_name,
        "delay_hours": delay_hours,
        "agents_triggered": agents_consulted,
        "counterfactual": waste_step.get("counterfactual") if waste_step else None,
        "evidence": [f"Simulated via cascade #{cascade_id}, {len(decisions)} agent step(s) triggered"],
    }
    fallback = (
        f"Simulating an {delay_hours}h {disruption_type.replace('_',' ').lower()} at {warehouse_name}: "
        f"{len(agents_consulted)} agent(s) reacted ({', '.join(agents_consulted)}). "
        + (f"Estimated waste avoided by HARVEX's response: {waste_step['waste_avoided_kg']:.0f} kg "
           f"(₹{waste_step['value_preserved_inr']:,.0f} preserved)." if waste_step else
           "No quantified waste outcome was produced for this run.")
        + " This is a simulation, not a measured result."
    )
    return _consult(
        conn, llm,
        "You are the HARVEX Command Assistant running a what-if simulation. Summarize the simulated cascade and its "
        "estimated impact in two or three sentences. Make clear this is a simulation.",
        summary, fallback, agents_consulted,
    )


def _handle_why_batch(conn, llm, text):
    batch_id = _find_batch_code(conn, text)
    if batch_id is None:
        product_id, product_name = _find_product_id(conn, text)
        if product_id:
            row = conn.execute(
                "SELECT id FROM inventory_batches WHERE product_id=? AND status='IN_STOCK' "
                "ORDER BY julianday(expiry_date) ASC LIMIT 1", (product_id,),
            ).fetchone()
            batch_id = row["id"] if row else None
    if batch_id is None:
        return _handle_overview(conn, llm, text)

    fb = freshness.compute_freshness_budget(conn, batch_id)
    if not fb:
        return _handle_overview(conn, llm, text)

    driver_lines = [f"{d['label']}: {d['delta_days']:+.2f}d ({d['basis']})" for d in fb["drivers"]]
    decision = {
        "event": "WHY_BATCH",
        "batch_code": fb["batch_code"],
        "product": fb["product"],
        "priority": fb["priority"],
        "effective_days_remaining": fb["effective_days_remaining"],
        "risk_level": fb["risk_level"],
        "evidence": driver_lines,
    }
    fallback = (
        f"{fb['batch_code']} ({fb['product']}) is classified {fb['priority']} with {fb['effective_days_remaining']:.1f} "
        f"effective days of shelf-life budget remaining ({fb['risk_level']} risk). Drivers: {'; '.join(driver_lines)}."
    )
    return _consult(
        conn, llm,
        "You are the HARVEX Command Assistant. Explain why this batch has its current priority classification, "
        "using only the freshness-budget drivers given, in two sentences.",
        decision, fallback, ["Shelf-Life Budget Allocator", "Warehouse Allocation Agent"],
    )


def _handle_why_general(conn, llm, text):
    """A 'why' question that isn't about a specific batch. If a product is
    named, pull the most recent decision that actually acted on it
    (procurement/pricing/logistics), grounded in agent_decisions — the
    real cascade log — rather than falling straight to a generic answer."""
    product_id, product_name = _find_product_id(conn, text)
    if product_id is None:
        return _handle_biggest_risk(conn, llm, text)

    row = conn.execute(
        "SELECT ad.agent_name, ad.decision_json, ad.reasoning, ad.cascade_id FROM agent_decisions ad "
        "WHERE ad.decision_json LIKE ? AND ad.agent_name IN "
        "('Procurement Planning Agent','Pricing Agent','Logistics Coordination Agent','Vendor Renegotiation Agent') "
        "ORDER BY ad.id DESC LIMIT 1",
        (f'%"product": "{product_name}"%',),
    ).fetchone()
    if not row:
        return _handle_biggest_risk(conn, llm, text)

    dj = json.loads(row["decision_json"])
    agents_in_cascade = [r["agent_name"] for r in conn.execute(
        "SELECT DISTINCT agent_name FROM agent_decisions WHERE cascade_id=?", (row["cascade_id"],)
    ).fetchall()]

    decision = {"event": "WHY_PRODUCT_DECISION", "product": product_name, "decided_by": row["agent_name"],
                "cascade_id": row["cascade_id"], "evidence": dj.get("evidence", [])}
    fallback = row["reasoning"]
    return _consult(
        conn, llm,
        f"You are the HARVEX Command Assistant. Restate why {row['agent_name']} made this decision about "
        f"{product_name}, grounded only in the evidence given, in one or two sentences.",
        decision, fallback, agents_in_cascade,
    )


def _handle_biggest_risk(conn, llm, text):
    rows = conn.execute(
        "SELECT b.*, p.name as product_name FROM inventory_batches b JOIN products p ON p.id=b.product_id "
        "WHERE b.status='IN_STOCK' ORDER BY julianday(b.expiry_date) ASC, b.quantity_kg DESC LIMIT 5"
    ).fetchall()
    batch_ids = [r["id"] for r in rows]
    fbs = freshness.compute_freshness_for_batches(conn, batch_ids) if batch_ids else []
    fbs.sort(key=lambda f: (f["effective_days_remaining"], -f["quantity_kg"]))
    top = fbs[:3]

    decision = {
        "event": "BIGGEST_WASTE_RISK",
        "top_batches": [{"batch_code": f["batch_code"], "product": f["product"], "quantity_kg": f["quantity_kg"],
                          "effective_days_remaining": f["effective_days_remaining"], "risk_level": f["risk_level"]} for f in top],
        "evidence": [f"{f['batch_code']} ({f['product']}): {f['quantity_kg']:.0f} kg, {f['effective_days_remaining']:.1f}d effective budget, {f['risk_level']} risk" for f in top],
    }
    fallback = (
        "Biggest current waste risk: " + "; ".join(decision["evidence"])
        if top else "No in-stock batches found to assess."
    )
    return _consult(
        conn, llm,
        "You are the HARVEX Command Assistant. Summarize the biggest current waste risk from the batches given, in two sentences.",
        decision, fallback, ["Shelf-Life Budget Allocator", "Warehouse Allocation Agent"],
    )


def _handle_move_first(conn, llm, text):
    rows = conn.execute(
        "SELECT b.*, p.name as product_name FROM inventory_batches b JOIN products p ON p.id=b.product_id "
        "WHERE b.status='IN_STOCK'"
    ).fetchall()
    batch_ids = [r["id"] for r in rows]
    fbs = freshness.compute_freshness_for_batches(conn, batch_ids) if batch_ids else []
    move_now = sorted([f for f in fbs if f["priority"] == "MOVE_NOW"], key=lambda f: f["effective_days_remaining"])[:5]

    decision = {
        "event": "MOVE_FIRST",
        "move_now_batches": [{"batch_code": f["batch_code"], "product": f["product"], "quantity_kg": f["quantity_kg"]} for f in move_now],
        "evidence": [f"{f['batch_code']} ({f['product']}, {f['quantity_kg']:.0f} kg) — {f['effective_days_remaining']:.1f}d effective budget" for f in move_now],
    }
    fallback = (
        f"{len(move_now)} batch(es) are currently MOVE_NOW: " + "; ".join(decision["evidence"])
        if move_now else "No batches are currently classified MOVE_NOW."
    )
    return _consult(
        conn, llm,
        "You are the HARVEX Command Assistant. List which batches should move first and why, in two sentences.",
        decision, fallback, ["Shelf-Life Budget Allocator"],
    )


def _handle_vendor_renegotiation(conn, llm, text):
    row = conn.execute(
        "SELECT ad.decision_json, ad.reasoning, ad.created_at FROM agent_decisions ad "
        "WHERE ad.agent_name='Vendor Renegotiation Agent' ORDER BY ad.id DESC LIMIT 1"
    ).fetchone()
    if not row:
        decision = {"event": "VENDOR_RENEGOTIATION_LOOKUP", "evidence": []}
        fallback = "No vendor renegotiation recommendation has been recorded yet — run a scenario from the Ripple Console."
        return _consult(conn, llm, "You are the HARVEX Command Assistant.", decision, fallback, ["Vendor Renegotiation Agent"])

    dj = json.loads(row["decision_json"])
    decision = {"event": "VENDOR_RENEGOTIATION_LOOKUP", "supplier": dj.get("supplier"),
                "recommended_action": dj.get("recommended_action"), "evidence": dj.get("evidence", [])}
    fallback = row["reasoning"]
    return _consult(
        conn, llm,
        "You are the HARVEX Command Assistant. Restate the latest vendor renegotiation recommendation in one or two sentences.",
        decision, fallback, ["Vendor Renegotiation Agent"],
    )


def _handle_overview(conn, llm, text):
    total_stock = conn.execute("SELECT COALESCE(SUM(quantity_kg),0) v FROM inventory_batches WHERE status='IN_STOCK'").fetchone()["v"]
    expiring = conn.execute(
        "SELECT COUNT(*) c, COALESCE(SUM(quantity_kg),0) kg FROM inventory_batches "
        "WHERE status='IN_STOCK' AND julianday(expiry_date) - julianday('now') <= 3"
    ).fetchone()
    pending = conn.execute("SELECT COUNT(*) c FROM actions WHERE status='PENDING'").fetchone()["c"]
    decision = {
        "event": "OPERATIONS_OVERVIEW",
        "on_hand_kg": round(total_stock, 0),
        "expiring_soon_batches": expiring["c"],
        "expiring_soon_kg": round(expiring["kg"], 0),
        "pending_approvals": pending,
        "evidence": [
            f"{total_stock:,.0f} kg on hand across all warehouses",
            f"{expiring['c']} batch(es) / {expiring['kg']:,.0f} kg expiring within 3 days",
            f"{pending} action(s) awaiting approval",
        ],
    }
    fallback = (
        f"HARVEX is tracking {total_stock:,.0f} kg on hand, with {expiring['c']} batch(es) "
        f"({expiring['kg']:,.0f} kg) expiring within 3 days and {pending} action(s) awaiting approval. "
        f"Ask about a specific product, batch, or try a what-if scenario for more detail."
    )
    return _consult(
        conn, llm,
        "You are the HARVEX Command Assistant. Give a brief operations snapshot from the figures given, in one or two sentences.",
        decision, fallback, ["Warehouse Allocation Agent"],
    )


def answer(conn, llm, message):
    intent = classify_intent(message)
    handler = {
        "what_if": _handle_what_if,
        "why_batch": _handle_why_batch,
        "why_general": _handle_why_general,
        "biggest_risk": _handle_biggest_risk,
        "move_first": _handle_move_first,
        "vendor_renegotiation": _handle_vendor_renegotiation,
        "overview": _handle_overview,
    }.get(intent, _handle_overview)
    result = handler(conn, llm, message)
    result["intent"] = intent
    return result