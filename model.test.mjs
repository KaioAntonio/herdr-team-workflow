import test from "node:test";
import assert from "node:assert/strict";
import { initialState, validateConfiguration, startRun, advanceRun, approveRun, requestChanges, agentStatus, restoreState, isEditingLocked } from "./model.js";

test("the default team and workflow are valid", () => {
  const state = initialState();
  assert.equal(state.agents.length, 4);
  assert.deepEqual(validateConfiguration(state), []);
  assert.equal(state.run, null);
});

test("blank demands cannot start a run", () => {
  assert.throws(() => startRun(initialState(), "  "), /task/i);
});

test("live mode cannot simulate a run", () => {
  const state = initialState();
  state.mode = "live";
  assert.throws(() => startRun(state, "Task"), /demo/i);
});

test("one active demand per team", () => {
  const state = initialState();
  startRun(state, "First");
  assert.throws(() => startRun(state, "Second"), /active/i);
  assert.equal(state.run.title, "First");
  assert.equal(isEditingLocked(state), true);
});

test("a plan stops at human approval", () => {
  const state = initialState();
  startRun(state, "Build something");
  advanceRun(state);
  assert.equal(state.run.phase, "approval");
  assert.equal(state.run.stageIndex, 0);
  assert.equal(agentStatus(state, "planner").key, "approval");
  assert.throws(() => advanceRun(state), /approval/i);
  approveRun(state);
  assert.equal(state.run.stageIndex, 1);
  assert.equal(state.run.phase, "working");
});

test("review corrections go back to implementation and then review", () => {
  const state = initialState();
  startRun(state, "Task");
  advanceRun(state);
  approveRun(state);
  advanceRun(state);
  advanceRun(state);
  requestChanges(state, "Handle disconnected agents");
  assert.equal(state.run.stageIndex, 1);
  assert.equal(state.run.fixes, 1);
  assert.equal(state.run.feedback, "Handle disconnected agents");
  advanceRun(state);
  assert.equal(state.run.stageIndex, 2);
  advanceRun(state);
  approveRun(state);
  assert.equal(state.run.status, "completed");
  assert.equal(isEditingLocked(state), false);
});

test("corrections require a reason and an approval checkpoint", () => {
  const state = initialState();
  startRun(state, "Task");
  assert.throws(() => requestChanges(state, "Fix"), /approval/i);
  advanceRun(state);
  assert.throws(() => requestChanges(state, " "), /reason/i);
  requestChanges(state, "More detail");
  assert.equal(state.run.stageIndex, 0);
  assert.equal(state.run.phase, "working");
});

test("approval cannot skip active work", () => {
  const state = initialState();
  startRun(state, "Task");
  assert.throws(() => approveRun(state), /approval/i);
  assert.equal(state.run.stageIndex, 0);
});

test("workflow owners and duplicate ids are validated", () => {
  const state = initialState();
  state.stages[0].agentId = "missing";
  state.agents[1].id = state.agents[0].id;
  assert.ok(validateConfiguration(state).length >= 2);
  assert.throws(() => startRun(state, "Task"), /invalid/i);
});

test("completed runs can be followed by another run", () => {
  const state = initialState();
  state.stages = [{ id: "single", label: "Research", agentId: "planner", approval: false }];
  startRun(state, "One");
  advanceRun(state);
  assert.equal(state.run.status, "completed");
  startRun(state, "Two");
  assert.equal(state.run.title, "Two");
  assert.equal(state.run.phase, "working");
});

test("saved approval checkpoints survive reload", () => {
  const state = initialState();
  startRun(state, "Persist me");
  advanceRun(state);
  const restored = restoreState(JSON.stringify(state));
  assert.equal(restored.run.phase, "approval");
  assert.equal(restored.run.title, "Persist me");
});

test("corrupt and structurally invalid storage recovers safely", () => {
  for (const value of ["{", "null", "[]", "{}", '{"version":1,"agents":[]}']) {
    assert.equal(restoreState(value).agents.length, 4);
  }
  const state = initialState();
  state.run = { status: "running", stageIndex: 999 };
  assert.equal(restoreState(JSON.stringify(state)).run, null);
});

test("live status is mapped only from explicit bindings", () => {
  const state = initialState();
  state.mode = "live";
  state.agents[0].binding = "wB:p1";
  const live = { connected: true, agents: [{ pane_id: "wB:p1", status: "working" }] };
  assert.equal(agentStatus(state, "head", live).key, "working");
  assert.equal(agentStatus(state, "planner", live).key, "unbound");
  assert.equal(agentStatus(state, "head", { connected: false, agents: live.agents }).key, "unknown");
  assert.equal(agentStatus(state, "head", { connected: true, agents: [] }).key, "unknown");
});

test("an idle or done live agent does not approve a workflow", () => {
  const state = initialState();
  startRun(state, "Task");
  state.mode = "live";
  state.agents[1].binding = "wB:p2";
  assert.equal(agentStatus(state, "planner", { connected: true, agents: [{ pane_id: "wB:p2", status: "done" }] }).key, "idle");
  assert.equal(state.run.stageIndex, 0);
  assert.equal(state.run.phase, "working");
});

test("run workflow snapshots cannot be changed by later configuration mutation", () => {
  const state = initialState();
  startRun(state, "Task");
  state.stages[0].approval = false;
  advanceRun(state);
  assert.equal(state.run.phase, "approval");
});

