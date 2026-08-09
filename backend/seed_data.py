"""
HARVEX — Seed Data Generator
------------------------------
Official HACKNITE datasets (Product Catalog, Inventory, Sales, Procurement,
Produce Images, Demand, Quality, Operational data) were not available during
development. This module generates realistic SYNTHETIC operational data so
the full product can be built, demoed and evaluated end to end.

Every row inserted here carries is_simulated = 1. Nothing in this file is a
real-world measurement. A thin adapter boundary (see data/adapters.py) is
where official datasets/APIs would be plugged in later — the rest of the
system (agents, Ripple Engine, API layer) reads only from the database and
does not care where the rows came from.
"""

import random
from datetime import datetime, timedelta
from database import get_conn, init_db

random.seed(42)

PRODUCTS = [
    ("Alphonso Mango", "Fruit", 6, 18.0, 145.0),
    ("Banana (Robusta)", "Fruit", 5, None, 42.0),
    ("Tomato (Hybrid)", "Vegetable", 8, None, 28.0),
    ("Onion (Nashik Red)", "Vegetable", 45, None, 22.0),
    ("Pomegranate", "Fruit", 20, 15.0, 110.0),
    ("Green Grapes", "Fruit", 10, 17.0, 95.0),
    ("Capsicum", "Vegetable", 9, None, 55.0),
    ("Papaya", "Fruit", 7, 12.0, 32.0),
    ("Cauliflower", "Vegetable", 6, None, 26.0),
    ("Spinach", "Leafy", 3, None, 18.0),
]

REGIONS = ["Nashik", "Pune", "Bengaluru", "Delhi-NCR", "Hyderabad", "Kolkata"]

SUPPLIER_NAMES = [
    "Godavari Agro Aggregators", "Deccan Farm Collective", "Nashik Valley Growers",
    "Krishna Delta Traders", "Malwa Produce Co-op", "Baramati AgriLink",
    "Vidarbha Harvest Partners", "Konkan Coastal Farms",
]

WAREHOUSE_TEMPLATES = [
    ("Nashik Cold Hub", "Nashik", 1),
    ("Pune Regional DC", "Pune", 1),
    ("Bengaluru Pack House", "Bengaluru", 1),
    ("Delhi-NCR Distribution Center", "Delhi-NCR", 1),
    ("Hyderabad Cold Store", "Hyderabad", 1),
    ("Kolkata Ambient Depot", "Kolkata", 0),
]


def _iso(d):
    return d.strftime("%Y-%m-%d")


def _now_minus(days):
    return datetime.utcnow() - timedelta(days=days)


