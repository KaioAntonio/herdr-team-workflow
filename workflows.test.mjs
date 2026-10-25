import assert from "node:assert/strict";
import test from "node:test";
import { initialState } from "./model.js";
import { WORKFLOWS, selectWorkflow, workflowIssue } from "./workflows.js";

test("the picker exposes only the current workflow and executable approval variants", () => {
  assert.deepEqual(WORKFLOWS.map(item => item.id), ["current", "reviewed-delivery", "human-delivery"]);
});

test("the current workflow keeps customized names and approvals", () => {
  const state = initialState();
  state.stages[0].label = "Scope investigation";
  const selected = selectWorkflow(state, "current");
  assert.deepEqual(selected.stages, state.stages);
  assert.equal(workflowIssue(selected), "");
});

test("reviewed delivery still requires plan approval and an independent reviewer", () => {
  const selected = selectWorkflow(initialState(), "reviewed-delivery");
  assert.deepEqual(selected.stages.map(stage => stage.approval), [true, false, false]);
  assert.notEqual(selected.stages[1].agentId, selected.stages[2].agentId);
});

test("human-approved delivery requires final acceptance as well as plan approval", () => {
  const selected = selectWorkflow(initialState(), "human-delivery");
  assert.deepEqual(selected.stages.map(stage => stage.approval), [true, false, true]);
});

test("choosing a preset preserves the team without changing configuration or an existing run", () => {
  const state = initialState();
  state.agents[1].instructions = "Preserve my custom planning instructions.";
  state.run = { status: "running", stages: structuredClone(state.stages) };
  const original = structuredClone(state);
  const selected = selectWorkflow(state, "reviewed-delivery");
  assert.deepEqual(selected.agents, state.agents);
  selected.agents[1].instructions = "Changed snapshot";
  assert.deepEqual(state, original);
  assert.equal("run" in selected, false);
});

test("unsupported current workflows remain blocked rather than silently losing stages", () => {
  const state = initialState();
  state.stages.push({ id: "extra", label: "Extra", agentId: "head", approval: false });
  assert.match(workflowIssue(state), /Planning/);
  assert.throws(() => selectWorkflow(state, "current"), /Planning/);
  assert.equal(selectWorkflow(state, "human-delivery").stages.length, 3);
  assert.equal(state.stages.length, 4);
});

test("presets use customized owners and give renamed teams independent workers", () => {
  const state = initialState();
  for (const [index, agent] of state.agents.entries()) {
    const old = agent.id;
    agent.id = `custom-${index}`;
    for (const stage of state.stages) if (stage.agentId === old) stage.agentId = agent.id;
  }
  const selected = selectWorkflow(state, "reviewed-delivery");
  assert.deepEqual(selected.stages.map(stage => stage.agentId), ["custom-1", "custom-2", "custom-3"]);
  state.stages[2].agentId = state.stages[1].agentId;
  assert.notEqual(selectWorkflow(state, "human-delivery").stages[1].agentId,
    selectWorkflow(state, "human-delivery").stages[2].agentId);
});

test("invalid profiles, insufficient workers, unknown choices, and unsafe checkpoints are rejected", () => {
  const state = initialState();
  assert.throws(() => selectWorkflow(state, "unknown"), /Unknown workflow/);
  state.stages[0].approval = false;
  assert.match(workflowIssue(state), /Plan approval/);
  state.stages[0].approval = true;
  state.stages[1].approval = true;
  assert.match(workflowIssue(state), /handoff/);
  state.stages[1].approval = false;
  state.agents[1].instructions = "";
  assert.throws(() => selectWorkflow(state, "human-delivery"), /profile/);
  state.agents = state.agents.slice(0, 2);
  assert.throws(() => selectWorkflow(state, "human-delivery"), /three/);
});
