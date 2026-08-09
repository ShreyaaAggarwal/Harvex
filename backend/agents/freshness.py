"""
HARVEX — Freshness Budget Engine  ⭐ Feature 2 / Feature 9
--------------------------------------------------------------
Shared, reusable module (not an Agent — a deterministic calculation
service several agents and API endpoints call into) that treats
remaining shelf life as an operational BUDGET rather than a single
countdown number.

Grounding rules (see product spec, "do not fabricate data"):
  - starting_budget_days, harvest_age_days and calendar_days_remaining
    are computed directly from real columns (products.shelf_life_days,
    inventory_batches.harvest_date / expiry_date) — nothing here is
    invented.
  - Everything beyond the calendar countdown (grade, quality-observation
    defect rate, cold-chain breach exposure) is a labelled ESTIMATED
    adjustment: the *inputs* are real rows from quality_observations /
    cold_chain_observations, but the day-value each is worth is an
    illustrative coefficient, not a measured spoilage model. Every
    driver line says which it is.

Used by:
  - /api/batches/<id>/freshness-budget and /api/priority-queue (app.py)
  - Logistics Coordination Agent, for freshness-aware routing (Feature 3)
  - Intervention Optimizer (Feature 4)
  - Command Assistant (Feature 7)
"""

from datetime import datetime, date

GRADE_DELTA_DAYS = {"A": 0.0, "B": -0.3, "C": -0.7}
BREACH_DELTA_PER_EVENT = -0.4
BREACH_DELTA_CAP = -1.2
NO_COLD_CHAIN_DELTA = -0.5
CLEAN_COLD_CHAIN_BONUS = 0.1
DEFECT_HIGH_THRESHOLD = 8.0
DEFECT_MED_THRESHOLD = 4.0
DEFECT_HIGH_DELTA = -0.3
DEFECT_MED_DELTA = -0.15

CRITICAL_HOURS_THRESHOLD = 24  # below this, "critical spoilage risk" window
RISK_TIMELINE_OFFSETS_HOURS = [0, 6, 12, 24]


def _parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def classify_risk_from_hours(hours):
    if hours <= 0:
        return "CRITICAL"
    if hours <= CRITICAL_HOURS_THRESHOLD:
        return "HIGH"
    if hours <= 72:
        return "MODERATE"
    return "LOW"


def classify_priority_from_days(effective_days):
    """Feature 8 — Operational Priority Queue buckets."""
    if effective_days <= 1:
        return "MOVE_NOW"
    if effective_days <= 3:
        return "SELL_FIRST"
    if effective_days <= 7:
        return "MONITOR"
    return "SAFE"


def risk_timeline(effective_hours_remaining):
    """Feature 9 — how risk evolves over the next 24h, purely a function
    of the already-computed effective hours remaining (deterministic,
    no extra query)."""
    timeline = []
    for offset in RISK_TIMELINE_OFFSETS_HOURS:
        remaining_at_offset = effective_hours_remaining - offset
        timeline.append({
            "at_hours": offset,
            "label": "NOW" if offset == 0 else f"+{offset}H",
            "hours_remaining": round(max(0, remaining_at_offset), 1),
            "risk_level": classify_risk_from_hours(remaining_at_offset),
        })
    return timeline


def _bulk_inputs(conn, batch_ids=None):
    """One round-trip each for batches / recent breach counts / worst
    defect per batch — bounded, indexed, backend-aggregated (Scalability)."""
    q = (
        "SELECT b.*, p.name as product_name, p.shelf_life_days, "
        "w.name as warehouse_name, w.id as warehouse_id, w.region as warehouse_region, "
        "w.cold_chain_enabled "
        "FROM inventory_batches b "
        "JOIN products p ON p.id = b.product_id "
        "JOIN warehouses w ON w.id = b.warehouse_id "
        "WHERE b.status='IN_STOCK'"
    )
    args = []
    if batch_ids:
        q += " AND b.id IN ({})".format(",".join("?" * len(batch_ids)))
        args = list(batch_ids)
    batches = conn.execute(q, args).fetchall()

    breach_rows = conn.execute(
        "SELECT warehouse_id, COUNT(*) c FROM cold_chain_observations "
        "WHERE is_breach=1 AND recorded_at >= datetime('now','-3 day') GROUP BY warehouse_id"
    ).fetchall()
    breach_counts = {r["warehouse_id"]: r["c"] for r in breach_rows}

    defect_rows = conn.execute(
        "SELECT batch_id, MAX(defect_pct) defect_pct FROM quality_observations GROUP BY batch_id"
    ).fetchall()
    defect_by_batch = {r["batch_id"]: r["defect_pct"] for r in defect_rows}

    return batches, breach_counts, defect_by_batch


