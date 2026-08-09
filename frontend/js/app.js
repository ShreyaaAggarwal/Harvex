/* =========================================================================
   HARVEX — Frontend application
   Vanilla JS, no build step. Talks to the Flask API on the same origin.
   ========================================================================= */

function resolveApiBase() {
  if (typeof window !== "undefined" && window.HARVEX_API_BASE) {
    return window.HARVEX_API_BASE.replace(/\/$/, "") + "/api";
  }
  // Local dev / same-origin deployments (e.g. Flask serving the frontend
  // itself) should talk to their own origin instead of the hardcoded
  // production backend.
  if (typeof window !== "undefined" && window.location &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
    return window.location.origin + "/api";
  }
  return "https://harvex-backend-ftnn.onrender.com/api";
}

const API = resolveApiBase();
if (typeof window !== "undefined") window.HARVEX_RESOLVED_API = API; // for on-page debugging

const state = {
  view: "overview",
  scenarios: [],
  cascades: [],
  currentTraceCascadeId: null,
  pendingCount: 0,
  assistantHistory: [],
  inventoryIndex: null,
  activePqBatch: null,
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

/**
 * Core fetch wrapper. `retryOpts.retries` retries transient failures
 * (network errors, and 502/503/504 — the exact status codes a sleeping
 * Render free-tier instance returns while it wakes up) with backoff, so a
 * cold backend doesn't read as "broken" on the very first click of a
 * session. Errors are never swallowed — every failure surfaces the real
 * HTTP status and response body (or a clear network-failure message)
 * instead of a generic dead-end string.
 */
async function api(path, opts, retryOpts) {
  const retries = (retryOpts && retryOpts.retries) || 0;
  const retryDelayMs = (retryOpts && retryOpts.retryDelayMs) || 1500;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(API + path, Object.assign({
        headers: { "Content-Type": "application/json" },
      }, opts || {}));

      if (!res.ok) {
        let detail = "";
        try {
          const j = await res.json();
          detail = j.error || JSON.stringify(j);
        } catch (e) {
          try { detail = (await res.text()).slice(0, 220); } catch (e2) { /* no body */ }
        }
        const err = new Error(detail || `HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}`);
        err.status = res.status;
        // 502/503/504 are exactly what Render returns while a sleeping
        // free-tier service boots back up — worth retrying automatically.
        if (attempt < retries && [502, 503, 504].includes(res.status)) {
          lastErr = err;
          await new Promise(r => setTimeout(r, retryDelayMs));
          continue;
        }
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      const isNetworkFailure = !e.status; // fetch() itself rejected — DNS/CORS/offline/refused
      if (attempt < retries && isNetworkFailure) {
        await new Promise(r => setTimeout(r, retryDelayMs));
        continue;
      }
      break;
    }
  }

  if (!lastErr.status) {
    lastErr.message = `Can't reach the HARVEX backend at ${API} (${lastErr.message || "network error"}). ` +
      `It may be waking up from sleep (free-tier services do this) — try again in a few seconds, or ` +
      `confirm the backend is deployed and reachable from this origin.`;
  }
  throw lastErr;
}

// ---------------------------------------------------------------------
// Loading / error state helpers — shared by every view loader so a
// backend failure is always visible and always recoverable, never a
// silent blank panel.
// ---------------------------------------------------------------------

function loadingStateHtml(msg) {
  return `<div class="load-state"><div class="spinner"></div><p>${escapeHtml(msg || "Loading…")}</p></div>`;
}

function errorStateHtml(err, retryLabel) {
  const msg = (err && err.message) ? err.message : "Something went wrong.";
  return `<div class="error-state">
    <div class="error-state-icon">⚠</div>
    <p class="error-state-msg">${escapeHtml(msg)}</p>
    <button type="button" class="btn btn-ghost btn-sm error-retry-btn">${escapeHtml(retryLabel || "Retry")}</button>
  </div>`;
}

/** Wires the Retry button inside a just-rendered error state to re-run `loaderFn`. */
function wireRetry(container, loaderFn) {
  const btn = container.querySelector(".error-retry-btn");
  if (btn) btn.addEventListener("click", () => { loaderFn(); });
}

// table <tbody> elements can't directly contain a <div> per the HTML spec
// (browsers will silently relocate it), so table-backed views get their
// loading/error state wrapped in a colspan row instead.
function loadingRowHtml(colspan, msg) {
  return `<tr><td colspan="${colspan}">${loadingStateHtml(msg)}</td></tr>`;
}
function errorRowHtml(colspan, err, retryLabel) {
  return `<tr><td colspan="${colspan}">${errorStateHtml(err, retryLabel)}</td></tr>`;
}
async function withLoadStateRow(tbody, colspan, loadingMsg, loaderFn) {
  if (!tbody) { await loaderFn(); return; }
  tbody.innerHTML = loadingRowHtml(colspan, loadingMsg);
  try {
    await loaderFn();
  } catch (e) {
    tbody.innerHTML = errorRowHtml(colspan, e);
    wireRetry(tbody, () => withLoadStateRow(tbody, colspan, loadingMsg, loaderFn));
  }
}

/**
 * Runs `loaderFn` (which must render into `container` itself) with a
 * loading state shown first and an error+retry state shown on failure.
 * Every top-level view loader is wrapped in this so no fetch failure is
 * ever silent.
 */
async function withLoadState(container, loadingMsg, loaderFn) {
  if (!container) { await loaderFn(); return; }
  container.innerHTML = loadingStateHtml(loadingMsg);
  try {
    await loaderFn();
  } catch (e) {
    container.innerHTML = errorStateHtml(e);
    wireRetry(container, () => withLoadState(container, loadingMsg, loaderFn));
  }
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
  assistant: ["Command Assistant", "Ask HARVEX about products, batches, suppliers — or run a what-if"],
  priority: ["Priority Queue", "Every in-stock batch classified by real freshness-budget risk"],
  inventory: ["Inventory", "Batches across all warehouses, ranked by shelf-life urgency"],
  procurement: ["Procurement & Risk", "Open commitments and active supply risk"],
  logistics: ["Logistics", "Movement priority derived from remaining economic value"],
  coldchain: ["Cold-Chain", "Live warehouse temperature/humidity status and breach response"],
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
  if (view === "assistant") return loadAssistant();
  if (view === "priority") return loadPriorityQueue();
  if (view === "inventory") return loadInventory();
  if (view === "procurement") return loadProcurement();
  if (view === "logistics") return loadLogistics();
  if (view === "coldchain") return loadColdChain();
  if (view === "waste") return loadWaste();
  if (view === "agents") return loadAgents();
}

// ---------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------

async function loadOverview() {
  await withLoadState($("#kpiRow"), "Loading operations overview…", async () => {
    await loadOverviewInner();
  });
}

async function loadOverviewInner() {
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
  await withLoadState($("#scenarioButtons"), "Loading scenarios…", loadRippleConsoleInner);
}

