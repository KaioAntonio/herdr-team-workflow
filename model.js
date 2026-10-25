import { migrateLegacyState } from "./migration.js";

export const COLORS = ["#57896d", "#aa86bc", "#d59b56", "#648ca9", "#c27a86", "#839b54", "#a28871", "#7a8fbb"];

export function initialState() {
  return {
    version: 1, language: "en", mode: "demo", teamName: "Product studio", reducedMotion: false,
    agents: [
      { id: "head", name: "Head", role: "Coordination", color: COLORS[0], instructions: "Receive the task, coordinate the team, and escalate decisions. Do not implement or approve work on the user's behalf.", output: "Direction and an execution summary", context: "Task and team deliverables", binding: "" },
      { id: "planner", name: "Planner", role: "Planning", color: COLORS[1], instructions: "Investigate the context, propose an approach, and identify risks and checks. Wait for approval before implementation.", output: "A plan with scope, risks, and a test strategy", context: "Task and project context", binding: "" },
      { id: "implementer", name: "Implementer", role: "Implementation", color: COLORS[2], instructions: "Execute the approved plan and address review findings. Report what was verified and what remains blocked.", output: "Changes and verification evidence", context: "Approved plan and review feedback", binding: "" },
      { id: "reviewer", name: "Reviewer", role: "Review", color: COLORS[3], instructions: "Independently review the deliverables and run the relevant checks. Do not modify the implementation.", output: "A review with evidence and findings", context: "Plan, changes, and implementation evidence", binding: "" }
    ],
    stages: [
      { id: "plan", label: "Planning", agentId: "planner", approval: true },
      { id: "build", label: "Implementation", agentId: "implementer", approval: false },
      { id: "review", label: "Review", agentId: "reviewer", approval: true }
    ],
    run: null, events: []
  };
}

const text = (value, limit) => typeof value === "string" && value.trim().length > 0 && value.length <= limit;

