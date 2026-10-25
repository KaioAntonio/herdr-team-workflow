import { validateConfiguration } from "./model.js";

export const WORKFLOWS = [
  { id: "current", title: "Current workflow", description: "Use your team and stages from the Workflow editor.", badge: "YOUR CONFIGURATION" },
  { id: "reviewed-delivery", title: "Plan, build & review", description: "Approve the plan, then let implementation, verification, and independent review run. No final human checkpoint.", badge: "PLAN APPROVAL" },
  { id: "human-delivery", title: "Human-approved delivery", description: "Approve the plan and personally accept the verified, independently reviewed delivery.", badge: "TWO HUMAN CHECKPOINTS" }
];

export function workflowIssue(config) {
  const errors = validateConfiguration(config);
  if (errors.length) return errors[0];
  if (config.agents.length < 3) return "Configure at least three agents before running a workflow.";
  if (config.stages.length !== 3 || config.stages.map(stage => stage.id).join(",") !== "plan,build,review") return "Real execution supports Planning → Implementation → Review. Choose a compatible preset or adjust your stages.";
  if (!config.stages[0].approval) return "Plan approval is mandatory for real execution.";
  if (config.stages[1].approval) return "The implementation-to-review handoff must be automatic.";
  if (config.stages[1].agentId === config.stages[2].agentId) return "Choose an independent reviewer, different from the implementer.";
  return "";
}

export function selectWorkflow(configuration, id) {
  if (!WORKFLOWS.some(item => item.id === id)) throw new Error("Unknown workflow selection.");
  const config = structuredClone({
    teamName: configuration.teamName,
    agents: configuration.agents,
    stages: configuration.stages
  });
  if (id !== "current") {
    if (!Array.isArray(config.agents) || config.agents.length < 3) throw new Error("Configure at least three agents before choosing a preset.");
    const used = new Set();
    config.stages = ["plan", "build", "review"].map((phase, index) => {
      const existing = configuration.stages?.find(stage => stage.id === phase)?.agentId;
      const preferred = ["planner", "implementer", "reviewer"][index];
      const owner = [existing, preferred, ...config.agents.map(agent => agent.id)]
        .find(agentId => config.agents.some(agent => agent.id === agentId) && !used.has(agentId));
      used.add(owner);
      return { id: phase, label: ["Planning", "Implementation", "Review"][index],
        agentId: owner, approval: index === 0 || (index === 2 && id === "human-delivery") };
    });
  }
  const issue = workflowIssue(config);
  if (issue) throw new Error(issue);
  return config;
}
