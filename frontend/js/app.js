/* =========================================================================
   HARVEX — Frontend application
   Vanilla JS, no build step. Talks to the Flask API on the same origin.
   ========================================================================= */

const API = "https://harvex-backend-ftnn.onrender.com/api";

const state = {
  view: "overview",
  scenarios: [],
  cascades: [],
  currentTraceCascadeId: null,
  pendingCount: 0,
};

// ---------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtKg(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 }) + " kg";
}
function fmtNum(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}
function fmtINR(n) {
  if (n === null || n === undefined) return "—";
  return "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}
function fmtPct(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toFixed(1) + "%";
}
function timeAgo(iso) {
  if (!iso) return "—";
  const then = new Date(iso.includes("Z") || iso.includes("+") ? iso : iso + "Z");
  const diffMs = Date.now() - then.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

async function api(path, opts) {
  const res = await fetch(API + path, Object.assign({
    headers: { "Content-Type": "application/json" },
  }, opts || {}));
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2800);
}

// ---------------------------------------------------------------------
// Nav / view switching
// ---------------------------------------------------------------------

const VIEW_TITLES = {
  overview: ["Operations Overview", "Live state of the fresh-produce network"],
  ripple: ["Ripple Console", "Trigger events and watch autonomous cascades unfold"],
  inventory: ["Inventory", "Batches across all warehouses, ranked by shelf-life urgency"],
  procurement: ["Procurement & Risk", "Open commitments and active supply risk"],
  logistics: ["Logistics", "Movement priority derived from remaining economic value"],
  waste: ["Waste Ledger", "Estimated waste avoided and value preserved"],
  agents: ["Agent Activity", "Every agent decision, across every cascade"],
};

function setView(view) {
  state.view = view;
  $all(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $all(".view").forEach(v => v.classList.remove("active"));
  $("#view-" + view).classList.add("active");
  const [title, sub] = VIEW_TITLES[view];
  $("#viewTitle").textContent = title;
  $("#viewSubtitle").textContent = sub;
  loadView(view);
}

function loadView(view) {
  if (view === "overview") return loadOverview();
  if (view === "ripple") return loadRippleConsole();
  if (view === "inventory") return loadInventory();
  if (view === "procurement") return loadProcurement();
  if (view === "logistics") return loadLogistics();
  if (view === "waste") return loadWaste();
  if (view === "agents") return loadAgents();
}

// ---------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------

async function loadOverview() {
  const [ov] = await Promise.all([api("/overview")]);

  $("#kpiRow").innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">On-Hand Inventory</div>
      <div class="kpi-value">${fmtNum(ov.total_stock_kg)}<span style="font-size:14px;color:var(--charcoal-45)"> kg</span></div>
      <div class="kpi-sub">${ov.batch_count} active batches</div>
    </div>
    <div class="kpi-card accent-terracotta">
      <div class="kpi-label">Expiring ≤ 3 Days</div>
      <div class="kpi-value">${fmtNum(ov.expiring_soon_kg)}<span style="font-size:14px;color:var(--charcoal-45)"> kg</span></div>
      <div class="kpi-sub">${ov.expiring_soon_batches} batches at risk</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Ripple Cascades Run</div>
      <div class="kpi-value">${ov.total_cascades}</div>
      <div class="kpi-sub">${ov.active_cascades} in progress</div>
    </div>
    <div class="kpi-card accent-terracotta">
      <div class="kpi-label">Pending Approvals</div>
      <div class="kpi-value">${ov.pending_actions}</div>
      <div class="kpi-sub">${ov.open_supply_risks} open supply risks</div>
    </div>
  `;

  $("#recentCascades").innerHTML = ov.recent_cascades.length ? ov.recent_cascades.map(c => cascadeRowHtml(c)).join("") :
    `<div class="empty-state"><p>No cascades yet. Head to the Ripple Console and trigger a scenario.</p></div>`;
  $all("#recentCascades .cascade-row").forEach(row => {
    row.addEventListener("click", () => openCascade(Number(row.dataset.id)));
  });

  $("#overviewImpact").innerHTML = `
    <div class="impact-stat"><span class="impact-stat-label">Estimated waste avoided</span><span class="impact-stat-value">${fmtKg(ov.waste_avoided_kg_total)}</span></div>
    <div class="impact-stat"><span class="impact-stat-label">Estimated value preserved</span><span class="impact-stat-value">${fmtINR(ov.value_preserved_inr_total)}</span></div>
    <div class="impact-stat"><span class="impact-stat-label">Avg. shelf-life utilization</span><span class="impact-stat-value">${fmtPct(ov.avg_shelf_life_utilization_pct)}</span></div>
    <p style="font-size:11.3px;color:var(--charcoal-45);margin-top:2px;">${ov.impact_label} — derived from synthetic seed data.</p>
  `;

  const whs = await api("/warehouses");
  $("#warehouseGrid").innerHTML = whs.map(w => {
    const pct = Math.min(100, Math.round((w.current_stock_kg / w.capacity_kg) * 100));
    return `<div class="wh-card">
      <div class="wh-name">${escapeHtml(w.name)}</div>
      <div class="wh-region">${escapeHtml(w.region)} ${w.cold_chain_enabled ? "· ❄ cold-chain" : ""}</div>
      <div class="wh-fill-track"><div class="wh-fill" style="width:${pct}%"></div></div>
      <div class="wh-stat">${fmtNum(w.current_stock_kg)} / ${fmtNum(w.capacity_kg)} kg · ${w.batch_count} batches</div>
    </div>`;
  }).join("");
}

function cascadeRowHtml(c) {
  const badgeClass = c.status === "IN_PROGRESS" ? "badge-progress" : "badge-complete";
  return `<div class="cascade-row" data-id="${c.id}">
    <div class="cascade-row-main">
      <div class="cascade-row-title">${escapeHtml(c.trigger_description)}</div>
      <div class="cascade-row-meta">${escapeHtml(c.scenario_type)} · ${timeAgo(c.started_at)}</div>
    </div>
    <span class="badge ${badgeClass}">${c.status.replace("_"," ")}</span>
  </div>`;
}

// ---------------------------------------------------------------------
// Ripple console
// ---------------------------------------------------------------------

async function loadRippleConsole() {
  if (!state.scenarios.length) {
    state.scenarios = await api("/scenarios");
  }
  $("#scenarioButtons").innerHTML = state.scenarios.map(s => `
    <button class="scenario-btn" data-id="${s.id}">
      <span class="scenario-btn-title">⚡ ${escapeHtml(s.label)}</span>
      <span class="scenario-btn-desc">${escapeHtml(s.description)}</span>
    </button>
  `).join("");
  $all(".scenario-btn").forEach(btn => btn.addEventListener("click", () => runScenario(btn.dataset.id)));

  await refreshCascadeHistory();

  if (state.currentTraceCascadeId) {
    openCascade(state.currentTraceCascadeId, true);
  } else if (state.cascades.length) {
    openCascade(state.cascades[0].id, true);
  }
}

async function refreshCascadeHistory() {
  state.cascades = await api("/cascades");
  $("#cascadeHistory").innerHTML = state.cascades.length ? state.cascades.map(c => cascadeRowHtml(c)).join("") :
    `<div class="empty-state"><p>No cascades yet.</p></div>`;
  $all("#cascadeHistory .cascade-row").forEach(row => {
    row.addEventListener("click", () => openCascade(Number(row.dataset.id)));
  });
}

async function runScenario(scenarioId) {
  $all(".scenario-btn").forEach(b => b.disabled = true);
  toast("Injecting event — Ripple Engine reacting…");
  try {
    const res = await api("/scenarios/trigger", { method: "POST", body: JSON.stringify({ scenario_id: scenarioId }) });
    await refreshCascadeHistory();
    await openCascade(res.cascade_id, true);
    refreshApprovalCount();
    toast("Cascade complete — trace ready below");
  } catch (e) {
    toast("Error: " + e.message);
  } finally {
    $all(".scenario-btn").forEach(b => b.disabled = false);
  }
}

async function openCascade(cascadeId, skipViewSwitch) {
  state.currentTraceCascadeId = cascadeId;
  if (!skipViewSwitch && state.view !== "ripple") setView("ripple");

  const data = await api(`/cascades/${cascadeId}/trace`);
  const c = data.cascade;
  $("#traceTitle").textContent = "Cascade #" + c.id + " — " + c.trigger_description;
  const statusTag = $("#traceStatusTag");
  statusTag.textContent = c.status.replace("_", " ");
  statusTag.className = "tag " + (c.status === "IN_PROGRESS" ? "tag-warn" : "tag-success");

  $("#traceMeta").innerHTML = `
    <span>Scenario <b>${escapeHtml(c.scenario_type)}</b></span>
    <span>Started <b>${timeAgo(c.started_at)}</b></span>
    <span>Steps <b>${data.steps.length}</b></span>
  `;

  renderTrace(data.steps);
}

// ---- decision fact formatters, keyed by decision.event ----
const DECISION_FACTS = {
  DEMAND_SHOCK: d => [["Product", d.product], ["Region", d.region], ["Direction", d.direction], ["Change", fmtPct(d.change_pct)], ["Severity", d.severity]],
  SUPPLY_RISK_DETECTED: d => [["Product", d.product], ["Supplier", d.supplier], ["Shortfall", fmtPct(d.shortfall_pct)], ["Exposed", fmtKg(d.exposed_kg)], ["Severity", d.severity]],
  COLD_CHAIN_BREACH: d => [["Warehouse", d.warehouse], ["Observed", d.observed_temp_c + "°C"], ["Excursion", d.excursion_c + "°C"], ["Affected", fmtKg(d.affected_kg)], ["Severity", d.severity]],
  PROCUREMENT_ADJUSTED: d => [["Product", d.product], ["Action", d.recommended_action], ["Qty change", fmtKg(d.quantity_change_kg)], ["New target", fmtKg(d.new_target_kg)]],
  INVENTORY_EXPOSURE: d => [["Product", d.product], ["Exposure", d.exposure_type], ["On hand", fmtKg(d.total_on_hand_kg)], ["At risk", fmtKg(d.at_risk_kg)]],
  SHELF_LIFE_PRESSURE: d => [["Product", d.product], ["Exposure", d.exposure_type], ["At risk", fmtKg(d.at_risk_kg)], ["Batches", d.batches_at_risk]],
  SHELF_LIFE_ALLOCATED: d => [["Product", d.product], ["Batches allocated", (d.allocated_batches||[]).length], ["Total", fmtKg(d.total_allocated_kg)], ["Demand idx", d.demand_strength_index]],
  PRICING_RECOMMENDED: d => [["Product", d.product], ["Markdown", fmtPct(d.markdown_pct)], ["New price", fmtINR(d.new_price) + "/kg"], ["Move-now", fmtKg(d.move_now_kg)]],
  CANNIBALIZATION_FLAGGED: d => [["Product", d.product], ["Diversion risk", fmtPct(d.diversion_risk_pct)], ["Level", d.risk_level], ["Substitute", d.at_risk_substitute || "—"]],
  VENDOR_RENEGOTIATION_RECOMMENDED: d => [["Product", d.product], ["Supplier", d.supplier || "—"], ["Action", d.recommended_action], ["Qty adj.", fmtKg(d.quantity_adjustment_kg)]],
  LOGISTICS_PRIORITIZED: d => [["Product", d.product], ["Moves", (d.moves||[]).length], ["Urgent", d.urgent_moves]],
  ERP_ACTION_GENERATED: d => [["Task", d.task], ["Type", d.action_type]],
  WASTE_IMPACT_ESTIMATED: d => d.baseline_waste_kg !== undefined ? [["Baseline waste", fmtKg(d.baseline_waste_kg)], ["HARVEX waste", fmtKg(d.harvex_waste_kg)], ["Avoided", fmtKg(d.waste_avoided_kg)], ["Value preserved", fmtINR(d.value_preserved_inr)]] : [["Note", d.note || "—"]],
  FARMER_COMMITMENT_ADVISORY: d => d.recommended_stance ? [["Product", d.product], ["Trend", d.dominant_recent_trend], ["Stance", d.recommended_stance]] : [["Note", d.note || "—"]],
};

function decisionFacts(decision) {
  const fn = DECISION_FACTS[decision.event];
  const facts = fn ? fn(decision) : Object.entries(decision).filter(([k]) => !k.startsWith("_") && k !== "event").slice(0, 4);
  return facts.filter(([, v]) => v !== undefined && v !== null && v !== "");
}

function renderTrace(steps) {
  const container = $("#traceContainer");
  if (!steps.length) {
    container.innerHTML = `<div class="empty-state"><p>No steps recorded for this cascade.</p></div>`;
    return;
  }

  const html = steps.map((s, i) => {
    const facts = decisionFacts(s.decision);
    const factsHtml = facts.map(([label, val]) => `<span><b>${escapeHtml(String(val))}</b> ${escapeHtml(label)}</span>`).join("");

    const actionsHtml = (s.actions || []).map(a => {
      const cls = a.requires_approval ? "needs-approval" : "auto";
      const label = a.action_type.replace(/_/g, " ").toLowerCase();
      const statusLabel = a.status === "PENDING" ? "awaiting approval" : a.status === "AUTO_EXECUTED" ? "auto-executed" : a.status.toLowerCase();
      return `<span class="action-chip ${cls}">${a.requires_approval ? "⏸" : "✓"} ${escapeHtml(label)} — ${statusLabel}</span>`;
    }).join("");

    const downstreamHtml = (s.downstream_events || []).length
      ? `<div class="trace-downstream">→ triggers ${s.downstream_events.map(e => `<span class="downstream-chip">${escapeHtml(e.type)}</span>`).join("")}</div>`
      : "";

    const modeTag = s.llm_mode === "live" ? "" : ` <span class="tag tag-muted" style="margin-left:6px;">simulation mode</span>`;

    return `<div class="trace-step ${i === 0 ? "root" : ""}" style="animation-delay:${Math.min(i * 90, 900)}ms">
      <div class="trace-node">${s.step_order}</div>
      <div class="trace-card">
        <div class="trace-card-head">
          <span class="trace-agent"><span class="agent-dot"></span>${escapeHtml(s.agent)}</span>
          <span class="trace-event-type">${escapeHtml(s.trigger_event.type || "")}</span>
        </div>
        <div class="trace-reasoning">${escapeHtml(s.reasoning)}${modeTag}</div>
        <div class="trace-row">${factsHtml}</div>
        <div class="trace-row">
          <span>Confidence <b>${Math.round(s.confidence * 100)}%</b><span class="confidence-track"><span class="confidence-fill" style="width:${Math.round(s.confidence*100)}%"></span></span></span>
        </div>
        ${actionsHtml ? `<div class="trace-actions">${actionsHtml}</div>` : ""}
        ${downstreamHtml}
      </div>
    </div>`;
  }).join("");

  container.innerHTML = `<div class="trace-flow">${html}</div>`;
}

// ---------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------

async function loadInventory() {
  const rows = await api("/inventory");
  $("#inventoryCount").textContent = rows.length + " batches";
  $("#inventoryTable tbody").innerHTML = rows.map(b => {
    const pct = Math.max(4, Math.min(100, Math.round((b.days_left / b.shelf_life_days) * 100)));
    const barColor = b.days_left <= 1 ? "var(--danger)" : b.days_left <= 3 ? "var(--terracotta)" : "var(--olive-600)";
    return `<tr>
      <td class="mono">${escapeHtml(b.batch_code)}</td>
      <td>${escapeHtml(b.product_name)}</td>
      <td>${escapeHtml(b.warehouse_name)}</td>
      <td>${escapeHtml(b.region)}</td>
      <td class="num">${fmtNum(b.quantity_kg)}</td>
      <td><span class="badge badge-${b.quality_grade}">${b.quality_grade}</span></td>
      <td><span class="shelf-bar"><span class="shelf-bar-fill" style="width:${pct}%;background:${barColor}"></span></span><span class="num">${b.days_left}d</span></td>
      <td><span class="badge badge-monitor">${escapeHtml(b.status)}</span></td>
    </tr>`;
  }).join("");
}

// ---------------------------------------------------------------------
// Procurement & Risk
// ---------------------------------------------------------------------

async function loadProcurement() {
  const [orders, risks] = await Promise.all([api("/procurement"), api("/risks")]);
  $("#procurementTable tbody").innerHTML = orders.map(o => `<tr>
      <td>${escapeHtml(o.product_name)}</td>
      <td>${escapeHtml(o.supplier_name)}</td>
      <td>${escapeHtml(o.warehouse_name)}</td>
      <td class="num">${fmtNum(o.quantity_kg)}</td>
      <td class="num">${fmtINR(o.price_per_kg)}</td>
      <td class="mono">${escapeHtml(o.delivery_date)}</td>
      <td><span class="badge badge-monitor">${escapeHtml(o.status)}</span></td>
    </tr>`).join("");

  $("#riskList").innerHTML = risks.length ? risks.map(r => `
    <div class="risk-row">
      <div class="risk-main">
        <div class="risk-title">${escapeHtml(r.product_name || "—")} · ${escapeHtml(r.risk_type)}</div>
        <div class="risk-meta">${escapeHtml(r.supplier_name || "—")} · detected ${timeAgo(r.detected_at)}</div>
      </div>
      <span class="badge ${r.severity === "HIGH" ? "badge-urgent" : r.severity === "MEDIUM" ? "badge-window" : "badge-monitor"}">${escapeHtml(r.severity)}</span>
    </div>
  `).join("") : `<div class="empty-state"><p>No open supply risks.</p></div>`;
}

// ---------------------------------------------------------------------
// Logistics
// ---------------------------------------------------------------------

async function loadLogistics() {
  const rows = await api("/logistics");
  $("#logisticsTable tbody").innerHTML = rows.length ? rows.map(l => {
    const pClass = l.priority === "MOVE_NOW" ? "badge-urgent" : l.priority === "MARKDOWN_WINDOW" ? "badge-window" : "badge-monitor";
    return `<tr>
      <td class="mono">${escapeHtml(l.batch_code)}</td>
      <td>${escapeHtml(l.product_name)}</td>
      <td>${escapeHtml(l.origin_warehouse)}</td>
      <td>${escapeHtml(l.destination)}</td>
      <td><span class="badge ${pClass}">${escapeHtml(l.priority.replace("_"," "))}</span></td>
      <td><span class="badge badge-monitor">${escapeHtml(l.status)}</span></td>
      <td class="mono">${l.eta ? timeAgo(l.eta).replace("ago","out") : "—"}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="7"><div class="empty-state"><p>No logistics operations yet — run a scenario from the Ripple Console.</p></div></td></tr>`;
}

// ---------------------------------------------------------------------
// Waste ledger
// ---------------------------------------------------------------------

async function loadWaste() {
  const data = await api("/waste-ledger");
  const t = data.totals;
  $("#wasteKpiRow").innerHTML = `
    <div class="kpi-card accent-terracotta">
      <div class="kpi-label">Waste Avoided</div>
      <div class="kpi-value">${fmtNum(t.kg)}<span style="font-size:14px;color:var(--charcoal-45)"> kg</span></div>
      <div class="kpi-sub">baseline ${fmtNum(t.baseline)} kg → HARVEX ${fmtNum(t.harvex)} kg</div>
    </div>
    <div class="kpi-card accent-terracotta">
      <div class="kpi-label">Value Preserved</div>
      <div class="kpi-value">${fmtINR(t.inr)}</div>
      <div class="kpi-sub">estimated recoverable value</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Ledger Entries</div>
      <div class="kpi-value">${data.entries.length}</div>
      <div class="kpi-sub">one per cascade × product</div>
    </div>
  `;
  $("#wasteTable tbody").innerHTML = data.entries.length ? data.entries.map(e => `<tr>
      <td>${escapeHtml(e.product_name)}</td>
      <td>${escapeHtml(e.trigger_description)}</td>
      <td class="num">${fmtNum(e.baseline_waste_kg)}</td>
      <td class="num">${fmtNum(e.harvex_waste_kg)}</td>
      <td class="num" style="color:var(--success);font-weight:600;">${fmtNum(e.waste_avoided_kg)}</td>
      <td class="num">${fmtINR(e.value_preserved_inr)}</td>
      <td class="num">${fmtPct(e.shelf_life_utilization_pct)}</td>
    </tr>`).join("") : `<tr><td colspan="7"><div class="empty-state"><p>No impact recorded yet — run a scenario from the Ripple Console.</p></div></td></tr>`;
}

// ---------------------------------------------------------------------
// Agent activity
// ---------------------------------------------------------------------

async function loadAgents() {
  const rows = await api("/agents/activity");
  $("#agentFeed").innerHTML = rows.length ? rows.map(r => `
    <div class="agent-feed-row">
      <div class="agent-feed-time">${timeAgo(r.created_at)}</div>
      <div class="agent-feed-body">
        <div class="agent-feed-agent">${escapeHtml(r.agent_name)} <span class="tag tag-muted" style="margin-left:6px;">${escapeHtml(r.scenario_type)}</span></div>
        <div class="agent-feed-text">${escapeHtml(r.reasoning)}</div>
      </div>
    </div>
  `).join("") : `<div class="empty-state"><p>No agent activity yet.</p></div>`;
}

// ---------------------------------------------------------------------
// Approvals drawer
// ---------------------------------------------------------------------

async function refreshApprovalCount() {
  const rows = await api("/actions?status=PENDING");
  state.pendingCount = rows.length;
  $("#approvalCount").textContent = rows.length;
  return rows;
}

async function openApprovalDrawer() {
  const rows = await refreshApprovalCount();
  $("#approvalList").innerHTML = rows.length ? rows.map(a => `
    <div class="approval-card" data-id="${a.id}">
      <div class="approval-title">${escapeHtml(a.action_type.replace(/_/g," "))}</div>
      <div class="approval-meta">${escapeHtml(a.trigger_description || "")}</div>
      <div class="approval-meta">${escapeHtml(a.payload.task || a.payload.product || JSON.stringify(a.payload).slice(0,80))}</div>
      <div class="approval-actions">
        <button class="btn btn-primary btn-sm approve-btn">Approve</button>
        <button class="btn btn-ghost btn-sm reject-btn">Reject</button>
      </div>
    </div>
  `).join("") : `<div class="empty-state"><p>No actions awaiting approval.</p></div>`;

  $all(".approve-btn").forEach(b => b.addEventListener("click", (e) => decideAction(e, "approve")));
  $all(".reject-btn").forEach(b => b.addEventListener("click", (e) => decideAction(e, "reject")));

  $("#approvalDrawer").classList.add("open");
}

async function decideAction(e, decision) {
  const card = e.target.closest(".approval-card");
  const id = card.dataset.id;
  await api(`/actions/${id}/${decision}`, { method: "POST" });
  toast(decision === "approve" ? "Action approved" : "Action rejected");
  card.remove();
  refreshApprovalCount();
  if (state.view === "overview") loadOverview();
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

async function init() {
  $all(".nav-item").forEach(btn => btn.addEventListener("click", () => setView(btn.dataset.view)));
  $("#refreshBtn").addEventListener("click", () => loadView(state.view));
  $("#quickSimBtn").addEventListener("click", () => setView("ripple"));
  $("#approvalToggle").addEventListener("click", openApprovalDrawer);
  $("#closeDrawer").addEventListener("click", () => $("#approvalDrawer").classList.remove("open"));

  try {
    const meta = await api("/meta");
    const pill = $("#llmModePill");
    const text = $("#llmModeText");
    if (meta.llm_mode === "live") {
      text.textContent = "Live reasoning";
      pill.classList.add("tag-live");
    } else {
      text.textContent = "Simulation mode";
    }
  } catch (e) {
    $("#llmModeText").textContent = "Offline";
  }

  refreshApprovalCount();
  setView("overview");
}

document.addEventListener("DOMContentLoaded", init);
