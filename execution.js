const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const statuses = {
  preparing: "Preparing worktree", dispatching: "Confirming dispatch", planning: "Planning",
  awaiting_approval: "Plan needs your approval", implementing: "Implementing",
  verifying: "Running verification commands", reviewing: "Independent review",
  awaiting_acceptance: "Reviewed delivery needs your acceptance", completed: "Verified and reviewed",
  attention: "Operator attention required", stale: "Reviewed result is stale", archived: "Archived"
};
const terminal = new Set(["completed", "stale", "archived"]);

export class Execution {
  constructor(configuration, notify, showOffice) {
    this.configuration = configuration;
    this.notify = notify;
    this.showOffice = showOffice;
    this.runs = [];
    this.token = "";
    this.capabilities = { available: false, message: "Checking the HWF runner…" };
    this.connected = false;
    this.busy = false;
    this.pending = null;
    this.epoch = 0;
    this.draft = { repository: "", task: "", checks: '[["npm", "test"]]', consent: false };
    document.addEventListener("submit", event => {
      if (event.target.id === "execution-start") { event.preventDefault(); this.start(event.target); }
    });
    document.addEventListener("input", event => {
      if (event.target.closest("#execution-start")) this.remember();
      if (event.target.id === "execution-plan-text") {
        const button = document.querySelector("[data-execution-action=approve]");
        if (button) button.disabled = this.busy || event.target.value !== this.current?.plan?.text;
      }
    });
    document.addEventListener("click", event => {
      const button = event.target.closest("[data-execution-action]");
      if (button && !button.disabled) this.action(button.dataset.executionAction);
    });
  }

  get current() { return this.runs[0] || null; }

  remember() {
    const form = document.querySelector("#execution-start");
    if (form) this.draft = Object.fromEntries(["repository", "task", "checks"].map(key => [key, form.elements[key].value]).concat([["consent", form.elements.consent.checked]]));
  }