async function loadRippleConsoleInner() {
  if (!state.scenarios.length) {
    state.scenarios = await api("/scenarios");
  }
  $("#scenarioButtons").innerHTML = state.scenarios.map(s => {
    const hasOwnIcon = /^\p{Extended_Pictographic}/u.test(s.label);
    return `<button class="scenario-btn" data-id="${s.id}">
      <span class="scenario-btn-title">${hasOwnIcon ? "" : "⚡ "}${escapeHtml(s.label)}</span>
      <span class="scenario-btn-desc">${escapeHtml(s.description)}</span>
    </button>`;
  }).join("");
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

  const container = $("#traceContainer");
  container.innerHTML = loadingStateHtml("Loading cascade trace…");
  try {
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

    renderTrace(data.steps, cascadeId);
  } catch (e) {
    container.innerHTML = errorStateHtml(e);
    wireRetry(container, () => openCascade(cascadeId, true));
  }
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
  LOGISTICS_DELAY: d => [["Warehouse", d.warehouse], ["Disruption", (d.disruption_type||"").replace(/_/g," ")], ["Delay", d.delay_hours + "h"], ["Affected", fmtKg(d.affected_kg)], ["Severity", d.severity]],
  INTERVENTION_RECOMMENDED: d => d.recommended_label ? [["Product", d.product], ["At risk", fmtKg(d.at_risk_kg)], ["Recommended", d.recommended_label], ["Options evaluated", (d.options||[]).length]] : [["Note", d.note || "—"]],
};

function decisionFacts(decision) {
  const fn = DECISION_FACTS[decision.event];
  const facts = fn ? fn(decision) : Object.entries(decision).filter(([k]) => !k.startsWith("_") && k !== "event").slice(0, 4);
  return facts.filter(([, v]) => v !== undefined && v !== null && v !== "");
}

// ---- Feature 3/4/6 renderers, reused by both the trace and the provenance modal ----

function routeCompareHtml(moves) {
  const routed = (moves || []).filter(m => m.chosen_route);
  if (!routed.length) return "";
  const m = routed[0];
  const cards = m.route_options.map(o => `<div class="route-card ${o.destination === m.chosen_route.destination ? "chosen" : ""}">
      <div class="route-card-dest">${escapeHtml(o.destination)}</div>
      <div class="route-card-row"><span>ETA</span><b>${o.eta_hours}h</b></div>
      <div class="route-card-row"><span>Cost</span><b>${fmtINR(o.cost_inr)}</b></div>
      <div class="route-card-row"><span>Shelf life on arrival</span><b>${o.remaining_shelf_life_on_arrival_hours}h</b></div>
      <div class="route-card-row"><span>Risk</span><b>${escapeHtml(o.risk)}</b></div>
    </div>`).join("");
  return `<div style="border-top:1px dashed var(--line-strong);padding-top:9px;margin-top:9px;">
    <div style="font-size:11px;color:var(--charcoal-45);margin-bottom:6px;">Freshness-aware route comparison for ${escapeHtml(m.batch_code || ("batch " + m.batch_id))} <span class="tag tag-muted">simulated ETA/cost model</span></div>
    <div class="route-compare">${cards}</div>
  </div>`;
}

function interventionOptionsHtml(decision) {
  if (!decision.options || !decision.options.length) return "";
  const rows = decision.options.map(o => `<div class="intervention-row ${o.action === decision.recommended_action ? "recommended" : ""}">
      <div><div class="intervention-label">${escapeHtml(o.label)}</div><div class="intervention-detail">${escapeHtml(o.detail || "")}</div></div>
      <div class="intervention-metrics">
        <span title="expected waste reduction">−${fmtKg(o.expected_waste_reduction_kg)}</span>
        <span title="net value impact">${fmtINR(o.net_value_inr)}</span>
        <span title="risk reduction">${escapeHtml(o.risk_reduction)}</span>
      </div>
    </div>`).join("");
  return `<div style="margin-top:9px;"><span class="tag tag-warn">Simulation / estimated impact</span><div class="intervention-options">${rows}</div></div>`;
}

function counterfactualHtml(decision) {
  const cf = decision.counterfactual;
  if (!cf) return "";
  return `<div class="counterfactual">
    <div class="cf-col cf-without">
      <div class="cf-title">Without HARVEX</div>
      <div class="cf-stat"><span>Waste</span><b>${fmtKg(cf.without_harvex.waste_kg)}</b></div>
      <div class="cf-stat"><span>Value at risk</span><b>${fmtINR(cf.without_harvex.value_at_risk_inr)}</b></div>
      <div class="cf-stat"><span>Batches</span><b>${cf.without_harvex.affected_batches}</b></div>
    </div>
    <div class="cf-col cf-with">
      <div class="cf-title">With HARVEX</div>
      <div class="cf-stat"><span>Waste</span><b>${fmtKg(cf.with_harvex.waste_kg)}</b></div>
      <div class="cf-stat"><span>Value preserved</span><b>${fmtINR(cf.with_harvex.value_preserved_inr)}</b></div>
      <div class="cf-stat"><span>Batches</span><b>${cf.with_harvex.affected_batches}</b></div>
    </div>
  </div>`;
}

function decisionExtrasHtml(decision) {
  if (!decision) return "";
  if (decision.event === "LOGISTICS_PRIORITIZED") return routeCompareHtml(decision.moves);
  if (decision.event === "INTERVENTION_RECOMMENDED") return interventionOptionsHtml(decision);
  if (decision.event === "WASTE_IMPACT_ESTIMATED" && decision.counterfactual) {
    const riskLine = decision.risk_before_level ? `<div style="font-size:11.5px;color:var(--charcoal-70);margin:8px 0 4px;">Risk before <b class="mono">${escapeHtml(decision.risk_before_level)}</b> → after action <b class="mono" style="color:var(--success)">${escapeHtml(decision.risk_after_level)}</b></div>` : "";
    return riskLine + counterfactualHtml(decision);
  }
  return "";
}

