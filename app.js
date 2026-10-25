import { initialState, COLORS, restoreState, validateConfiguration, isEditingLocked, startRun, advanceRun, approveRun, requestChanges, agentStatus } from "./model.js";
import { Office, drawAvatar, deskPositions } from "./office.js";
import { Execution } from "./execution.js";

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const STORAGE_KEY = "herdr-office:v1";
let state;
let storageAvailable = true;
try { state = restoreState(localStorage.getItem(STORAGE_KEY)); }
catch { state = initialState(); storageAvailable = false; }
let view = "office";
let selectedAgent = null;
let selectedColor = null;
let previousFocus = null;
let office = null;
let toastTimer;
let live = { connected: false, agents: [], workspace: "", message: "Checking connection…" };
let fetching = false;
const execution = new Execution(() => structuredClone(state), notify, () => {
  state.mode = "live"; view = "office"; save(); render();
});

function officeState() {
  return state.mode === "live" ? execution.officeState(state) : state;
}

const labels = {
  office: ["YOUR AGENT WORKSPACE", "Your team. In motion", "A shared space to turn ideas into outcomes.", "Office"],
  team: ["DIGITAL TEAMMATES, CLEAR ROLES", "A team that feels like yours", "Define who takes part, what each agent does, and what they deliver.", "Team"],
  workflow: ["FROM FIRST PLAN TO FINAL REVIEW", "Every delivery, a next step", "Edit demo stages or keep Planning → Implementation → Review for real execution.", "Workflow"],
  activity: ["YOUR TEAM'S SHARED MEMORY", "The story behind every delivery", "Demo decisions and transitions, with simulation clearly separated from evidence.", "Activity"],
  execution: ["TEAM WORKFLOWS", "From plan to verified delivery", "Real workers. Versioned decisions. Evidence you can inspect.", "Execution"]
};