export function validateConfiguration(state) {
  const errors = [];
  if (!text(state.teamName, 60)) errors.push("Invalid team name.");
  if (!Array.isArray(state.agents) || !state.agents.length || state.agents.length > 8) return [...errors, "Use between 1 and 8 agents."];
  const ids = new Set();
  for (const agent of state.agents) {
    if (!agent || !text(agent.id, 80) || ids.has(agent.id)) errors.push("Invalid or duplicate agent identifier.");
    ids.add(agent?.id);
    if (!agent || !text(agent.name, 40) || !text(agent.role, 60) || !text(agent.instructions, 3000) || !text(agent.output, 500) || !text(agent.context, 1000) || !/^#[a-fA-F0-9]{6}$/.test(agent.color) || typeof agent.binding !== "string" || agent.binding.length > 100) errors.push("Invalid agent profile.");
  }
  if (!Array.isArray(state.stages) || !state.stages.length || state.stages.length > 12) return [...errors, "Use between 1 and 12 stages."];
  const stages = new Set();
  for (const stage of state.stages) {
    if (!stage || !text(stage.id, 80) || stages.has(stage.id) || !text(stage.label, 50) || !ids.has(stage.agentId) || typeof stage.approval !== "boolean") errors.push("Invalid stage: check its owner and name.");
    stages.add(stage?.id);
  }
  return errors;
}

export function isEditingLocked(state) {
  return Boolean(state.run && state.run.status !== "completed");
}

function log(state, title, detail, tone = "neutral") {
  state.events.unshift({ id: crypto.randomUUID(), title, detail, tone, time: new Date().toISOString() });
  state.events = state.events.slice(0, 80);
}

export function startRun(state, title) {
  if (state.mode !== "demo") throw new Error("Execution is available in demo mode only.");
  if (isEditingLocked(state)) throw new Error("A task is already active.");
  if (!text(title, 500)) throw new Error("Describe a task using up to 500 characters.");
  if (validateConfiguration(state).length) throw new Error("Invalid configuration. Check your team and workflow.");
  state.run = { id: crypto.randomUUID(), title: title.trim(), status: "running", phase: "working", stageIndex: 0, fixes: 0, feedback: "", stages: structuredClone(state.stages), startedAt: new Date().toISOString(), artifacts: [] };
  log(state, "Task received", title.trim(), "green");
  log(state, "Stage started", state.stages[0].label);
}

function activeRun(state) {
  if (state.mode !== "demo") throw new Error("Live mode is read-only.");
  if (!isEditingLocked(state)) throw new Error("There is no active run.");
  return state.run;
}

function finishStage(state) {
  const run = state.run;
  const stage = run.stages[run.stageIndex];
  run.artifacts.push({ stage: stage.label, agentId: stage.agentId, title: state.agents.find(a => a.id === stage.agentId)?.output || stage.label, simulated: true, time: new Date().toISOString() });
  run.stageIndex++;
  if (run.stageIndex === run.stages.length) {
    run.status = "completed";
    run.phase = "completed";
    log(state, "Demo completed", "The workflow is complete. No real code or tests were executed.", "green");
  } else {
    run.status = "running";
    run.phase = "working";
    log(state, "Stage started", run.stages[run.stageIndex].label);
  }
}

export function advanceRun(state) {
  const run = activeRun(state);
  if (run.phase !== "working") throw new Error("Waiting for approval. Resolve the decision before continuing.");
  const stage = run.stages[run.stageIndex];
  log(state, "Simulated delivery", `${stage.label} · no tools executed`);
  if (stage.approval) {
    run.phase = "approval";
    run.status = "waiting";
    log(state, "Your decision is needed", stage.label, "amber");
  } else finishStage(state);
}

export function approveRun(state) {
  const run = activeRun(state);
  if (run.phase !== "approval") throw new Error("There is no pending approval.");
  log(state, "Stage approved by you", run.stages[run.stageIndex].label, "green");
  finishStage(state);
}

export function requestChanges(state, reason) {
  const run = activeRun(state);
  if (run.phase !== "approval") throw new Error("Changes require an approval checkpoint.");
  if (!text(reason, 500)) throw new Error("Enter a reason for the changes using up to 500 characters.");
  if (run.fixes >= 3) throw new Error("The limit of 3 revision rounds has been reached. End this demo and review the workflow.");
  run.feedback = reason.trim();
  run.fixes++;
  run.stageIndex = Math.max(0, run.stageIndex - 1);
  run.phase = "working";
  run.status = "running";
  log(state, "Changes requested", reason.trim(), "amber");
  log(state, "Stage resumed", run.stages[run.stageIndex].label);
}

export function agentStatus(state, agentId, live = {}) {
  const agent = state.agents.find(a => a.id === agentId);
  if (state.mode === "live") {
    if (!agent?.binding) return { key: "unbound", label: "Not linked", detail: "Choose a session from this workspace." };
    const connected = live.connected && live.agents?.find(a => a.pane_id === agent.binding);
    if (!connected) return { key: "unknown", label: "No signal", detail: "The session state could not be confirmed." };
    const statuses = {
      working: { key: "working", label: "Working", detail: "State reported by Herdr. This does not confirm a stage is complete." },
      idle: { key: "idle", label: "Available", detail: "The session is idle. No deliverable has been validated." },
      done: { key: "idle", label: "Turn finished", detail: "A finished turn does not mean an approved task." },
      blocked: { key: "blocked", label: "Blocked", detail: "The session needs attention in its terminal." }
    };
    return statuses[connected.status] || { key: "unknown", label: "Unknown", detail: "Herdr has not confirmed the state." };
  }
  const run = state.run;
  if (!run) return { key: "idle", label: "Available", detail: "Ready for the next task." };
  if (run.status === "completed") return { key: "idle", label: "Available", detail: "Demo completed." };
  const stage = run.stages[run.stageIndex];
  if (stage.agentId === agentId) return run.phase === "approval"
    ? { key: "approval", label: "Needs you", detail: `${stage.label}: simulated delivery awaiting approval.` }
    : { key: "working", label: "Simulating", detail: `${stage.label} · simulated activity, no real execution.` };
  const first = state.agents[0]?.id === agentId;
  return { key: first ? "coordinating" : "waiting", label: first ? "Coordinating" : "Waiting", detail: `Waiting for ${stage.label.toLowerCase()}.` };
}

export function restoreState(raw) {
  const fallback = initialState();
  try {
    const saved = migrateLegacyState(JSON.parse(raw), fallback);
    if (!saved || saved.version !== 1 || validateConfiguration(saved).length) return fallback;
    const state = {
      version: 1, language: "en", teamName: saved.teamName, agents: saved.agents, stages: saved.stages,
      mode: saved.mode === "live" ? "live" : "demo", reducedMotion: saved.reducedMotion === true,
      events: Array.isArray(saved.events) ? saved.events.filter(e => e && text(e.title, 100) && typeof e.detail === "string" && e.detail.length <= 1000 && !Number.isNaN(Date.parse(e.time))).slice(0, 80) : [],
      run: null
    };
    const run = saved.run;
    if (run && ["running", "waiting", "completed"].includes(run.status) && text(run.title, 500)
      && Number.isInteger(run.stageIndex) && Number.isInteger(run.fixes) && run.fixes >= 0 && run.fixes <= 3
      && !validateConfiguration({ ...state, stages: run.stages }).length
      && run.stageIndex >= 0 && run.stageIndex <= run.stages.length
      && ((run.status === "completed" && run.phase === "completed" && run.stageIndex === run.stages.length)
        || (run.status === "running" && run.phase === "working" && run.stageIndex < run.stages.length)
        || (run.status === "waiting" && run.phase === "approval" && run.stageIndex < run.stages.length && run.stages[run.stageIndex].approval))) {
      state.run = { ...run, feedback: typeof run.feedback === "string" ? run.feedback.slice(0, 500) : "", artifacts: Array.isArray(run.artifacts) ? run.artifacts.filter(a => a && text(a.stage, 50) && text(a.title, 500) && a.simulated === true).slice(0, 60) : [] };
    }
    return state;
  } catch {
    return fallback;
  }
}