function renderTrace(steps, cascadeId) {
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
          <span style="display:flex;align-items:center;gap:8px;">
            <span class="trace-event-type">${escapeHtml(s.trigger_event.type || "")}</span>
            <button class="why-btn" data-cascade="${cascadeId}" data-step="${s.step_order}">Why?</button>
          </span>
        </div>
        <div class="trace-reasoning">${escapeHtml(s.reasoning)}${modeTag}</div>
        <div class="trace-row">${factsHtml}</div>
        <div class="trace-row">
          <span>Confidence <b>${Math.round(s.confidence * 100)}%</b><span class="confidence-track"><span class="confidence-fill" style="width:${Math.round(s.confidence*100)}%"></span></span></span>
        </div>
        ${actionsHtml ? `<div class="trace-actions">${actionsHtml}</div>` : ""}
        ${decisionExtrasHtml(s.decision)}
        ${downstreamHtml}
      </div>
    </div>`;
  }).join("");

  container.innerHTML = `<div class="trace-flow">${html}</div>`;

  $all("#traceContainer .why-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openProvenance(Number(btn.dataset.cascade), Number(btn.dataset.step));
    });
  });
}

// ---------------------------------------------------------------------
// Decision Provenance (Feature 1 — "Why did HARVEX do this?")
// Built entirely from /api/cascades/<id>/trace — no fabricated reasoning,
// only the real evidence/reasoning/actions/impact each agent already
// produced, reorganized as: Signal -> Data/Factors -> Agents Involved ->
// Decision -> Action -> Expected Outcome / Risk Reduced.
// ---------------------------------------------------------------------

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Picks which decision in the cascade is the "headline" one being explained,
// when the caller didn't point at a specific step (e.g. a Waste Ledger or
// Logistics row only knows the cascade, not a step_order). Prefers the last
// decision that actually carried an action, since that's the concrete thing
// HARVEX did; falls back to the last decision recorded.
function pickDefaultStep(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].actions && steps[i].actions.length) return steps[i];
  }
  return steps[steps.length - 1] || null;
}

function agentOneLiner(step) {
  const text = step.reasoning || "";
  return text.length > 160 ? text.slice(0, 157) + "…" : text;
}

function findWasteOutcome(steps) {
  return steps.find(s => s.decision && s.decision.event === "WASTE_IMPACT_ESTIMATED" && s.decision.waste_avoided_kg !== undefined);
}

function provenanceFacts(decision) {
  if (Array.isArray(decision.evidence) && decision.evidence.length) {
    return decision.evidence;
  }
  return decisionFacts(decision).map(([label, val]) => `${label}: ${val}`);
}

function decisionHeadline(decision) {
  if (!decision) return "act";
  switch (decision.event) {
    case "PROCUREMENT_ADJUSTED": {
      const verb = decision.recommended_action === "REDUCE_PROCUREMENT" ? "reduce"
        : decision.recommended_action === "INCREASE_PROCUREMENT" ? "increase" : "adjust";
      return `${verb} ${decision.product || ""} procurement`;
    }
    case "PRICING_RECOMMENDED":
      return `apply a ${fmtPct(decision.markdown_pct)} markdown on ${decision.product || ""}`;
    case "LOGISTICS_PRIORITIZED":
      return `prioritize movement of ${decision.product || ""}`;
    case "VENDOR_RENEGOTIATION_RECOMMENDED":
      return `${(decision.recommended_action || "renegotiate").replace(/_/g, " ").toLowerCase()} with ${decision.supplier || "this supplier"}`;
    case "SHELF_LIFE_ALLOCATED":
      return `allocate shelf-life budget for ${decision.product || ""}`;
    case "INVENTORY_EXPOSURE":
      return `flag ${(decision.exposure_type || "exposure").toLowerCase()} for ${decision.product || ""}`;
    case "COLD_CHAIN_BREACH":
      return `escalate a cold-chain breach at ${decision.warehouse || "this warehouse"}`;
    case "DEMAND_SHOCK":
      return `flag a demand ${decision.direction === "DROP" ? "drop" : "spike"} for ${decision.product || ""}`;
    case "SUPPLY_RISK_DETECTED":
      return `flag a supply risk on ${decision.product || ""}`;
    case "LOGISTICS_DELAY":
      return `flag a logistics delay at ${decision.warehouse || "this warehouse"}`;
    case "INTERVENTION_RECOMMENDED":
      return `recommend ${(decision.recommended_label || "an intervention").toLowerCase()} for ${decision.product || ""}`;
    case "CANNIBALIZATION_FLAGGED":
      return `review markdown cannibalization risk for ${decision.product || ""}`;
    case "WASTE_IMPACT_ESTIMATED":
      return `estimate waste impact for ${decision.product || "this cascade"}`;
    case "ERP_ACTION_GENERATED":
      return `generate an ERP action for ${decision.source_event ? decision.source_event.replace(/_/g, " ").toLowerCase() : "this decision"}`;
    default:
      return (decision.event || "act").replace(/_/g, " ").toLowerCase();
  }
}

async function openProvenance(cascadeId, stepOrder) {
  $("#provenanceModal").classList.add("open");
  $("#provenanceTitle").textContent = "Why did HARVEX do this?";
  $("#provenanceBody").innerHTML = `<div class="empty-state"><p>Loading decision trail…</p></div>`;
  try {
    const data = await api(`/cascades/${cascadeId}/trace`);
    const steps = data.steps;
    const target = (stepOrder != null && !Number.isNaN(stepOrder) ? steps.find(s => s.step_order === stepOrder) : null) || pickDefaultStep(steps);
    if (!target) {
      $("#provenanceBody").innerHTML = `<div class="empty-state"><p>No decision steps recorded for this cascade.</p></div>`;
      return;
    }
    renderProvenance(data, target);
  } catch (e) {
    $("#provenanceBody").innerHTML = `<div class="empty-state"><p>Could not load decision trail: ${escapeHtml(e.message)}</p></div>`;
  }
}

function renderProvenance(data, target) {
  const c = data.cascade;
  const steps = data.steps;

  $("#provenanceTitle").textContent = "Why did HARVEX " + capitalize(decisionHeadline(target.decision)) + "?";

  // 1. SIGNAL — the real trigger that started this cascade, grounded in cascades.trigger_description
  const root = steps[0];
  const signalHtml = `
    <div class="prov-section">
      <div class="prov-section-title"><span class="prov-num">1</span> Signal</div>
      <div class="prov-signal-line">${escapeHtml(c.trigger_description)}</div>
      <div class="prov-signal-sub">Detected as <b class="mono">${escapeHtml((root && root.trigger_event.type) || c.scenario_type)}</b> · cascade #${c.id} · ${escapeHtml(c.scenario_type)} · started ${escapeHtml(timeAgo(c.started_at))}</div>
    </div>`;

  // 2. DATA / FACTORS — this decision's own grounded evidence (or its key facts if no evidence array)
  const facts = provenanceFacts(target.decision || {});
  const factsHtml = `
    <div class="prov-section">
      <div class="prov-section-title"><span class="prov-num">2</span> Data &amp; Factors</div>
      <div class="prov-facts">
        ${facts.length ? facts.map(f => `<div class="prov-fact-row">${escapeHtml(String(f))}</div>`).join("") : `<div class="prov-none">No structured evidence recorded for this decision.</div>`}
      </div>
    </div>`;

  // 3. AGENTS INVOLVED — every agent that actually fired in this cascade, each with its own real reasoning line
  const agentsHtml = `
    <div class="prov-section">
      <div class="prov-section-title"><span class="prov-num">3</span> Agents Involved</div>
      ${steps.map(s => `
        <div class="prov-agent-row">
          <div class="prov-agent-name"><span class="agent-dot"></span>${escapeHtml(s.agent)}</div>
          <div class="prov-agent-text">${escapeHtml(agentOneLiner(s))}</div>
        </div>
      `).join("")}
    </div>`;

  // 4. DECISION — the specific decision being explained
  const dFacts = decisionFacts(target.decision || {});
  const decisionHtml = `
    <div class="prov-section">
      <div class="prov-section-title"><span class="prov-num">4</span> Decision</div>
      <div class="prov-decision-box">
        <div class="prov-decision-headline">${escapeHtml(capitalize(decisionHeadline(target.decision)))}</div>
        <div class="prov-decision-reasoning">${escapeHtml(target.reasoning)}</div>
        <div class="trace-row">${dFacts.map(([label, val]) => `<span><b>${escapeHtml(String(val))}</b> ${escapeHtml(label)}</span>`).join("")}</div>
        <div class="trace-row" style="margin-top:6px;">
          <span>Confidence <b>${Math.round(target.confidence * 100)}%</b><span class="confidence-track"><span class="confidence-fill" style="width:${Math.round(target.confidence * 100)}%"></span></span></span>
        </div>
        ${decisionExtrasHtml(target.decision)}
      </div>
    </div>`;

  // 5. ACTION — what HARVEX actually queued/executed for this decision
  const actions = target.actions || [];
  const actionsHtml = `
    <div class="prov-section">
      <div class="prov-section-title"><span class="prov-num">5</span> Action</div>
      ${actions.length ? `<div class="trace-actions">${actions.map(a => {
        const cls = a.requires_approval ? "needs-approval" : "auto";
        const label = a.action_type.replace(/_/g, " ").toLowerCase();
        const statusLabel = a.status === "PENDING" ? "awaiting approval" : a.status === "AUTO_EXECUTED" ? "auto-executed" : a.status.toLowerCase();
        return `<span class="action-chip ${cls}">${a.requires_approval ? "⏸" : "✓"} ${escapeHtml(label)} — ${statusLabel}</span>`;
      }).join("")}</div>` : `<div class="prov-none">No direct action taken — informational finding only.</div>`}
    </div>`;

  // 6. EXPECTED OUTCOME / RISK REDUCED — real waste-ledger figures for this cascade if they exist
  const wasteStep = findWasteOutcome(steps);
  let outcomeInner;
  if (wasteStep) {
    const d = wasteStep.decision;
    outcomeInner = `
      <span class="tag tag-warn">Simulation / estimated impact</span>
      <div class="prov-outcome-metrics">
        <div><div class="prov-outcome-metric-label">Waste avoided</div><div class="prov-outcome-metric-value">${fmtKg(d.waste_avoided_kg)}</div></div>
        <div><div class="prov-outcome-metric-label">Value preserved</div><div class="prov-outcome-metric-value">${fmtINR(d.value_preserved_inr)}</div></div>
        <div><div class="prov-outcome-metric-label">Shelf-life util.</div><div class="prov-outcome-metric-value">${fmtPct(d.shelf_life_utilization_pct)}</div></div>
      </div>`;
  } else {
    outcomeInner = `<p class="prov-outcome-empty">No quantified waste/value outcome has been recorded for this cascade yet.</p>`;
  }
  const outcomeHtml = `
    <div class="prov-section">
      <div class="prov-section-title"><span class="prov-num">6</span> Expected Outcome / Risk Reduced</div>
      <div class="prov-outcome-banner">${outcomeInner}</div>
    </div>`;

  $("#provenanceBody").innerHTML = signalHtml + factsHtml + agentsHtml + decisionHtml + actionsHtml + outcomeHtml;
}

// ---------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------

async function loadInventory() {
  await withLoadStateRow($("#inventoryTable tbody"), 8, "Loading inventory…", loadInventoryInner);
}

async function loadInventoryInner() {
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
// Priority Queue + Freshness Budget Lookup (Feature 8 / 2 / 9)
// ---------------------------------------------------------------------

const PQ_BUCKETS = [
  { key: "MOVE_NOW", label: "Move Now", desc: "≤1 effective day left", cls: "pq-move" },
  { key: "SELL_FIRST", label: "Sell First", desc: "≤3 effective days left", cls: "pq-sell" },
  { key: "MONITOR", label: "Monitor", desc: "≤7 effective days left", cls: "pq-monitor" },
  { key: "SAFE", label: "Safe", desc: "> 7 effective days left", cls: "pq-safe" },
];

async function loadPriorityQueue() {
  const grid = $("#pqGrid");
  grid.innerHTML = loadingStateHtml("Loading priority queue…");
  let data;
  try {
    // Retries transient failures (including a cold-starting backend)
    // automatically before surfacing an error.
    data = await api("/priority-queue", null, { retries: 2 });
  } catch (e) {
    grid.innerHTML = errorStateHtml(e);
    wireRetry(grid, loadPriorityQueue);
    return;
  }
  if (!data || !data.groups || !data.counts || !data.kg_totals) {
    grid.innerHTML = errorStateHtml(new Error(
      "The priority queue endpoint responded, but not with the expected data shape (missing groups/counts/kg_totals)."
    ));
    wireRetry(grid, loadPriorityQueue);
    return;
  }

  grid.innerHTML = PQ_BUCKETS.map(b => {
    const items = data.groups[b.key] || [];
    const count = data.counts[b.key] || 0;
    const kg = data.kg_totals[b.key] || 0;
    return `<div class="pq-col ${b.cls}">
      <div class="pq-col-head">
        <div>
          <div class="pq-col-title">${b.label}</div>
          <div class="pq-col-desc">${b.desc}</div>
        </div>
        <div class="pq-col-count">${count}<span>${fmtKg(kg)}</span></div>
      </div>
      <div class="pq-col-body">
        ${items.length ? items.map(f => `
          <button type="button" class="pq-card ${state.activePqBatch === f.batch_id ? "active" : ""}" data-batch="${f.batch_id}">
            <div class="pq-card-top"><span class="mono">${escapeHtml(f.batch_code)}</span><span class="pq-card-days">${f.effective_days_remaining}d</span></div>
            <div class="pq-card-product">${escapeHtml(f.product)}</div>
            <div class="pq-card-meta">${escapeHtml(f.warehouse)} · ${fmtKg(f.quantity_kg)}</div>
          </button>`).join("")
          : `<div class="pq-empty">Nothing here</div>`}
      </div>
    </div>`;
  }).join("");

  $all(".pq-card").forEach(card => {
    card.addEventListener("click", () => loadFreshnessLookup(Number(card.dataset.batch)));
  });

  // Useful default state: auto-open the single most urgent real batch on
  // first visit, instead of leaving the lookup panel empty.
  if (!state.activePqBatch) {
    const firstUrgent = PQ_BUCKETS.map(b => data.groups[b.key] || []).find(list => list.length);
    if (firstUrgent && firstUrgent.length) {
      loadFreshnessLookup(firstUrgent[0].batch_id);
    }
  }
}

async function ensureInventoryIndex() {
  if (state.inventoryIndex) return state.inventoryIndex;
  const rows = await api("/inventory");
  const idx = {};
  rows.forEach(r => { idx[String(r.batch_code).toLowerCase()] = r.id; });
  state.inventoryIndex = idx;
  return idx;
}

async function searchBatch(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return;
  const idx = await ensureInventoryIndex();
  let id = idx[q];
  if (!id) {
    const hit = Object.entries(idx).find(([code]) => code.includes(q));
    id = hit ? hit[1] : null;
  }
  if (id) {
    loadFreshnessLookup(id);
  } else {
    toast(`No batch found matching "${query}"`);
  }
}

function driverBarHtml(d) {
  const positive = d.delta_days >= 0;
  const widthPct = Math.max(6, Math.min(100, Math.abs(d.delta_days) * 16));
  return `<div class="driver-row">
    <div class="driver-label">${escapeHtml(d.label)}<span class="tag tag-muted driver-basis">${escapeHtml(d.basis)}</span></div>
    <div class="driver-bar-track"><div class="driver-bar-fill ${positive ? "pos" : "neg"}" style="width:${widthPct}%"></div></div>
    <div class="driver-value ${positive ? "pos" : "neg"}">${d.delta_days > 0 ? "+" : ""}${d.delta_days}d</div>
  </div>`;
}

function timelinePointHtml(t) {
  return `<div class="timeline-pt risk-${t.risk_level.toLowerCase()}">
    <div class="timeline-label">${escapeHtml(t.label)}</div>
    <div class="timeline-dot"></div>
    <div class="timeline-hours">${t.hours_remaining}h</div>
    <div class="timeline-risk">${escapeHtml(t.risk_level)}</div>
  </div>`;
}

function freshnessBudgetHtml(fb) {
  const priorityClass = fb.priority === "MOVE_NOW" ? "badge-urgent" : fb.priority === "SELL_FIRST" ? "badge-window" : "badge-monitor";
  return `
    <div class="fb-head">
      <div>
        <div class="fb-batch-code mono">${escapeHtml(fb.batch_code)}</div>
        <div class="fb-product">${escapeHtml(fb.product)} · ${escapeHtml(fb.warehouse)} (${escapeHtml(fb.warehouse_region)})</div>
      </div>
      <div class="fb-head-right">
        <span class="badge ${priorityClass}">${escapeHtml(fb.priority.replace("_", " "))}</span>
        <span class="badge badge-${fb.quality_grade}">${fb.quality_grade}</span>
      </div>
    </div>
    <div class="fb-stats">
      <div class="fb-stat"><span>Quantity</span><b>${fmtKg(fb.quantity_kg)}</b></div>
      <div class="fb-stat"><span>Calendar days left</span><b>${fb.calendar_days_remaining}d</b></div>
      <div class="fb-stat"><span>Effective budget</span><b>${fb.effective_days_remaining}d</b></div>
      <div class="fb-stat"><span>Risk level</span><b>${escapeHtml(fb.risk_level)}</b></div>
    </div>
    <div class="fb-section-title">Freshness-Budget Drivers</div>
    <div class="driver-list">${fb.drivers.map(driverBarHtml).join("")}</div>
    <div class="fb-section-title">Risk Timeline — next 24h</div>
    <div class="timeline">${fb.risk_timeline.map(timelinePointHtml).join("")}</div>
    <p class="fb-note">${escapeHtml(fb.note)}</p>
  `;
}

async function loadFreshnessLookup(batchId) {
  state.activePqBatch = batchId;
  $all(".pq-card").forEach(c => c.classList.toggle("active", Number(c.dataset.batch) === batchId));
  const box = $("#freshnessLookup");
  box.innerHTML = `<div class="empty-state"><p>Loading freshness budget…</p></div>`;
  try {
    const fb = await api(`/batches/${batchId}/freshness-budget`);
    box.innerHTML = freshnessBudgetHtml(fb);
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    box.innerHTML = `<div class="empty-state"><p>Could not load this batch: ${escapeHtml(e.message)}</p></div>`;
  }
}

// ---------------------------------------------------------------------
// Command Assistant (Feature 7)
// ---------------------------------------------------------------------

const ASSISTANT_SUGGESTIONS = [
  "What's the biggest waste risk right now?",
  "Which batch should move first?",
  "What happens if Nashik is delayed 8h by rainfall?",
  "Which supplier should we renegotiate with?",
  "Give me an operations overview",
];

function loadAssistant() {
  if (!state.assistantHistory.length) {
    renderAssistantWelcome();
  }
}

function renderAssistantWelcome() {
  $("#assistantMessages").innerHTML = `
    <div class="asst-msg asst-msg-bot">
      <div class="asst-avatar">✦</div>
      <div class="asst-bubble">
        <div class="asst-bubble-text">I'm grounded in HARVEX's live operational data — inventory, cascades and every agent decision on record. Ask about a product, a batch, a supplier, or try a what-if scenario.</div>
      </div>
    </div>`;
  renderAssistantSuggestions();
}

function renderAssistantSuggestions() {
  $("#assistantSuggestions").innerHTML = ASSISTANT_SUGGESTIONS.map(q =>
    `<button type="button" class="asst-chip">${escapeHtml(q)}</button>`).join("");
  $all(".asst-chip").forEach(chip => {
    chip.addEventListener("click", () => sendAssistantMessage(chip.textContent));
  });
}

function appendAssistantMessage(role, innerHtml) {
  const wrap = document.createElement("div");
  wrap.className = "asst-msg asst-msg-" + (role === "user" ? "user" : "bot");
  wrap.innerHTML = innerHtml;
  $("#assistantMessages").appendChild(wrap);
  $("#assistantMessages").scrollTop = $("#assistantMessages").scrollHeight;
  return wrap;
}

function assistantExtraHtml(res) {
  const d = res.data || {};
  if (d.event === "WHAT_IF_SIMULATION" && d.counterfactual) {
    return `<div class="asst-extra">
      <span class="tag tag-warn">${escapeHtml(d.label || "Simulation / estimated impact")}</span>
      ${counterfactualHtml({ counterfactual: d.counterfactual })}
    </div>`;
  }
  if (d.event === "BIGGEST_WASTE_RISK" && (d.top_batches || []).length) {
    return `<div class="asst-batch-list">${d.top_batches.map(b => `
      <button type="button" class="asst-batch-chip" data-lookup="${b.batch_code}">
        <span class="mono">${escapeHtml(b.batch_code)}</span>
        <span>${escapeHtml(b.product)}</span>
        <span class="badge ${(b.risk_level === "CRITICAL" || b.risk_level === "HIGH") ? "badge-urgent" : "badge-monitor"}">${escapeHtml(b.risk_level)}</span>
      </button>`).join("")}</div>`;
  }
  if (d.event === "MOVE_FIRST" && (d.move_now_batches || []).length) {
    return `<div class="asst-batch-list">${d.move_now_batches.map(b => `
      <button type="button" class="asst-batch-chip" data-lookup="${b.batch_code}">
        <span class="mono">${escapeHtml(b.batch_code)}</span>
        <span>${escapeHtml(b.product)}</span>
        <span class="num">${fmtKg(b.quantity_kg)}</span>
      </button>`).join("")}</div>`;
  }
  if (d.event === "WHAT_IF_SIMULATION") {
    return `<div class="asst-extra"><span class="tag tag-warn">${escapeHtml(d.label || "Simulation / estimated impact")}</span></div>`;
  }
  return "";
}

function assistantReplyHtml(res) {
  const modeTag = res.mode === "live"
    ? `<span class="tag tag-live">live reasoning</span>`
    : `<span class="tag tag-muted">simulation mode</span>`;
  const intentTag = `<span class="tag">${escapeHtml((res.intent || "").replace(/_/g, " "))}</span>`;
  const evidence = res.evidence || [];
  const evidenceHtml = evidence.length ? `
    <details class="asst-evidence">
      <summary>Evidence (${evidence.length})</summary>
      ${evidence.map(e => `<div class="asst-evidence-row">${escapeHtml(String(e))}</div>`).join("")}
    </details>` : "";
  const agents = res.agents_consulted || [];
  const agentsHtml = agents.length ? `
    <div class="asst-agents">${agents.map(a => `<span class="asst-agent-chip"><span class="agent-dot"></span>${escapeHtml(a)}</span>`).join("")}</div>` : "";

  return `
    <div class="asst-avatar">✦</div>
    <div class="asst-bubble">
      <div class="asst-bubble-head">${intentTag}${modeTag}</div>
      <div class="asst-bubble-text">${escapeHtml(res.answer)}</div>
      ${assistantExtraHtml(res)}
      ${evidenceHtml}
      ${agentsHtml}
    </div>`;
}

async function sendAssistantMessage(message) {
  message = (message || "").trim();
  if (!message) return;

  appendAssistantMessage("user", `<div class="asst-bubble asst-bubble-user">${escapeHtml(message)}</div>`);
  $("#assistantInput").value = "";
  $("#assistantSuggestions").innerHTML = "";
  state.assistantHistory.push({ role: "user", text: message });

  const thinkingEl = appendAssistantMessage("bot", `
    <div class="asst-avatar">✦</div>
    <div class="asst-bubble asst-typing"><span></span><span></span><span></span></div>`);

  try {
    // Retries transient failures (including a cold-starting backend) before
    // giving up, so the very first question of a session doesn't fail just
    // because the server was asleep.
    const res = await api("/assistant/query", { method: "POST", body: JSON.stringify({ message }) }, { retries: 2 });
    thinkingEl.remove();
    appendAssistantMessage("bot", assistantReplyHtml(res));
    state.assistantHistory.push({ role: "assistant", data: res });
    $all(".asst-batch-chip").forEach(chip => {
      chip.addEventListener("click", async () => {
        setView("priority");
        await loadPriorityQueue();
        searchBatch(chip.dataset.lookup);
      });
    });
  } catch (e) {
    thinkingEl.remove();
    const statusLine = e.status ? `HTTP ${e.status} — ` : "";
    const bot = appendAssistantMessage("bot", `
      <div class="asst-avatar">✦</div>
      <div class="asst-bubble">
        <div class="asst-bubble-text">Couldn't reach the Command Assistant: ${escapeHtml(statusLine + (e.message || "unknown error"))}</div>
        <button type="button" class="btn btn-ghost btn-sm asst-retry-btn" style="margin-top:8px;">Retry this question</button>
      </div>`);
    const retryBtn = bot.querySelector(".asst-retry-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        bot.remove();
        sendAssistantMessage(message);
      }, { once: true });
    }
  }
  renderAssistantSuggestions();
}

function clearAssistant() {
  state.assistantHistory = [];
  renderAssistantWelcome();
}

// ---------------------------------------------------------------------
// Procurement & Risk
// ---------------------------------------------------------------------

async function loadProcurement() {
  await withLoadStateRow($("#procurementTable tbody"), 7, "Loading procurement & risk…", loadProcurementInner);
}

async function loadProcurementInner() {
  const [orders, risks] = await Promise.all([api("/procurement"), api("/risks")]);
  $("#procurementTable tbody").innerHTML = orders.map(o => `<tr>
      <td>${escapeHtml(o.product_name)}</td>
      <td>${escapeHtml(o.supplier_name)}</td>
      <td>${escapeHtml(o.warehouse_name)}</td>
      <td class="num">${fmtNum(o.quantity_kg)}</td>
      <td class="num">${fmtINR(o.price_per_kg)}</td>
      <td class="mono">${escapeHtml(o.delivery_date)}</td>
      <td><span class="badge badge-monitor">${escapeHtml(o.status)}</span></td>
    </tr>`).join("") || `<tr><td colspan="7"><div class="empty-state"><p>No procurement orders on record.</p></div></td></tr>`;

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
  await withLoadStateRow($("#logisticsTable tbody"), 8, "Loading logistics…", loadLogisticsInner);
}

async function loadLogisticsInner() {
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
      <td>${l.cascade_id ? `<button class="why-btn" data-cascade="${l.cascade_id}">Why?</button>` : ""}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="8"><div class="empty-state"><p>No logistics operations yet — run a scenario from the Ripple Console.</p></div></td></tr>`;

  $all("#logisticsTable .why-btn").forEach(btn => {
    btn.addEventListener("click", () => openProvenance(Number(btn.dataset.cascade)));
  });
}

