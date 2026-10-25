const legacyAgents = {
  head: {
    role: "Coordenação",
    instructions: "Receber a demanda, coordenar a equipe e escalar decisões. Não implementar nem aprovar em nome do usuário.",
    output: "Direcionamento e resumo da execução",
    context: "Demanda e entregas da equipe"
  },
  planner: {
    role: "Planejamento",
    instructions: "Investigar o contexto, propor uma abordagem e explicitar riscos e verificações. Aguardar aprovação antes da implementação.",
    output: "Plano com escopo, riscos e estratégia de testes",
    context: "Demanda e contexto do projeto"
  },
  implementer: {
    role: "Implementação",
    instructions: "Executar o plano aprovado e corrigir problemas apontados na revisão. Relatar o que foi verificado e o que ficou bloqueado.",
    output: "Mudanças e evidências de verificação",
    context: "Plano aprovado e feedback da revisão"
  },
  reviewer: {
    role: "Revisão",
    instructions: "Verificar a entrega de forma independente e executar as verificações pertinentes. Não alterar a implementação.",
    output: "Parecer com evidências e problemas encontrados",
    context: "Plano, mudanças e evidências da implementação"
  }
};

const legacyStages = { plan: "Planejamento", build: "Implementação", review: "Revisão" };
const legacyNewAgent = {
  role: ["Especialista", "Specialist"],
  instructions: ["Investigar a tarefa atribuída, comunicar limitações e entregar evidências.", "Investigate the assigned task, communicate limitations, and provide evidence."],
  output: ["Relatório com resultados e próximos passos", "A report with results and next steps"],
  context: ["Demanda e contexto compartilhado pela equipe", "Task and context shared by the team"]
};
const legacyExample = "Adicionar modo escuro à página de configurações, com testes e revisão independente.";
const englishExample = "Add dark mode to the settings page, with tests and an independent review.";
const legacyEvents = new Map([
  ["Demanda recebida", "Task received"],
  ["Etapa iniciada", "Stage started"],
  ["Demonstração concluída", "Demo completed"],
  ["Entrega simulada", "Simulated delivery"],
  ["Sua decisão é necessária", "Your decision is needed"],
  ["Etapa aprovada por você", "Stage approved by you"],
  ["Ajustes solicitados", "Changes requested"],
  ["Etapa retomada", "Stage resumed"]
]);

export function migrateLegacyState(saved, defaults) {
  if (!saved || typeof saved !== "object" || saved.language === "en") return saved;
  const stageLabels = new Map(defaults.stages.map(stage => [legacyStages[stage.id], stage.label]));
  const outputs = new Map(defaults.agents.map(agent => [legacyAgents[agent.id].output, agent.output]));
  for (const agent of Array.isArray(saved.agents) ? saved.agents : []) {
    if (!agent || typeof agent !== "object") continue;
    const old = Object.hasOwn(legacyAgents, agent.id) ? legacyAgents[agent.id] : null;
    const next = defaults.agents.find(item => item.id === agent.id);
    if (old && next) for (const key of Object.keys(old)) if (agent[key] === old[key]) agent[key] = next[key];
    if (typeof agent.id === "string" && agent.id.startsWith("agent-") && Object.entries(legacyNewAgent).every(([key, [value]]) => agent[key] === value)) {
      for (const [key, [, value]] of Object.entries(legacyNewAgent)) agent[key] = value;
      if (agent.name === "Novo agente") agent.name = "New agent";
    }
  }
  for (const stages of [saved.stages, saved.run?.stages]) {
    for (const stage of Array.isArray(stages) ? stages : []) {
      if (stage && Object.hasOwn(legacyStages, stage.id) && stage.label === legacyStages[stage.id]) stage.label = stageLabels.get(stage.label);
      if (stage && typeof stage.id === "string" && stage.id.startsWith("stage-") && stage.label === "Nova etapa") stage.label = "New stage";
    }
  }
  if (saved.run?.title === legacyExample) saved.run.title = englishExample;
  for (const artifact of Array.isArray(saved.run?.artifacts) ? saved.run.artifacts : []) {
    if (!artifact || typeof artifact !== "object") continue;
    if (stageLabels.has(artifact.stage)) artifact.stage = stageLabels.get(artifact.stage);
    if (outputs.has(artifact.title)) artifact.title = outputs.get(artifact.title);
  }
  for (const event of Array.isArray(saved.events) ? saved.events : []) {
    if (!event || typeof event !== "object" || !legacyEvents.has(event.title)) continue;
    const oldTitle = event.title;
    event.title = legacyEvents.get(oldTitle);
    if (oldTitle === "Demanda recebida" && event.detail === legacyExample) event.detail = englishExample;
    if (["Etapa iniciada", "Sua decisão é necessária", "Etapa aprovada por você", "Etapa retomada"].includes(oldTitle) && stageLabels.has(event.detail)) event.detail = stageLabels.get(event.detail);
    if (oldTitle === "Demonstração concluída" && event.detail === "O fluxo terminou. Nenhum código ou teste real foi executado.") event.detail = "The workflow is complete. No real code or tests were executed.";
    if (oldTitle === "Entrega simulada" && typeof event.detail === "string" && event.detail.endsWith(" · sem execução de ferramentas")) {
      const label = event.detail.slice(0, -" · sem execução de ferramentas".length);
      event.detail = `${stageLabels.get(label) || label} · no tools executed`;
    }
  }
  saved.language = "en";
  return saved;
}