  async request(path, payload) {
    const response = await fetch(path, {
      method: payload === undefined ? "GET" : "POST", cache: "no-store", signal: AbortSignal.timeout(15000),
      headers: payload === undefined ? {} : { "Content-Type": "application/json", "X-Workflow-Token": this.token },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "The workflow service rejected the request.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    const epoch = this.epoch;
    const previous = JSON.stringify(this.current);
    try {
      const session = await this.request("/api/session");
      const result = await this.request("/api/runs");
      if (!Array.isArray(result.runs) || typeof session.token !== "string" || !session.capabilities || typeof session.capabilities.available !== "boolean") throw new Error("Invalid workflow service response.");
      this.token = session.token;
      this.capabilities = session.capabilities;
      if (epoch === this.epoch && !this.busy) this.runs = result.runs;
      this.connected = true;
      if (this.pending && this.runs.some(run => run.id === this.pending.id)) this.pending = null;
    } catch {
      this.connected = false;
      this.capabilities = { available: false, message: "The workflow service is unreachable. Existing execution state is unknown; nothing will be replayed." };
    } finally {
      this.refreshing = false;
      this.paint();
      if (previous !== JSON.stringify(this.current)) window.dispatchEvent(new Event("workflow-update"));
    }
  }

  startPolling() {
    this.refresh();
    setInterval(() => { if (!document.hidden) this.refresh(); }, 2500);
  }

  markup() {
    return `<section class="panel execution-intro"><div><h2>One task. One accountable team.</h2><p>Head is the coordinator service. HWF starts visible Devin workers for planning, implementation, and independent review.</p></div><span class="pill gray">EXECUTABLE MVP</span></section>
      <section class="panel execution-capabilities" id="execution-capabilities" aria-live="polite"></section>
      <div class="execution-layout"><section class="panel execution-setup"><h2>Start a real workflow</h2>
        <p>The executable template is Planning → Implementation → Review. Plan approval is mandatory; the Workflow editor can also require final human acceptance.</p>
        <form id="execution-start"><div class="field"><label for="execution-repository">Clean source repository</label><input id="execution-repository" name="repository" required maxlength="4096" value="${escape(this.draft.repository)}" placeholder="/absolute/path/to/a/clean/repository"></div>
        <div class="field"><label for="execution-task">Task and acceptance criteria</label><textarea id="execution-task" name="task" required maxlength="5000" rows="5" placeholder="Describe one bounded task and how to verify it.">${escape(this.draft.task)}</textarea></div>
        <div class="field"><label for="execution-checks">Verification commands · JSON argument arrays</label><textarea id="execution-checks" name="checks" required rows="3" spellcheck="false">${escape(this.draft.checks)}</textarea><p class="field-hint">For example: [["npm", "test"]] or [["python3", "-m", "unittest"]]. These commands run in the isolated worktree, without a shell, with a 10-minute limit each.</p></div>
        <label class="execution-consent"><input type="checkbox" name="consent" ${this.draft.consent ? "checked" : ""} required><span>I authorize visible Devin agents to work in an isolated worktree and the service to execute exactly these verification commands. Agents keep my normal permissions; role instructions are not a sandbox.</span></label>
        <button class="button primary full" id="execution-submit" type="submit">Create worktree and start planning →</button></form>
        <p class="field-hint">The service never commits, pushes, merges, closes agent panes, or deletes worktrees. The demo's localStorage is separate from durable execution state.</p>
      </section><section id="execution-current" aria-live="polite"></section></div>`;
  }

  paint() {
    const capabilities = document.querySelector("#execution-capabilities");
    if (!capabilities) return;
    capabilities.innerHTML = `<strong>${this.capabilities.available ? `HWF ${escape(this.capabilities.version)} · ${escape(this.capabilities.workspace)}` : "Execution is not ready"}</strong><p>${escape(this.capabilities.message)}</p><small>HWF is optional for the demo and is never installed automatically. Use <code>python3 server.py --hwf /path/to/hwf</code> after explicitly installing HWF 0.15.1+.</small>`;
    const submit = document.querySelector("#execution-submit");
    submit.disabled = this.busy || !this.connected || !this.capabilities.available || (!!this.current && !terminal.has(this.current.status) && !this.pending);
    submit.textContent = this.pending ? "Reconcile the same start request →" : this.busy ? "Waiting for confirmation…" : "Create worktree and start planning →";
    const current = document.querySelector("#execution-current");
    if (!current) return;
    if (current.contains(document.activeElement) && document.activeElement.id === "execution-plan-text") return;
    current.innerHTML = this.current ? this.runMarkup(this.current) : `<section class="panel execution-empty"><h2>Your next execution starts here.</h2><p>Configure your team, choose a clean Git repository, and submit a task. The source repository remains untouched; work happens in a detached worktree.</p><p>The first stop is always your approval of an actual plan.</p></section>`;
  }

  runMarkup(run) {
    const disabled = this.busy || !this.connected ? "disabled" : "";
    const awaiting = run.status === "awaiting_approval";
    const attention = ["attention", "stale"].includes(run.status);
    return `<section class="panel execution-run"><div class="panel-heading"><h2>${escape(run.config.teamName)}</h2><span class="pill ${attention ? "amber" : "gray"}">${escape(statuses[run.status] || "Unknown state")}</span></div><div class="card-body">
      <h3>${escape(run.task)}</h3><p>${this.connected ? "" : "LAST KNOWN STATE · "}${run.signal === "unknown" ? "Runner state is unconfirmed. No automatic replay. " : ""}${escape(run.message)}</p>
      <dl class="execution-facts"><dt>Run</dt><dd>${escape(run.id)}</dd><dt>Base commit</dt><dd>${escape(run.base_sha)}</dd><dt>Isolated worktree</dt><dd>${escape(run.worktree)}</dd><dt>HWF run</dt><dd>${escape(run.job_id || "Dispatch not confirmed")}</dd><dt>Corrections</dt><dd>${run.fixes}/3</dd></dl>
      <div class="execution-actions"><button class="button secondary" data-execution-action="office">View in Office ↗</button><button class="button secondary" data-execution-action="reconcile" ${disabled}>Refresh / reconcile</button></div>
      ${run.plan ? `<section class="execution-artifact"><h3>Plan · revision ${run.plan.revision}</h3><p>${escape(run.plan.summary)}</p><code class="fingerprint">${escape(run.plan.hash)}</code>${awaiting ? `<label for="execution-plan-text">Inspect or revise the plan</label><textarea id="execution-plan-text" rows="9" maxlength="24000">${escape(run.plan.text)}</textarea><div class="execution-actions"><button class="button secondary" data-execution-action="save-plan" ${disabled}>Save a new revision</button><button class="button primary" data-execution-action="approve" ${disabled}>Approve this exact plan →</button></div><p class="field-hint">Saving a revision invalidates earlier approval requests. Approval also checks that the worktree still matches its planning baseline.</p>` : `<pre>${escape(run.plan.text)}</pre><p class="field-hint">${run.approval ? `Approved revision ${run.approval.revision} · ${escape(run.approval.at)}` : "Not approved."}</p>`}</section>` : ""}
      ${run.checks.length ? `<section class="execution-artifact"><h3>Service-executed verification</h3>${run.checks.map(check => `<details class="execution-check"><summary>${check.exit_code === 0 ? "PASS" : "NOT PASSED"} · ${escape(JSON.stringify(check.argv))}</summary><p>Executed: ${check.executed ? "yes" : "no"} · exit code: ${check.exit_code === null ? "not confirmed" : check.exit_code}${check.output_truncated ? " · output tail only" : ""}</p><pre>${escape(check.stdout)}${escape(check.stderr)}</pre></details>`).join("")}<p class="field-hint">Exit codes are actual command results. No test counts are inferred from agent reports.</p></section>` : ""}
      ${run.review ? `<section class="execution-artifact"><h3>Independent review · ${escape(run.review.verdict)}</h3><p>${escape(run.review.summary)}</p><ul>${(run.review.findings || []).map(finding => `<li>${escape(finding)}</li>`).join("")}</ul><code class="fingerprint">${escape(run.review.worktree_hash)}</code>${run.status === "awaiting_acceptance" ? `<button class="button primary full" data-execution-action="accept" ${disabled}>Accept this reviewed tree ✓</button>` : ""}</section>` : ""}
      <section class="execution-artifact"><h3>Execution events</h3><div class="event-list">${run.events.slice(0, 12).map(item => `<article class="event-item"><span class="event-dot"></span><div class="event-copy"><strong>${escape(item.title)}</strong><p>${escape(item.detail)}</p><small>${escape(item.time)}</small></div></article>`).join("")}</div></section>
      ${["awaiting_approval", "awaiting_acceptance", "attention", "completed", "stale"].includes(run.status) ? `<button class="end-demo" data-execution-action="archive" ${disabled}>Archive record · preserve worktree and panes</button>` : ""}
      </div></section>`;
  }

  async start(form) {
    if (this.busy) return;
    this.remember();
    try {
      if (!this.pending) this.pending = {
        id: crypto.randomUUID(), repository: this.draft.repository, task: this.draft.task,
        checks: JSON.parse(this.draft.checks), consent: this.draft.consent, config: this.configuration()
      };
      this.busy = true;
      this.epoch++;
      this.paint();
      const run = await this.request("/api/runs", this.pending);
      this.runs = [run, ...this.runs.filter(item => item.id !== run.id)];
      this.pending = null;
      this.notify("Planning dispatched. Implementation remains blocked until you approve the plan.");
      window.dispatchEvent(new Event("workflow-update"));
    } catch (error) {
      if (error.status) this.pending = null;
      this.notify(error.message + (this.pending ? " Retry only the same request; its identifier has been preserved." : ""), true);
    } finally {
      this.busy = false;
      this.paint();
    }
  }

  async action(action) {
    if (action === "office") return this.showOffice();
    if (this.busy || !this.current) return;
    const run = this.current;
    try {
      let payload = {};
      if (action === "approve") {
        if (document.querySelector("#execution-plan-text").value !== run.plan.text) throw new Error("Save your edited plan as a new revision before approving.");
        payload = { revision: run.plan.revision, plan_hash: run.plan.hash, worktree_hash: run.baseline_hash };
      } else if (action === "save-plan") {
        payload = { revision: run.plan.revision, text: document.querySelector("#execution-plan-text").value };
        action = "plan";
      } else if (action === "accept") {
        payload = { review_hash: run.review_hash };
      } else if (action === "archive" && !confirm("Archive this execution record? Its worktree, artifacts, and agent panes will be preserved. No running agent will be stopped.")) return;
      this.busy = true;
      this.epoch++;
      this.paint();
      const updated = await this.request(`/api/runs/${run.id}/${action}`, payload);
      this.runs = [updated, ...this.runs.filter(item => item.id !== run.id)];
      window.dispatchEvent(new Event("workflow-update"));
    } catch (error) {
      this.notify(error.message, true);
    } finally {
      this.busy = false;
      this.paint();
    }
  }

  officeState(base) {
    const run = this.current;
    if (!run || run.status === "archived") return base;
    return { ...base, teamName: run.config.teamName, stages: run.config.stages,
      agents: run.config.agents.map(agent => ({ ...agent, binding: run.panes[agent.id] || "" })) };
  }

  officeCard() {
    const run = this.current;
    return `<section class="panel"><div class="panel-heading"><h2><span class="mini-icon">⇢</span>Real workflow</h2><span class="pill gray">HWF</span></div><div class="card-body"><div class="task-kicker">${escape(statuses[run.status] || "Unknown state")}</div><h3 class="task-title">${escape(run.task)}</h3><p>${escape(run.message || "Office characters use confirmed Herdr session states. Workflow progress is tracked separately.")}</p><button class="button primary full" data-action="execution">Inspect plan, decisions, and evidence ↗</button><span class="subtle-note">Head is the coordinator service. Agents are not simulated; unlinked or disconnected sessions never appear to be working.</span></div></section>`;
  }
}