// ---------------------------------------------------------------------
// Cold-Chain Risk Monitor
// ---------------------------------------------------------------------

async function loadColdChain() {
  await withLoadState($("#coldChainKpiRow"), "Loading cold-chain status…", loadColdChainInner);
}

async function loadColdChainInner() {
  const [readings, warehouses, cascades] = await Promise.all([
    api("/cold-chain"), api("/warehouses"), api("/cascades"),
  ]);

  const coldWh = warehouses.filter(w => w.cold_chain_enabled);
  const breachReadings = readings.filter(r => r.is_breach);
  const breachCascades = cascades.filter(c => c.scenario_type === "COLD_CHAIN_BREACH");

  // readings arrive newest-first from the API; keep the first (=latest) per warehouse
  const latestByWarehouse = {};
  readings.forEach(r => {
    if (!latestByWarehouse[r.warehouse_id]) latestByWarehouse[r.warehouse_id] = r;
  });

  $("#coldChainKpiRow").innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Cold-Chain Warehouses</div>
      <div class="kpi-value">${coldWh.length}</div>
      <div class="kpi-sub">of ${warehouses.length} total warehouses</div>
    </div>
    <div class="kpi-card accent-terracotta">
      <div class="kpi-label">Breach Readings</div>
      <div class="kpi-value">${breachReadings.length}</div>
      <div class="kpi-sub">of ${readings.length} recent readings</div>
    </div>
    <div class="kpi-card accent-terracotta">
      <div class="kpi-label">Breach Cascades</div>
      <div class="kpi-value">${breachCascades.length}</div>
      <div class="kpi-sub">triggered the Ripple Engine</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Warehouses Reporting</div>
      <div class="kpi-value">${Object.keys(latestByWarehouse).length}</div>
      <div class="kpi-sub">with at least one reading</div>
    </div>
  `;

  $("#coldChainWarehouseGrid").innerHTML = coldWh.length ? coldWh.map(w => {
    const latest = latestByWarehouse[w.id];
    if (!latest) {
      return `<div class="cc-card">
        <div class="cc-card-head"><div class="cc-card-name">${escapeHtml(w.name)}</div><span class="badge badge-monitor">No readings yet</span></div>
        <div class="cc-card-sub">${escapeHtml(w.region)}</div>
      </div>`;
    }
    const delta = latest.temperature_c - latest.target_temperature_c;
    return `<div class="cc-card ${latest.is_breach ? "cc-breach" : ""}">
      <div class="cc-card-head">
        <div class="cc-card-name">${escapeHtml(w.name)}</div>
        <span class="badge ${latest.is_breach ? "badge-urgent" : "badge-monitor"}">${latest.is_breach ? "Breach" : "Normal"}</span>
      </div>
      <div class="cc-card-sub">${escapeHtml(w.region)} · updated ${timeAgo(latest.recorded_at)}</div>
      <div class="cc-temp-row">
        <div class="cc-temp"><span>Observed</span><b>${latest.temperature_c.toFixed(1)}°C</b></div>
        <div class="cc-temp"><span>Target</span><b>${latest.target_temperature_c.toFixed(1)}°C</b></div>
        <div class="cc-temp"><span>Δ</span><b class="${delta > 0.5 ? "cc-delta-bad" : "cc-delta-ok"}">${delta >= 0 ? "+" : ""}${delta.toFixed(1)}°C</b></div>
      </div>
      <div class="cc-bar-track"><div class="cc-bar-fill ${latest.is_breach ? "bad" : "ok"}" style="width:${Math.max(6, Math.min(100, 50 + delta * 10))}%"></div></div>
      <div class="cc-card-meta">Humidity ${latest.humidity_pct.toFixed(0)}%</div>
    </div>`;
  }).join("") : `<div class="empty-state"><p>No cold-chain-enabled warehouses configured.</p></div>`;

  $("#coldChainIncidents").innerHTML = breachCascades.length ? breachCascades.map(c => `
    <div class="cascade-row" data-id="${c.id}">
      <div class="cascade-row-main">
        <div class="cascade-row-title">${escapeHtml(c.trigger_description)}</div>
        <div class="cascade-row-meta">${escapeHtml(c.scenario_type)} · ${timeAgo(c.started_at)} · click for full agent response</div>
      </div>
      <span class="badge ${c.status === "IN_PROGRESS" ? "badge-progress" : "badge-complete"}">${c.status.replace("_"," ")}</span>
    </div>
  `).join("") : `<div class="empty-state"><p>No cold-chain breach cascades yet — trigger "Cold-Chain Breach" from the Ripple Console.</p></div>`;
  $all("#coldChainIncidents .cascade-row").forEach(row => {
    row.addEventListener("click", () => openCascade(Number(row.dataset.id)));
  });

  $("#coldChainTable tbody").innerHTML = readings.length ? readings.map(r => {
    const delta = r.temperature_c - r.target_temperature_c;
    return `<tr>
      <td>${escapeHtml(r.warehouse_name)}</td>
      <td class="mono">${timeAgo(r.recorded_at)}</td>
      <td class="num">${r.temperature_c.toFixed(1)}°C</td>
      <td class="num">${r.target_temperature_c.toFixed(1)}°C</td>
      <td class="num ${delta > 0.5 ? "cc-delta-bad" : "cc-delta-ok"}">${delta >= 0 ? "+" : ""}${delta.toFixed(1)}°C</td>
      <td class="num">${r.humidity_pct.toFixed(0)}%</td>
      <td><span class="badge ${r.is_breach ? "badge-urgent" : "badge-monitor"}">${r.is_breach ? "BREACH" : "OK"}</span></td>
    </tr>`;
  }).join("") : `<tr><td colspan="7"><div class="empty-state"><p>No cold-chain readings yet — trigger "Cold-Chain Breach" from the Ripple Console.</p></div></td></tr>`;
}

// ---------------------------------------------------------------------
// Waste ledger
// ---------------------------------------------------------------------

async function loadWaste() {
  await withLoadState($("#wasteKpiRow"), "Loading waste ledger…", loadWasteInner);
}

async function loadWasteInner() {
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
      <td>${e.cascade_id ? `<button class="why-btn" data-cascade="${e.cascade_id}">Why?</button>` : ""}</td>
    </tr>`).join("") : `<tr><td colspan="8"><div class="empty-state"><p>No impact recorded yet — run a scenario from the Ripple Console.</p></div></td></tr>`;

  $all("#wasteTable .why-btn").forEach(btn => {
    btn.addEventListener("click", () => openProvenance(Number(btn.dataset.cascade)));
  });
}

