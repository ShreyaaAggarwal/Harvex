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
  assistant: ["Command Assistant", "Ask HARVEX about products, batches, suppliers — or run a what-if"],
  priority: ["Priority Queue", "Every in-stock batch classified by real freshness-budget risk"],
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
  if (view === "assistant") return loadAssistant();
  if (view === "priority") return loadPriorityQueue();
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

  renderTrace(data.steps, cascadeId);
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
      <td>${l.cascade_id ? `<button class="why-btn" data-cascade="${l.cascade_id}">Why?</button>` : ""}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="8"><div class="empty-state"><p>No logistics operations yet — run a scenario from the Ripple Console.</p></div></td></tr>`;

  $all("#logisticsTable .why-btn").forEach(btn => {
    btn.addEventListener("click", () => openProvenance(Number(btn.dataset.cascade)));
  });
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

  $("#closeProvenance").addEventListener("click", () => $("#provenanceModal").classList.remove("open"));
  $("#provenanceModal").addEventListener("click", (e) => {
    if (e.target.id === "provenanceModal") $("#provenanceModal").classList.remove("open");
  });

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