test("correction rounds have a fixed limit", () => {
  const state = initialState();
  startRun(state, "Task");
  for (let i = 0; i < 3; i++) {
    advanceRun(state);
    requestChanges(state, `Revision ${i}`);
  }
  advanceRun(state);
  assert.throws(() => requestChanges(state, "Again"), /limit/i);
  assert.equal(state.run.phase, "approval");
  approveRun(state);
  assert.equal(state.run.stageIndex, 1);
});

test("malformed approval and completion states do not resume", () => {
  const state = initialState();
  startRun(state, "Task");
  for (const patch of [
    { status: "waiting", phase: "working" },
    { status: "completed", phase: "completed", stageIndex: 0 },
    { status: "running", phase: "working", stageIndex: -1 },
    { fixes: 10 },
    { stages: [] }
  ]) {
    assert.equal(restoreState(JSON.stringify({ ...state, run: { ...state.run, ...patch } })).run, null);
  }
});

test("there is no implicit approval when switching to live mode", () => {
  const state = initialState();
  startRun(state, "Task");
  advanceRun(state);
  state.mode = "live";
  assert.throws(() => approveRun(state), /read-only/i);
  assert.throws(() => advanceRun(state), /read-only/i);
  assert.throws(() => requestChanges(state, "Fix"), /read-only/i);
  assert.equal(state.run.phase, "approval");
});

test("team size and workflow size are bounded", () => {
  const state = initialState();
  state.agents = [];
  assert.ok(validateConfiguration(state).length);
  state.agents = initialState().agents;
  state.stages = [];
  assert.ok(validateConfiguration(state).length);
  state.stages = Array.from({ length: 13 }, (_, i) => ({ id: String(i), label: "Step", agentId: "head", approval: false }));
  assert.ok(validateConfiguration(state).length);
});

test("legacy defaults migrate to English without losing a pending decision", () => {
  const state = initialState();
  startRun(state, "My existing task");
  advanceRun(state);
  delete state.language;
  state.agents[0].role = "Coordenação";
  state.agents[1].role = "Planejamento";
  state.agents[1].output = "Plano com escopo, riscos e estratégia de testes";
  state.stages[0].label = "Planejamento";
  state.run.stages[0].label = "Planejamento";
  state.run.artifacts = [{ stage: "Planejamento", agentId: "planner", title: "Plano com escopo, riscos e estratégia de testes", simulated: true }];
  state.events = [
    { title: "Etapa iniciada", detail: "Planejamento", time: new Date().toISOString() },
    { title: "Entrega simulada", detail: "Planejamento · sem execução de ferramentas", time: new Date().toISOString() }
  ];
  const restored = restoreState(JSON.stringify(state));
  assert.equal(restored.language, "en");
  assert.equal(restored.agents[0].role, "Coordination");
  assert.equal(restored.agents[1].output, initialState().agents[1].output);
  assert.equal(restored.stages[0].label, "Planning");
  assert.equal(restored.run.stages[0].label, "Planning");
  assert.equal(restored.run.phase, "approval");
  assert.equal(restored.run.artifacts[0].title, initialState().agents[1].output);
  assert.equal(restored.events[0].title, "Stage started");
  assert.equal(restored.events[1].detail, "Planning · no tools executed");
});

test("migration preserves user-authored names, instructions, tasks, and feedback", () => {
  const state = initialState();
  delete state.language;
  state.teamName = "Meu estúdio";
  state.agents[0].name = "Minha líder";
  state.agents[0].instructions = "Preserve minhas instruções personalizadas.";
  state.agents[1].role = "Arquiteta";
  state.stages[0].label = "Minha etapa";
  startRun(state, "Minha demanda pessoal");
  advanceRun(state);
  state.run.feedback = "Meu feedback";
  state.events.unshift({ title: "Demanda recebida", detail: "Minha demanda pessoal", time: new Date().toISOString() });
  const restored = restoreState(JSON.stringify(state));
  assert.equal(restored.teamName, "Meu estúdio");
  assert.equal(restored.agents[0].name, "Minha líder");
  assert.equal(restored.agents[0].instructions, state.agents[0].instructions);
  assert.equal(restored.agents[1].role, "Arquiteta");
  assert.equal(restored.stages[0].label, "Minha etapa");
  assert.equal(restored.run.title, "Minha demanda pessoal");
  assert.equal(restored.run.feedback, "Meu feedback");
  assert.equal(restored.events[0].detail, "Minha demanda pessoal");
});

test("English state does not remigrate deliberately customized text", () => {
  const state = initialState();
  state.agents[0].role = "Coordenação";
  assert.equal(restoreState(JSON.stringify(state)).agents[0].role, "Coordenação");
});

test("untouched generated profiles and the example task migrate too", () => {
  const state = initialState();
  delete state.language;
  state.agents.push({
    id: "agent-1234", name: "Novo agente", role: "Especialista", color: "#57896d", binding: "",
    instructions: "Investigar a tarefa atribuída, comunicar limitações e entregar evidências.",
    output: "Relatório com resultados e próximos passos", context: "Demanda e contexto compartilhado pela equipe"
  });
  state.stages.push({ id: "stage-1234", label: "Nova etapa", agentId: "agent-1234", approval: false });
  startRun(state, "Adicionar modo escuro à página de configurações, com testes e revisão independente.");
  const restored = restoreState(JSON.stringify(state));
  assert.equal(restored.agents.at(-1).name, "New agent");
  assert.equal(restored.agents.at(-1).role, "Specialist");
  assert.equal(restored.stages.at(-1).label, "New stage");
  assert.equal(restored.run.title, "Add dark mode to the settings page, with tests and an independent review.");
  assert.deepEqual(restoreState(JSON.stringify(restored)), restored);
});