// ---------------------------------------------------------------------
// Agent activity
// ---------------------------------------------------------------------

async function loadAgents() {
  await withLoadState($("#agentFeed"), "Loading agent activity…", loadAgentsInner);
}

async function loadAgentsInner() {
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
  try {
    const rows = await api("/actions?status=PENDING");
    state.pendingCount = rows.length;
    $("#approvalCount").textContent = rows.length;
    return rows;
  } catch (e) {
    // Non-fatal — the pending-approvals badge just keeps its last known
    // value rather than crashing the boot sequence.
    console.warn("Could not refresh approval count:", e.message);
    return [];
  }
}

// Numeric payload fields worth exposing for a manager to Modify, in
// preference order. Falls back to the first remaining numeric field.
// old_price is excluded — it's the "before" value, never the edited one.
const MODIFY_FIELD_PRIORITY = ["quantity_change_kg", "new_target_kg", "new_price", "markdown_pct", "quantity_adjustment_kg"];
function primaryModifyField(payload) {
  for (const f of MODIFY_FIELD_PRIORITY) {
    if (typeof payload[f] === "number") return f;
  }
  const entry = Object.entries(payload || {}).find(([k, v]) => typeof v === "number" && k !== "old_price");
  return entry ? entry[0] : null;
}

function approvalCardHtml(a) {
  const field = primaryModifyField(a.payload);
  const confPct = a.agent_confidence !== null && a.agent_confidence !== undefined ? Math.round(a.agent_confidence * 100) : null;
  const facts = [];
  if (a.payload.product) facts.push([a.payload.product, "product"]);
  if (a.payload.supplier) facts.push([a.payload.supplier, "supplier"]);
  if (a.payload.batch_code) facts.push([a.payload.batch_code, "batch"]);
  Object.entries(a.payload || {}).forEach(([k, v]) => {
    if (typeof v === "number" && k !== "old_price") facts.push([v, k.replace(/_/g, " ")]);
  });
  const factsHtml = facts.length
    ? `<div class="trace-row approval-facts">${facts.map(([val, label]) => `<span><b>${escapeHtml(String(val))}</b> ${escapeHtml(label)}</span>`).join("")}</div>`
    : "";
  const statusBadge = a.status !== "PENDING"
    ? `<span class="badge ${a.status === "APPROVED" ? "badge-complete" : a.status === "REJECTED" ? "badge-urgent" : "badge-window"}">${escapeHtml(a.status)}</span>`
    : "";

  return `
    <div class="approval-card" data-id="${a.id}" data-cascade="${a.cascade_id}" data-field="${field || ""}">
      <div class="approval-card-head">
        <div class="approval-title">${escapeHtml(a.action_type.replace(/_/g," "))}</div>
        <div style="display:flex;gap:6px;align-items:center;">
          ${confPct !== null ? `<span class="tag tag-muted">conf ${confPct}%</span>` : ""}
          ${statusBadge}
        </div>
      </div>
      <div class="approval-meta">${escapeHtml(a.trigger_description || "")}${a.agent_name ? " · " + escapeHtml(a.agent_name) : ""}</div>
      ${a.agent_reasoning ? `<div class="approval-reasoning">${escapeHtml(a.agent_reasoning)}</div>` : ""}
      ${factsHtml}
      <div class="approval-actions">
        <button class="btn btn-primary btn-sm approve-btn">Approve</button>
        <button class="btn btn-ghost btn-sm reject-btn">Reject</button>
        ${field ? `<button type="button" class="btn btn-ghost btn-sm modify-btn">Modify</button>` : ""}
        <button type="button" class="btn btn-ghost btn-sm why-btn" data-cascade="${a.cascade_id}">Why?</button>
      </div>
      ${field ? `
      <form class="modify-form">
        <label class="modify-label">${escapeHtml(field.replace(/_/g," "))}</label>
        <input type="number" step="any" class="modify-input" value="${a.payload[field]}" />
        <button type="submit" class="btn btn-primary btn-sm">Save</button>
        <button type="button" class="btn btn-ghost btn-sm modify-cancel">Cancel</button>
      </form>` : ""}
    </div>`;
}