def seed(reset=True):
    init_db(reset=reset)
    conn = get_conn()
    cur = conn.cursor()

    # ---------------- Products ----------------
    product_ids = []
    for name, category, shelf_life, brix, price in PRODUCTS:
        cur.execute(
            "INSERT INTO products (name, category, unit, shelf_life_days, brix_target, base_price_per_kg, is_simulated) "
            "VALUES (?,?,?,?,?,?,1)",
            (name, category, "kg", shelf_life, brix, price),
        )
        product_ids.append(cur.lastrowid)

    # ---------------- Suppliers ----------------
    supplier_ids = []
    for name in SUPPLIER_NAMES:
        region = random.choice(REGIONS)
        reliability = round(random.uniform(0.72, 0.97), 2)
        cur.execute(
            "INSERT INTO suppliers (name, region, reliability_score, is_simulated) VALUES (?,?,?,1)",
            (name, region, reliability),
        )
        supplier_ids.append(cur.lastrowid)

    # ---------------- Warehouses ----------------
    warehouse_ids = []
    for name, region, cold in WAREHOUSE_TEMPLATES:
        capacity = random.choice([80000, 120000, 160000, 200000])
        cur.execute(
            "INSERT INTO warehouses (name, region, capacity_kg, cold_chain_enabled, is_simulated) VALUES (?,?,?,?,1)",
            (name, region, capacity, cold),
        )
        warehouse_ids.append(cur.lastrowid)

    # ---------------- Inventory batches ----------------
    batch_ids_by_product = {pid: [] for pid in product_ids}
    batch_counter = 1000
    for pid, (name, category, shelf_life, brix, price) in zip(product_ids, PRODUCTS):
        for _ in range(random.randint(6, 10)):
            wh = random.choice(warehouse_ids)
            sup = random.choice(supplier_ids)
            harvest_age = random.randint(0, shelf_life - 1)
            harvest_date = _now_minus(harvest_age)
            expiry_date = harvest_date + timedelta(days=shelf_life)
            qty = round(random.uniform(800, 6000), 1)
            grade = random.choices(["A", "B", "C"], weights=[0.55, 0.35, 0.10])[0]
            batch_counter += 1
            batch_code = f"BATCH-{name[:3].upper()}-{batch_counter}"
            cur.execute(
                "INSERT INTO inventory_batches (product_id, warehouse_id, supplier_id, batch_code, quantity_kg, "
                "harvest_date, expiry_date, quality_grade, status, is_simulated) VALUES (?,?,?,?,?,?,?,?, 'IN_STOCK', 1)",
                (pid, wh, sup, batch_code, qty, _iso(harvest_date), _iso(expiry_date), grade),
            )
            batch_id = cur.lastrowid
            batch_ids_by_product[pid].append(batch_id)

            # one quality observation per batch
            cur.execute(
                "INSERT INTO quality_observations (batch_id, observed_at, defect_pct, firmness_score, brix, color_score, notes, is_simulated) "
                "VALUES (?,?,?,?,?,?,?,1)",
                (
                    batch_id,
                    _iso(datetime.utcnow()),
                    round(random.uniform(1, 14), 1),
                    round(random.uniform(0.55, 0.98), 2),
                    round(brix + random.uniform(-1.5, 1.5), 1) if brix else None,
                    round(random.uniform(0.6, 0.97), 2),
                    "Auto-logged simulated grading observation",
                ),
            )

    # ---------------- Sales history (60 days) ----------------
    for pid, (name, category, shelf_life, brix, price) in zip(product_ids, PRODUCTS):
        for day_offset in range(60, 0, -1):
            d = _now_minus(day_offset)
            # weekly seasonality + mild noise
            seasonality = 1 + 0.15 * random.uniform(-1, 1)
            base_qty = {"Fruit": 900, "Vegetable": 1400, "Leafy": 500}[category]
            qty = max(50, base_qty * seasonality * random.uniform(0.7, 1.3))
            price_noise = price * random.uniform(0.92, 1.08)
            cur.execute(
                "INSERT INTO sales (product_id, warehouse_id, sale_date, quantity_kg, price_per_kg, region, is_simulated) "
                "VALUES (?,?,?,?,?,?,1)",
                (pid, random.choice(warehouse_ids), _iso(d), round(qty, 1), round(price_noise, 2), random.choice(REGIONS)),
            )

    # ---------------- Demand signals (14 days, per product per region) ----------------
    for pid in product_ids:
        for day_offset in range(14, -1, -1):
            d = _now_minus(day_offset)
            for region in random.sample(REGIONS, 3):
                idx = round(random.uniform(55, 95), 1)
                trend = random.choices(["RISING", "STABLE", "FALLING"], weights=[0.25, 0.55, 0.20])[0]
                cur.execute(
                    "INSERT INTO demand_signals (product_id, region, signal_date, demand_index, trend, source, is_simulated) "
                    "VALUES (?,?,?,?,?,?,1)",
                    (pid, region, _iso(d), idx, trend, "simulated_pos_search_blend"),
                )

    # ---------------- Procurement orders (open commitments) ----------------
    for pid, (name, category, shelf_life, brix, price) in zip(product_ids, PRODUCTS):
        for _ in range(random.randint(2, 4)):
            sup = random.choice(supplier_ids)
            wh = random.choice(warehouse_ids)
            order_date = _now_minus(random.randint(0, 5))
            delivery_date = order_date + timedelta(days=random.randint(2, 7))
            qty = round(random.uniform(1000, 5000), 0)
            cur.execute(
                "INSERT INTO procurement_orders (product_id, supplier_id, warehouse_id, quantity_kg, price_per_kg, "
                "order_date, delivery_date, status, is_simulated) VALUES (?,?,?,?,?,?,?, 'CONFIRMED', 1)",
                (pid, sup, wh, qty, round(price * random.uniform(0.85, 1.0), 2), _iso(order_date), _iso(delivery_date)),
            )

    # ---------------- Cold chain observations ----------------
    for wh in warehouse_ids:
        cold_enabled = cur.execute("SELECT cold_chain_enabled FROM warehouses WHERE id=?", (wh,)).fetchone()[0]
        if not cold_enabled:
            continue
        for hour_offset in range(48, 0, -4):
            t = datetime.utcnow() - timedelta(hours=hour_offset)
            target = 4.0
            temp = target + random.uniform(-0.8, 0.8)
            cur.execute(
                "INSERT INTO cold_chain_observations (warehouse_id, recorded_at, temperature_c, target_temperature_c, humidity_pct, is_breach, is_simulated) "
                "VALUES (?,?,?,?,?,?,1)",
                (wh, t.isoformat(), round(temp, 1), target, round(random.uniform(85, 95), 1), 0),
            )

    conn.commit()
    conn.close()
    return {
        "products": len(product_ids),
        "suppliers": len(supplier_ids),
        "warehouses": len(warehouse_ids),
    }


if __name__ == "__main__":
    stats = seed()
    print("Seeded HARVEX synthetic dataset:", stats)