function notify(message, error = false) {
  clearTimeout(toastTimer);
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast${error ? " error" : ""}`;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4600);
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    storageAvailable = false;
    $(".local-note").textContent = "Storage unavailable · export your team";
    notify("Your changes could not be saved in this browser. Export your team to keep your configuration.", true);
  }
}

function act(operation, message) {
  try {
    operation();
    save();
    render();
    if (message) notify(message);
  } catch (error) {
    notify(error.message, true);
  }
}

function pill(text, tone = "green") {
  return `<span class="pill ${tone}"><i></i>${escape(text)}</span>`;
}

function activeStage() {
  return state.run?.stages[state.run.stageIndex];
}

function lockBanner() {
  return isEditingLocked(state) ? '<div class="locked-banner">◇ Your team and workflow are protected while a task is active. Complete or end the demo to edit them. Observation links can still be changed.</div>' : "";
}

function render() {
  office?.destroy();
  office = null;
  const [eyebrow, title, subtitle, breadcrumb] = labels[view];
  $("#eyebrow").textContent = eyebrow;
  $("#page-title").innerHTML = `${escape(title)}<span>.</span>`;
  $("#page-subtitle").textContent = subtitle;
  $(".heading-actions").hidden = view === "execution";
  $("#breadcrumb").textContent = breadcrumb;
  $("#sidebar-team").textContent = state.teamName;
  $("#team-count").textContent = state.agents.length;
  $(".workspace-icon").textContent = state.teamName.split(/\s+/).map(s => s[0]).slice(0, 2).join("").toUpperCase();
  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
    if (button.dataset.view === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#mode-demo").classList.toggle("selected", state.mode === "demo");
  $("#mode-demo").setAttribute("aria-pressed", state.mode === "demo");
  $("#mode-live").classList.toggle("selected", state.mode === "live");
  $("#mode-live").setAttribute("aria-pressed", state.mode === "live");
  $("#new-demand").disabled = state.mode === "live" || isEditingLocked(state);
  $("#motion-toggle").setAttribute("aria-pressed", state.reducedMotion);
  $("#motion-toggle span").textContent = state.reducedMotion ? "Motion reduced" : "Reduce motion";
  $("#mode-notice").innerHTML = view === "execution"
    ? '<span class="notice-symbol">⇢</span><span><strong>Opt-in real execution.</strong> Approval is bound to the exact plan. Work stays local in an isolated worktree. Agent instructions are not a sandbox.</span><span class="notice-tag">HWF ADAPTER</span>'
    : state.mode === "demo"
    ? '<span class="notice-symbol">◇</span><span><strong>Demo environment.</strong> Stages are simulated. No agents, code, or tests are executed.</span><span class="notice-tag">INTERACTIVE</span>'
    : '<span class="notice-symbol">◉</span><span><strong>Live observation, read-only.</strong> Link characters to sessions in this workspace. The workflow does not execute in this mode.</span><span class="notice-tag">NO DISPATCH</span>';
  $("#content").innerHTML = view === "office" ? officeView() : view === "team" ? teamView() : view === "workflow" ? workflowView() : view === "execution" ? execution.markup() : activityView();
  if (view === "execution") execution.paint();
  renderAvatars();
  if (view === "office") office = new Office($("#office-canvas"), officeState, () => live);
  if (!storageAvailable) $(".local-note").textContent = "Storage unavailable · export your team";
  updateConnection();
}

function officeView() {
  const scene = officeState();
  const positions = deskPositions(scene.agents.length);
  return `<div class="office-layout"><div class="office-main">
    <section class="panel office-panel" aria-label="Team office">
      <div class="panel-heading"><h2><span class="mini-icon">▦</span>${escape(scene.teamName)}</h2><span class="meta"><span class="presence-dots"><i></i><i></i><i></i><i></i></span>${scene.agents.length} agents <span>·</span> ${state.mode === "demo" ? "simulation" : "observation"}</span></div>
      <div class="room-wrap"><div class="room"><canvas id="office-canvas" width="1000" height="610" aria-hidden="true"></canvas><div class="room-label">EST. 2026 <strong> / ${escape(scene.teamName.toUpperCase())}</strong></div><div class="room-time">A GOOD DAY TO CREATE</div>
      ${scene.agents.map((agent, index) => {
        const status = agentStatus(scene, agent.id, live);
        return `<button class="desk-hit" data-agent="${escape(agent.id)}" style="left:${positions[index].x / 10}%;top:${positions[index].y / 6.1}%" aria-label="Open ${escape(agent.name)}: ${escape(status.label)}"><span class="agent-pin"><strong>${escape(agent.name)}</strong><small class="${status.key}" data-status="${escape(agent.id)}"><i></i>${escape(status.label)}</small></span></button>`;
      }).join("")}<span class="room-bottom"><i></i>${state.mode === "demo" ? "SIMULATED ACTIVITY · CLICK AN AGENT" : "LIVE STATES · CURRENT WORKSPACE ONLY"}</span></div></div>
      <div class="office-legend"><div class="legend-items"><span><i></i>Active</span><span><i></i>Needs you</span><span><i></i>Waiting</span></div><button class="text-link" data-action="team">Meet the team ↗</button></div>
    </section>
    ${state.mode === "demo" ? pipeline() : '<div class="workflow-note">◉ A session state is not proof of delivery. This view does not approve plans, validate tests, or advance stages automatically.</div>'}
    <section class="team-strip" aria-label="Team members">${scene.agents.map(agent => `<button class="team-mini" data-agent="${escape(agent.id)}"><span class="mini-avatar"><canvas data-avatar="${escape(agent.id)}"></canvas></span><span><strong>${escape(agent.name)}</strong><small>${escape(agent.role)}</small></span></button>`).join("")}</section>
    <section class="panel activity-panel"><div class="panel-heading"><h2><span class="mini-icon">◷</span>Latest activity</h2><button class="text-link" data-action="activity">View history ↗</button></div>${eventsMarkup(3)}</section>
  </div><div class="right-column">${taskCard()}${decisionCard()}</div></div>`;
}

function taskCard() {
  if (state.mode === "live") {
    if (execution.current && execution.current.status !== "archived") return execution.officeCard();
    return `<section class="panel"><div class="panel-heading"><h2><span class="mini-icon">◉</span>Herdr connection</h2>${pill("Read-only", "gray")}</div><div class="card-body"><div class="empty-illustration">⌁</div><h3>Real sessions.<br>Zero interference.</h3><p id="live-summary">${escape(live.message)}</p><div class="mini-stats"><div><strong id="live-agent-count">${live.connected ? live.agents.length : "—"}</strong><small>visible sessions</small></div><div><strong>${state.agents.filter(a => a.binding).length}</strong><small>configured links</small></div></div><button class="button secondary full" data-action="team">Link my team ↗</button><small class="subtle-note">Open an agent and choose its session. No prompts will be sent.</small></div></section>`;
  }
  const run = state.run;
  if (!run) return `<section class="panel"><div class="panel-heading"><h2><span class="mini-icon">▤</span>Team task</h2>${pill("Ready", "gray")}</div><div class="card-body"><div class="empty-illustration">▤</div><h3>Great work starts with an idea.</h3><p>Tell us what you have in mind.<br>Your team has a place to begin.</p><button class="button primary full" data-action="new-demand">Create your first task <span class="arrow">↗</span></button><span class="subtle-note">One task at a time. You approve the moments that matter.</span><div class="mini-stats"><div><strong>${state.agents.length}</strong><small>agents on the team</small></div><div><strong>${state.stages.length}</strong><small>workflow stages</small></div></div></div></section>`;
  const stage = activeStage();
  const completed = run.status === "completed";
  return `<section class="panel"><div class="panel-heading"><h2><span class="mini-icon">▤</span>Team task</h2>${pill(completed ? "Completed" : run.phase === "approval" ? "Needs you" : "Simulating", run.phase === "approval" ? "amber" : "green")}</div><div class="card-body"><div class="task-kicker">DEMO · NO REAL EXECUTION</div><h3 class="task-title">${escape(run.title)}</h3><p>${completed ? "You have completed the team's workflow. No real code or tests were executed." : `Owner: ${escape(state.agents.find(a => a.id === stage.agentId)?.name)}.`}</p><div class="task-stage"><strong>${completed ? "Workflow completed" : escape(stage.label)}</strong><span>${Math.min(run.stageIndex + 1, run.stages.length)}/${run.stages.length} stages</span></div><div class="stage-markers">${run.stages.map((_, index) => `<i class="${index < run.stageIndex ? "done" : index === run.stageIndex ? (run.phase === "approval" ? "current waiting" : "current") : ""}"></i>`).join("")}</div>${run.feedback && !completed ? `<p>Latest feedback: ${escape(run.feedback)}</p>` : ""}
    ${completed ? '<button class="button primary full" data-action="new-demand">Start another task ↗</button>' : `<button class="button ${run.phase === "approval" ? "secondary" : "primary"} full" data-action="advance" ${run.phase === "approval" ? "disabled" : ""}>${run.phase === "approval" ? "Waiting for your decision" : "Simulate stage delivery →"}</button><button class="end-demo" data-action="end-demo">End this demo</button>`}
    <span class="subtle-note">This button advances a simulation. It does not dispatch tools or agents.</span></div></section>`;
}

function decisionCard() {
  const run = state.run;
  if (state.mode === "demo" && run?.phase === "approval") {
    const stage = activeStage();
    const agent = state.agents.find(a => a.id === stage.agentId);
    return `<section class="panel decision-pending"><div class="panel-heading"><h2><span class="mini-icon">◇</span>Your decision</h2>${pill("1 pending", "amber")}</div><div class="card-body"><div class="task-kicker">HUMAN CHECKPOINT</div><h3>${escape(stage.label)} is ready for your review.</h3><p>${escape(agent.name)} has prepared a representation of: ${escape(agent.output)}.</p><span class="subtle-note">Demo deliverable. This is not a generated plan or evidence of a real review.</span><button class="button primary full" data-action="approve">Approve and continue →</button><button class="button secondary full" data-action="request-changes" ${run.fixes >= 3 ? "disabled" : ""}>Request changes${run.fixes ? ` (${run.fixes}/3)` : ""}</button></div></section>`;
  }
  return `<section class="panel"><div class="panel-heading"><h2><span class="mini-icon">◇</span>Your decision inbox</h2><span class="meta">0 pending</span></div><div class="decision-empty"><span class="empty-circle">✓</span><div><strong>${state.mode === "live" ? "Observation only." : "All clear for now."}</strong><p>${state.mode === "live" ? "Real approvals and blockers are handled in the agents' terminals." : "When your team needs a decision, it will appear here."}</p></div></div></section>`;
}

function pipeline() {
  const stages = state.run ? state.run.stages : state.stages;
  return `<section class="panel pipeline-panel"><div class="panel-heading"><h2><span class="mini-icon">⇢</span>The path to delivery</h2><button class="text-link" data-action="workflow">Edit workflow ↗</button></div><div class="pipeline-steps">${stages.map((stage, index) => {
    const run = state.run;
    const current = run && run.status !== "completed" && index === run.stageIndex;
    const completed = run && index < run.stageIndex;
    return `${index ? '<span class="pipeline-arrow" aria-hidden="true">→</span>' : ""}<div class="pipeline-step ${current ? `current ${run.phase === "approval" ? "waiting" : ""}` : completed ? "completed" : ""}" ${current ? 'aria-current="step"' : ""}><span class="step-number">${completed ? "✓" : String(index + 1).padStart(2, "0")}</span><span class="step-info"><strong>${escape(stage.label)}</strong><small>${escape(state.agents.find(a => a.id === stage.agentId)?.name || "Agent")} ${stage.approval ? "· ◇ approval" : ""}</small></span></div>`;
  }).join("")}</div><div class="pipeline-footnote">◇ You decide at checkpoints. Changes return to the previous stage, up to 3 times.</div></section>`;
}

function eventsMarkup(limit = 80) {
  if (!state.events.length) return '<div class="activity-empty">Your next project starts a new story.<br>Start a demo to see its stages and decisions here.</div>';
  return `<div class="event-list">${state.events.slice(0, limit).map(event => `<div class="event-item"><span class="event-dot ${["green", "amber"].includes(event.tone) ? event.tone : ""}"></span><div class="event-copy"><strong>${escape(event.title)}</strong><p>${escape(event.detail)}</p></div><time datetime="${escape(event.time)}">${escape(new Date(event.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }))}</time></div>`).join("")}</div>`;
}

function teamView() {
  const locked = isEditingLocked(state);
  return `${lockBanner()}<section class="panel team-toolbar"><div class="field"><label for="team-name">Team name</label><input id="team-name" maxlength="60" value="${escape(state.teamName)}" ${locked ? "disabled" : ""}></div><p>Instructions and deliverables are saved in this browser.<br>In live mode, links only observe existing sessions.</p></section><div class="team-grid">${state.agents.map(agent => `<article class="panel agent-card"><div class="agent-card-top"><span class="agent-card-avatar"><canvas data-avatar="${escape(agent.id)}"></canvas></span><div><h2>${escape(agent.name)}</h2><div class="role">${escape(agent.role)}</div></div></div><p>${escape(agent.instructions)}</p><div class="card-output"><span>Expected deliverable</span><strong>${escape(agent.output)}</strong></div><button class="button secondary full" data-agent="${escape(agent.id)}">${state.mode === "live" ? "Configure and link" : "Configure agent"} ↗</button></article>`).join("")}<button class="add-agent-card" data-action="add-agent" ${locked || state.agents.length >= 8 ? "disabled" : ""}><span>＋</span><strong>A new talent on the team</strong><small>${state.agents.length}/8 seats filled</small></button></div>`;
}

function workflowView() {
  const locked = isEditingLocked(state);
  return `${lockBanner()}<section class="panel workflow-intro"><div><h2>Editable template</h2><p>One stage at a time. Every delivery has an owner and can require your approval.</p></div><button class="button secondary" data-action="add-stage" ${locked || state.stages.length >= 12 ? "disabled" : ""}>＋ Add stage</button></section><div class="workflow-list">${state.stages.map((stage, index) => `<section class="panel workflow-row" data-stage="${escape(stage.id)}"><span class="workflow-number">${String(index + 1).padStart(2, "0")}</span><div class="field"><label for="stage-label-${index}">Stage</label><input id="stage-label-${index}" data-stage-field="label" maxlength="50" value="${escape(stage.label)}" ${locked ? "disabled" : ""}></div><div class="field owner-field"><label for="stage-owner-${index}">Owner</label><select id="stage-owner-${index}" data-stage-field="agentId" ${locked ? "disabled" : ""}>${state.agents.map(agent => `<option value="${escape(agent.id)}" ${stage.agentId === agent.id ? "selected" : ""}>${escape(agent.name)}</option>`).join("")}</select></div><div class="approval-wrap"><label class="approval-check"><input type="checkbox" data-stage-field="approval" ${stage.approval ? "checked" : ""} ${locked ? "disabled" : ""}>Require my approval</label></div><div class="row-actions"><button data-action="stage-up" aria-label="Move ${escape(stage.label)} up" ${locked || index === 0 ? "disabled" : ""}>↑</button><button data-action="stage-down" aria-label="Move ${escape(stage.label)} down" ${locked || index === state.stages.length - 1 ? "disabled" : ""}>↓</button><button data-action="stage-remove" class="danger" aria-label="Remove ${escape(stage.label)}" ${locked || state.stages.length === 1 ? "disabled" : ""}>×</button></div></section>`).join("")}</div><div class="workflow-note"><strong>How revisions work:</strong> requesting changes at a checkpoint returns the task to the immediately preceding stage. At the first stage, it returns to the same owner. The demo allows up to 3 revision rounds.<br>This editor configures the demo workflow. It does not replace or modify your real harness.</div>`;
}

function activityView() {
  return `<section class="panel"><div class="panel-heading"><h2><span class="mini-icon">◷</span>Demo history</h2>${pill(`${state.events.length} events`, "gray")}</div>${eventsMarkup()}</section>${state.run?.artifacts.length ? `<section class="panel activity-panel"><div class="panel-heading"><h2><span class="mini-icon">▤</span>Represented deliverables</h2><span class="meta">Not real evidence</span></div><div class="artifacts-list">${state.run.artifacts.map(artifact => `<article class="artifact"><strong>${escape(artifact.title)}</strong><small>${escape(artifact.stage)} · simulated representation, no file generated</small></article>`).join("")}</div></section>` : ""}`;
}

function renderAvatars() {
  document.querySelectorAll("canvas[data-avatar]").forEach(canvas => {
    const agent = (view === "office" ? officeState() : state).agents.find(a => a.id === canvas.dataset.avatar);
    if (agent) drawAvatar(canvas, agent);
  });
}

function openAgent(id) {
  if (view === "office" && state.mode === "live" && execution.current && execution.current.status !== "archived") {
    view = "execution"; render(); return;
  }
  const agent = state.agents.find(a => a.id === id);
  if (!agent) return;
  previousFocus = document.activeElement;
  selectedAgent = id;
  selectedColor = agent.color;
  const status = agentStatus(state, id, live);
  const disabled = isEditingLocked(state) ? "disabled" : "";
  const drawer = $("#agent-drawer");
  drawer.innerHTML = `<div class="drawer-header"><span class="eyebrow">A MEMBER OF YOUR TEAM</span><button class="icon-button" id="close-drawer" aria-label="Close panel">×</button></div>
    <div class="drawer-agent"><span class="drawer-avatar"><canvas data-avatar="${escape(id)}"></canvas></span><div><h2 id="drawer-title">${escape(agent.name)}</h2>${pill(agent.role, "gray")}</div></div>
    <div class="drawer-status"><strong id="drawer-live-label">${escape(status.label)}</strong><p id="drawer-live-detail">${escape(status.detail)}</p></div>
    <form id="agent-form"><section class="drawer-section"><h3>Identity</h3>
      <div class="field"><label for="agent-name">Name</label><input id="agent-name" name="name" value="${escape(agent.name)}" maxlength="40" required ${disabled}></div>
      <div class="field"><label for="agent-role">Role</label><input id="agent-role" name="role" value="${escape(agent.role)}" maxlength="60" required ${disabled}></div>
      <div class="field"><label>Character color</label><div class="color-picker">${COLORS.map(color => `<button type="button" class="color-choice ${agent.color === color ? "selected" : ""}" data-color="${color}" style="background:${color}" aria-label="Color ${color}" aria-pressed="${agent.color === color}" ${disabled}></button>`).join("")}</div></div>
    </section><section class="drawer-section"><h3>How they work</h3>
      <div class="field"><label for="agent-instructions">Responsibilities and boundaries</label><textarea id="agent-instructions" name="instructions" rows="4" maxlength="3000" required ${disabled}>${escape(agent.instructions)}</textarea></div>
      <div class="field"><label for="agent-context">Context received</label><textarea id="agent-context" name="context" rows="2" maxlength="1000" required ${disabled}>${escape(agent.context)}</textarea></div>
      <div class="field"><label for="agent-output">Expected deliverable</label><textarea id="agent-output" name="output" rows="2" maxlength="500" required ${disabled}>${escape(agent.output)}</textarea></div>
      <p class="field-hint">Instructions are not a security boundary. They are sent to workers only when you explicitly start a real workflow. Editing this profile does not change an active run's snapshot.</p>
    </section><section class="drawer-section"><h3>Herdr link</h3>
      <div class="field"><label for="agent-binding">Session in this workspace</label><select id="agent-binding" name="binding"><option value="">Not linked · demo only</option>${live.agents.map(session => `<option value="${escape(session.pane_id)}" ${agent.binding === session.pane_id ? "selected" : ""}>${escape(session.name)} · ${escape(session.status)}</option>`).join("")}${agent.binding && !live.agents.some(a => a.pane_id === agent.binding) ? `<option value="${escape(agent.binding)}" selected>${escape(agent.binding)} · no signal</option>` : ""}</select><p class="field-hint">One session per character. Metadata only: no terminal history is collected.</p></div>
    </section><button type="submit" class="button primary full">Save ${disabled ? "link" : "agent"} ✓</button>${!disabled ? '<button type="button" class="end-demo" id="remove-agent">Remove from team</button>' : '<div class="read-only-note">Configuration is protected while a task is active. End the demo to edit this role.</div>'}</form>`;
  drawer.hidden = false;
  $("#drawer-backdrop").hidden = false;
  $(".app-shell").inert = true;
  $(".sidebar").inert = true;
  renderAvatars();
  $("#close-drawer").focus();
}

function closeAgent() {
  $("#agent-drawer").hidden = true;
  $("#drawer-backdrop").hidden = true;
  $(".app-shell").inert = false;
  $(".sidebar").inert = false;
  selectedAgent = null;
  if (previousFocus?.isConnected) previousFocus.focus();
  else $("#main").focus();
}

function showDemand() {
  if (state.mode !== "demo") return notify("Switch to the interactive demo to simulate a task.");
  if (isEditingLocked(state)) return notify("Complete or end the current task first.", true);
  $("#demand-input").value = "";
  $("#demand-dialog").showModal();
  $("#demand-input").focus();
}

function editConfiguration(operation) {
  if (isEditingLocked(state)) throw new Error("Complete or end the task before editing.");
  const draft = structuredClone(state);
  operation(draft);
  const errors = validateConfiguration(draft);
  if (errors.length) throw new Error(errors[0]);
  state = draft;
}

$("#content").addEventListener("click", event => {
  const agentButton = event.target.closest("[data-agent]");
  if (agentButton) return openAgent(agentButton.dataset.agent);
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (["team", "workflow", "activity", "execution"].includes(action)) { view = action; render(); return; }
  if (action === "new-demand") return showDemand();
  if (action === "advance") return act(() => advanceRun(state));
  if (action === "approve") return act(() => approveRun(state), "Decision recorded. The next stage can begin.");
  if (action === "request-changes") {
    $("#feedback-input").value = "";
    $("#feedback-dialog").showModal();
    $("#feedback-input").focus();
    return;
  }
  if (action === "end-demo") return act(() => { state.run = null; }, "Demo ended. Your history has been kept.");
  if (action === "add-agent") {
    let id;
    act(() => editConfiguration(draft => {
      id = `agent-${crypto.randomUUID().slice(0, 8)}`;
      draft.agents.push({ id, name: "New agent", role: "Specialist", color: COLORS[draft.agents.length % COLORS.length], instructions: "Investigate the assigned task, communicate limitations, and provide evidence.", output: "A report with results and next steps", context: "Task and context shared by the team", binding: "" });
    }));
    if (id && state.agents.some(a => a.id === id)) openAgent(id);
    return;
  }
  if (action === "add-stage") return act(() => editConfiguration(draft => draft.stages.push({ id: `stage-${crypto.randomUUID().slice(0, 8)}`, label: "New stage", agentId: draft.agents[0].id, approval: false })), "Stage added. Choose its owner and approval checkpoint.");
  if (action.startsWith("stage-")) {
    const id = button.closest("[data-stage]").dataset.stage;
    act(() => editConfiguration(draft => {
      const index = draft.stages.findIndex(s => s.id === id);
      if (action === "stage-remove") draft.stages.splice(index, 1);
      else {
        const target = index + (action === "stage-up" ? -1 : 1);
        if (target >= 0 && target < draft.stages.length) [draft.stages[index], draft.stages[target]] = [draft.stages[target], draft.stages[index]];
      }
    }));
  }
});

$("#content").addEventListener("change", event => {
  if (event.target.id === "team-name") return act(() => editConfiguration(draft => { draft.teamName = event.target.value.trim(); }), "Team name saved.");
  const field = event.target.dataset.stageField;
  if (field) {
    const id = event.target.closest("[data-stage]").dataset.stage;
    act(() => editConfiguration(draft => {
      draft.stages.find(stage => stage.id === id)[field] = field === "approval" ? event.target.checked : event.target.value.trim();
    }));
  }
});

document.querySelectorAll("nav [data-view]").forEach(button => button.addEventListener("click", () => { view = button.dataset.view; render(); }));
$("#workspace-card").addEventListener("click", () => { view = "team"; render(); });
$("#new-demand").addEventListener("click", showDemand);
$("#close-demand").addEventListener("click", () => $("#demand-dialog").close());
$("#example-demand").addEventListener("click", () => { $("#demand-input").value = "Add dark mode to the settings page, with tests and an independent review."; $("#demand-input").focus(); });
$("#demand-form").addEventListener("submit", event => {
  event.preventDefault();
  act(() => { startRun(state, $("#demand-input").value); $("#demand-dialog").close(); view = "office"; });
});
$("#close-feedback").addEventListener("click", () => $("#feedback-dialog").close());
$("#feedback-form").addEventListener("submit", event => {
  event.preventDefault();
  act(() => { requestChanges(state, $("#feedback-input").value); $("#feedback-dialog").close(); }, "Feedback recorded. The task has returned to the previous stage.");
});
$("#motion-toggle").addEventListener("click", () => act(() => { state.reducedMotion = !state.reducedMotion; }));
$("#mode-demo").addEventListener("click", () => act(() => { state.mode = "demo"; }));
$("#mode-live").addEventListener("click", () => { act(() => { state.mode = "live"; }); refreshLive(); });
$("#drawer-backdrop").addEventListener("click", closeAgent);
$("#agent-drawer").addEventListener("click", event => {
  if (event.target.closest("#close-drawer")) return closeAgent();
  const color = event.target.closest("[data-color]");
  if (color && !color.disabled) {
    selectedColor = color.dataset.color;
    document.querySelectorAll("[data-color]").forEach(button => {
      button.classList.toggle("selected", button.dataset.color === selectedColor);
      button.setAttribute("aria-pressed", button.dataset.color === selectedColor);
    });
  }
  if (event.target.closest("#remove-agent")) {
    const id = selectedAgent;
    try {
      if (state.stages.some(stage => stage.agentId === id)) throw new Error("This agent owns a workflow stage. Assign another owner before removing them.");
      editConfiguration(draft => { draft.agents = draft.agents.filter(agent => agent.id !== id); });
      save(); closeAgent(); render(); notify("Agent removed from the local configuration.");
    } catch (error) { notify(error.message, true); }
  }
});
$("#agent-drawer").addEventListener("submit", event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const agent = state.agents.find(a => a.id === selectedAgent);
  const binding = form.get("binding") || "";
  try {
    if (binding && state.agents.some(a => a.id !== agent.id && a.binding === binding)) throw new Error("This session is already linked to another character.");
    if (isEditingLocked(state)) agent.binding = binding;
    else editConfiguration(draft => {
      const updated = draft.agents.find(a => a.id === agent.id);
      for (const key of ["name", "role", "instructions", "context", "output"]) updated[key] = form.get(key).trim();
      updated.color = selectedColor;
      updated.binding = binding;
    });
    save(); closeAgent(); render(); notify("Agent saved. No prompts were sent to Herdr.");
  } catch (error) { notify(error.message, true); }
});
document.addEventListener("keydown", event => {
  if (!selectedAgent) return;
  if (event.key === "Escape") { event.preventDefault(); closeAgent(); }
  if (event.key === "Tab") {
    const focusable = [...$("#agent-drawer").querySelectorAll("button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)")];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
    if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
  }
});
$("#export-config").addEventListener("click", () => {
  const config = { version: 1, language: "en", teamName: state.teamName, reducedMotion: state.reducedMotion, mode: "demo", agents: state.agents.map(agent => ({ ...agent, binding: "" })), stages: state.stages, run: null, events: [] };
  const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "herdr-office-team.json"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("Team exported without history or local session links.");
});

function updateConnection() {
  const element = $("#connection-label");
  element.classList.toggle("offline", !live.connected);
  element.replaceChildren();
  element.append(document.createElement("i"), document.createTextNode(live.connected ? `Herdr connected · ${live.workspace}` : "Herdr disconnected"));
  if ($("#live-summary")) $("#live-summary").textContent = live.message;
  if ($("#live-agent-count")) $("#live-agent-count").textContent = live.connected ? live.agents.length : "—";
  if (state.mode === "live") {
    const scene = officeState();
    document.querySelectorAll("[data-status]").forEach(element => {
      const status = agentStatus(scene, element.dataset.status, live);
      element.className = status.key;
      element.replaceChildren(document.createElement("i"), document.createTextNode(status.label));
      element.closest("button").setAttribute("aria-label", `Open ${scene.agents.find(a => a.id === element.dataset.status)?.name}: ${status.label}`);
    });
  }
  if (selectedAgent) {
    const status = agentStatus(state, selectedAgent, live);
    $("#drawer-live-label").textContent = status.label;
    $("#drawer-live-detail").textContent = status.detail;
  }
}

async function refreshLive() {
  if (fetching) return;
  fetching = true;
  try {
    const response = await fetch("/api/herdr/agents", { signal: AbortSignal.timeout(7000), cache: "no-store" });
    if (!response.ok) throw new Error("Connection failed");
    const data = await response.json();
    if (!Array.isArray(data.agents) || typeof data.connected !== "boolean") throw new Error("Invalid response");
    live = data;
  } catch {
    live = { connected: false, agents: [], workspace: "", message: "No signal from Herdr. No activity will be assumed." };
  } finally {
    fetching = false;
    updateConnection();
  }
}

window.addEventListener("storage", event => {
  if (event.key === STORAGE_KEY) notify("The configuration changed in another tab. Reload before editing to avoid overwriting changes.", true);
});
render();
execution.startPolling();
window.addEventListener("workflow-update", () => { if (view === "office" && state.mode === "live" && !selectedAgent) render(); });
refreshLive();
setInterval(() => { if (!document.hidden) refreshLive(); }, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLive(); });