async function openApprovalDrawer() {
  $("#approvalDrawer").classList.add("open");
  await withLoadState($("#approvalList"), "Loading pending approvals…", async () => {
    const rows = await api("/actions?status=PENDING");
    state.pendingCount = rows.length;
    $("#approvalCount").textContent = rows.length;

    $("#approvalList").innerHTML = rows.length ? rows.map(approvalCardHtml).join("") :
      `<div class="empty-state"><p>No actions awaiting approval.</p></div>`;

    $all(".approve-btn").forEach(b => b.addEventListener("click", (e) => decideAction(e, "approve")));
    $all(".reject-btn").forEach(b => b.addEventListener("click", (e) => decideAction(e, "reject")));

    $all(".modify-btn").forEach(b => b.addEventListener("click", (e) => {
      const form = e.target.closest(".approval-card").querySelector(".modify-form");
      if (form) form.classList.toggle("open");
    }));
    $all(".modify-cancel").forEach(b => b.addEventListener("click", (e) => {
      e.target.closest(".modify-form").classList.remove("open");
    }));
    $all(".modify-form").forEach(form => {
      form.addEventListener("submit", (e) => { e.preventDefault(); submitModify(form); });
    });
    $all("#approvalDrawer .why-btn").forEach(btn => {
      btn.addEventListener("click", () => openProvenance(Number(btn.dataset.cascade)));
    });
  });
}