def _compute_one(b, breach_counts, defect_by_batch):
    today = date.today()
    harvest = _parse_date(b["harvest_date"])
    expiry = _parse_date(b["expiry_date"])

    harvest_age_days = max(0, (today - harvest).days)
    calendar_days_remaining = max(0, (expiry - today).days)
    starting_budget_days = b["shelf_life_days"]

    drivers = [
        {"label": "Starting shelf-life budget", "delta_days": round(starting_budget_days, 2), "basis": "real"},
        {"label": "Harvest age", "delta_days": -round(min(harvest_age_days, starting_budget_days), 2), "basis": "real"},
    ]

    adjustment = 0.0
    grade = b["quality_grade"]
    grade_delta = GRADE_DELTA_DAYS.get(grade, -0.2)
    if grade_delta != 0:
        drivers.append({"label": f"Quality grade {grade}", "delta_days": grade_delta, "basis": "estimated"})
        adjustment += grade_delta

    defect_pct = defect_by_batch.get(b["id"])
    if defect_pct is not None:
        if defect_pct >= DEFECT_HIGH_THRESHOLD:
            drivers.append({"label": f"Defect rate {defect_pct:.1f}% (high)", "delta_days": DEFECT_HIGH_DELTA, "basis": "estimated"})
            adjustment += DEFECT_HIGH_DELTA
        elif defect_pct >= DEFECT_MED_THRESHOLD:
            drivers.append({"label": f"Defect rate {defect_pct:.1f}% (moderate)", "delta_days": DEFECT_MED_DELTA, "basis": "estimated"})
            adjustment += DEFECT_MED_DELTA

    breach_n = breach_counts.get(b["warehouse_id"], 0)
    if breach_n > 0:
        delta = max(BREACH_DELTA_CAP, breach_n * BREACH_DELTA_PER_EVENT)
        drivers.append({"label": f"Cold-chain breaches ({breach_n} in 72h)", "delta_days": round(delta, 2), "basis": "estimated"})
        adjustment += delta
    elif not b["cold_chain_enabled"]:
        drivers.append({"label": "No cold-chain coverage at this warehouse", "delta_days": NO_COLD_CHAIN_DELTA, "basis": "estimated"})
        adjustment += NO_COLD_CHAIN_DELTA
    else:
        drivers.append({"label": "Clean cold-chain record", "delta_days": CLEAN_COLD_CHAIN_BONUS, "basis": "estimated"})
        adjustment += CLEAN_COLD_CHAIN_BONUS

    effective_days_remaining = max(0.0, round(calendar_days_remaining + adjustment, 2))
    effective_hours_remaining = round(effective_days_remaining * 24, 1)
    hours_until_critical = round(max(0.0, effective_hours_remaining - CRITICAL_HOURS_THRESHOLD), 1)

    return {
        "batch_id": b["id"],
        "batch_code": b["batch_code"],
        "product": b["product_name"],
        "warehouse": b["warehouse_name"],
        "warehouse_id": b["warehouse_id"],
        "warehouse_region": b["warehouse_region"],
        "quantity_kg": b["quantity_kg"],
        "quality_grade": grade,
        "starting_budget_days": starting_budget_days,
        "harvest_age_days": harvest_age_days,
        "calendar_days_remaining": calendar_days_remaining,
        "drivers": drivers,
        "effective_days_remaining": effective_days_remaining,
        "effective_hours_remaining": effective_hours_remaining,
        "hours_until_critical": hours_until_critical,
        "risk_level": classify_risk_from_hours(effective_hours_remaining),
        "priority": classify_priority_from_days(effective_days_remaining),
        "risk_timeline": risk_timeline(effective_hours_remaining),
        "note": (
            "Calendar days remaining is computed directly from this batch's harvest and expiry dates. "
            "Grade, quality-observation and cold-chain-exposure adjustments are an illustrative estimation "
            "model layered on top of real observation data — not a measured spoilage science model."
        ),
    }


def compute_freshness_for_batches(conn, batch_ids=None):
    batches, breach_counts, defect_by_batch = _bulk_inputs(conn, batch_ids)
    return [_compute_one(b, breach_counts, defect_by_batch) for b in batches]


def compute_freshness_budget(conn, batch_id):
    results = compute_freshness_for_batches(conn, batch_ids=[batch_id])
    return results[0] if results else None