async function submitModify(form) {
  const card = form.closest(".approval-card");
  const id = card.dataset.id;
  const field = card.dataset.field;
  const raw = form.querySelector(".modify-input").value;
  const value = Number(raw);
  if (!field || Number.isNaN(value)) { toast("Enter a valid number"); return; }
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await api(`/actions/${id}/modify`, { method: "POST", body: JSON.stringify({ field, value }) });
    toast("Action modified and marked as approved-with-changes");
    refreshApprovalCount();
    openApprovalDrawer();
    loadView(state.view);
  } catch (err) {
    toast("Error: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function decideAction(e, decision) {
  const card = e.target.closest(".approval-card");
  const id = card.dataset.id;
  const btns = card.querySelectorAll("button");
  btns.forEach(b => b.disabled = true);
  try {
    await api(`/actions/${id}/${decision}`, { method: "POST" });
    toast(decision === "approve" ? "Action approved" : "Action rejected");
    card.remove();
    if (!$("#approvalList").children.length) {
      $("#approvalList").innerHTML = `<div class="empty-state"><p>No actions awaiting approval.</p></div>`;
    }
    refreshApprovalCount();
    loadView(state.view);
  } catch (err) {
    toast("Error: " + err.message);
    btns.forEach(b => b.disabled = false);
  }
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

async function checkBackendMode() {
  const pill = $("#llmModePill");
  const text = $("#llmModeText");
  pill.classList.remove("tag-live", "tag-offline");
  text.textContent = "Checking mode…";
  try {
    const meta = await api("/meta", null, { retries: 2 });
    if (meta.llm_mode === "live") {
      text.textContent = "Live reasoning";
      pill.classList.add("tag-live");
    } else {
      text.textContent = "Simulation mode";
    }
  } catch (e) {
    text.textContent = "Backend unreachable — retry";
    pill.classList.add("tag-offline");
  }
}

async function init() {
  $all(".nav-item").forEach(btn => btn.addEventListener("click", () => setView(btn.dataset.view)));
  $("#refreshBtn").addEventListener("click", () => loadView(state.view));
  $("#quickSimBtn").addEventListener("click", () => setView("ripple"));
  $("#approvalToggle").addEventListener("click", openApprovalDrawer);
  $("#closeDrawer").addEventListener("click", () => $("#approvalDrawer").classList.remove("open"));

  $("#closeProvenance").addEventListener("click", () => $("#provenanceModal").classList.remove("open"));
  $("#provenanceModal").addEventListener("click", (e) => {
    if (e.target.id === "provenanceModal") $("#provenanceModal").classList.remove("open");
  });

  $("#assistantForm").addEventListener("submit", (e) => {
    e.preventDefault();
    sendAssistantMessage($("#assistantInput").value);
  });
  $("#assistantClearBtn").addEventListener("click", clearAssistant);

  const batchSearchForm = $("#batchSearchForm");
  if (batchSearchForm) {
    batchSearchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      searchBatch($("#batchSearchInput").value);
    });
  }

  // Clicking the connectivity pill re-checks the backend — useful when it
  // was asleep on first load (Render free-tier cold start).
  $("#llmModePill").addEventListener("click", checkBackendMode);

  await checkBackendMode();
  refreshApprovalCount();
  setView("overview");
}

document.addEventListener("DOMContentLoaded", init);