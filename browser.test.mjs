import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.OFFICE_URL || "http://127.0.0.1:8427";
const profile = await mkdtemp(join(tmpdir(), "herdr-office-browser-"));
const chrome = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-extensions", "--window-size=1440,1100", "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
let socket;
const errors = [];
let checks = 0;

try {
  const browserSocket = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome did not expose DevTools")), 15000);
    let stderr = "";
    chrome.stderr.on("data", data => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.once("error", reject);
    chrome.once("exit", code => reject(new Error(`Chrome exited (${code})`)));
  });
  const debuggerOrigin = browserSocket.replace("ws://", "http://").split("/devtools/")[0];
  const target = await (await fetch(`${debuggerOrigin}/json/new?about:blank`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${expression}; browser errors: ${JSON.stringify(errors)}; state: ${JSON.stringify(await evaluate("({hidden:document.hidden,fixtureStatus:window.__executionFixture?.status,active:document.activeElement?.id,workflow:document.querySelector('#execution-workflow-name')?.textContent,runVisible:!!document.querySelector('.execution-run')})"))}`);
  };
  const check = async (name, expression) => {
    assert.equal(await evaluate(expression), true, name);
    checks++;
    console.log(`PASS ${name}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`);
  const submit = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Page.bringToFront");
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: origin });
  await wait("!!document.querySelector('#office-canvas')");
  await check("office boots with four selectable desks", "document.querySelectorAll('.desk-hit').length === 4");
  await check("demo disclosure is always visible", "document.querySelector('#mode-notice').textContent.includes('No agents')");
  await check("the document language and primary navigation are English", "document.documentElement.lang === 'en' && document.querySelector('[data-view=team]').textContent.includes('Team') && document.querySelector('#page-title').textContent.includes('Your team')");
  await check("desktop has no horizontal overflow", "document.documentElement.scrollWidth <= innerWidth");
  await new Promise(resolve => setTimeout(resolve, 400));
  const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const screenshotPath = join(tmpdir(), "herdr-office-desktop.png");
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(`SCREENSHOT ${screenshotPath}`);
  await click('[data-agent="planner"]');
  await check("agent detail opens accessibly", "!document.querySelector('#agent-drawer').hidden && document.activeElement.id === 'close-drawer' && document.querySelector('.app-shell').inert");
  await check("agent forms and safety notices are English", "document.querySelector('#agent-form').textContent.includes('Responsibilities and boundaries') && document.querySelector('#agent-form').textContent.includes('Instructions are not a security boundary') && document.querySelector('#agent-instructions').value.startsWith('Investigate')");
  await fill("#agent-name", 'Planner <img src=x onerror="window.injected=true">');
  await submit("#agent-form");
  await check("form validation rejects an oversized name", "!document.querySelector('#agent-drawer').hidden");
  await fill("#agent-name", 'Planner <img src=x onerror=alert(1)>');
  await submit("#agent-form");
  await check("agent text is escaped, not interpreted as HTML", "!document.querySelector('#agent-drawer:not([hidden])') && !document.querySelector('.room img') && document.querySelector('.room').textContent.includes('<img')");
  await click('[data-agent="planner"]');
  await fill("#agent-name", "Planner");
  await submit("#agent-form");
  await click("#new-demand");
  await click("#example-demand");
  await submit("#demand-form");
  await check("demand starts in planning", "document.querySelector('.pipeline-step.current').textContent.includes('Planning')");
  await click('[data-action="advance"]');
  await check("human approval blocks automatic advancement", "document.querySelector('[data-action=advance]').disabled && !!document.querySelector('[data-action=approve]')");
  await call("Page.reload");
  await wait("!!document.querySelector('[data-action=approve]')");
  await check("reload preserves the pending approval", "document.querySelector('.pipeline-step.waiting').textContent.includes('Planning')");
  await click('[data-view="team"]');
  await check("configuration is locked while a demand is active", "document.querySelector('#team-name').disabled && document.querySelector('[data-action=add-agent]').disabled");
  await click('[data-view="office"]');
  await click('[data-action="approve"]');
  await click('[data-action="advance"]');
  await click('[data-action="advance"]');
  await click('[data-action="request-changes"]');
  await fill("#feedback-input", "Handle lost connections to Herdr.");
  await submit("#feedback-form");
  await check("review feedback returns to implementation", "document.querySelector('.pipeline-step.current').textContent.includes('Implementation') && document.querySelector('.task-title').closest('.card-body').textContent.includes('Handle lost')");
  await click('[data-action="advance"]');
  await click('[data-action="advance"]');
  await click('[data-action="approve"]');
  await check("a full correction cycle can complete", "document.querySelector('.task-title').closest('.card-body').textContent.includes('No real code or tests were executed')");
  await click('[data-view="team"]');
  await fill("#team-name", "My studio");
  await evaluate("document.querySelector('#team-name').dispatchEvent(new Event('change', { bubbles: true }))");
  await click('[data-action="add-agent"]');
  await fill("#agent-name", "QA");
  await fill("#agent-role", "Quality");
  await submit("#agent-form");
  await check("new agents are configurable", "document.querySelectorAll('.agent-card').length === 5 && document.querySelector('#sidebar-team').textContent === 'My studio'");
  await click('[data-view="workflow"]');
  await click('[data-action="add-stage"]');
  await check("workflow accepts additional stages", "document.querySelectorAll('.workflow-row').length === 4");
  await click(".workflow-row:last-child [data-action=stage-up]");
  await check("workflow stages can be reordered", "document.querySelectorAll('[data-stage-field=label]')[2].value === 'New stage'");
  await click(".workflow-row:nth-child(3) [data-action=stage-remove]");
  await click("#mode-live");
  await click('[data-view="office"]');
  await wait("document.querySelector('#connection-label').textContent.includes('Herdr connected')");
  await check("live mode is scoped and does not offer execution", "document.querySelector('#new-demand').disabled && !document.querySelector('[data-action=advance]') && document.querySelector('#mode-notice').textContent.includes('read-only')");
  await click('[data-agent="head"]');
  await wait("document.querySelector('#agent-binding').options.length > 1");
  await evaluate("document.querySelector('#agent-binding').selectedIndex = 1");
  await submit("#agent-form");
  await check("live sessions can be bound explicitly", "JSON.parse(localStorage.getItem('herdr-office:v1')).agents[0].binding.length > 0");
  await call("Network.enable");
  await call("Network.setBlockedURLs", { urls: ["*api/herdr/agents*"] });
  await click("#mode-live");
  await wait("document.querySelector('#connection-label').textContent.includes('disconnected')");
  await check("lost connections never masquerade as active agents", "document.querySelector('[data-status=head]').textContent.includes('No signal')");
  await call("Network.setBlockedURLs", { urls: [] });
  await click("#mode-demo");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await check("mobile layout has no horizontal overflow", "document.documentElement.scrollWidth <= innerWidth");
  await check("mobile office does not clip its canvas or agent controls", "(() => { const room = document.querySelector('.room').getBoundingClientRect(); const panel = document.querySelector('.office-panel').getBoundingClientRect(); const canvas = document.querySelector('#office-canvas').getBoundingClientRect(); return room.right <= panel.right && canvas.right <= room.right + 1 && [...document.querySelectorAll('.desk-hit')].every(button => button.getBoundingClientRect().right <= room.right + 1); })()");
  const mobile = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const mobilePath = join(tmpdir(), "herdr-office-mobile.png");
  await writeFile(mobilePath, Buffer.from(mobile.data, "base64"));
  console.log(`SCREENSHOT ${mobilePath}`);
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await click('[data-view="team"]');
  await click('[data-agent="head"]');
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await check("keyboard Escape closes the detail drawer", "document.querySelector('#agent-drawer').hidden && !document.querySelector('.app-shell').inert");
  await evaluate("(async () => { const { initialState, startRun, advanceRun } = await import('/model.js'); const saved = initialState(); delete saved.language; saved.agents[0].role = 'Coordenação'; saved.agents[0].instructions = 'Keep my custom instructions.'; saved.stages[0].label = 'Planejamento'; startRun(saved, 'Existing task'); advanceRun(saved); saved.events = []; localStorage.setItem('herdr-office:v1', JSON.stringify(saved)); })()");
  await call("Page.reload");
  await wait("!!document.querySelector('[data-action=approve]')");
  await check("existing Portuguese defaults upgrade without losing user changes or approvals", "document.querySelector('.pipeline-step.waiting').textContent.includes('Planning') && document.querySelector('.team-mini').textContent.includes('Coordination') && document.querySelector('.task-title').textContent === 'Existing task'");
  await click('[data-agent="head"]');
  await check("existing custom instructions survive the language upgrade", "document.querySelector('#agent-instructions').value === 'Keep my custom instructions.'");
  await click("#close-drawer");
  await evaluate("localStorage.setItem('herdr-office:v1','{broken')");
  await call("Page.reload");
  await wait("!!document.querySelector('#office-canvas')");
  await check("corrupted browser storage recovers to a usable default", "document.querySelectorAll('.desk-hit').length === 4");
  for (const screen of ["office", "team", "workflow", "activity", "execution"]) {
    await click(`[data-view="${screen}"]`);
    await check(`${screen} has no untranslated product copy`, "(() => { const content = document.body.innerText + [...document.querySelectorAll('[aria-label],[placeholder],[title],input,textarea')].map(e => [e.getAttribute('aria-label'),e.getAttribute('placeholder'),e.getAttribute('title'),e.value || ''].join(' ')).join(' '); return !/[À-ÖØ-öø-ÿ]/.test(content) && !/\\b(?:Equipe|Demanda|Etapa|Nome|Fechar|Seu|Sua|Nenhum|Apenas)\\b/.test(content); })()");
  }
  const fixtureScript = `(() => {
    const realFetch = window.fetch.bind(window);
    const documentation = sessionStorage.getItem('workflow-docs-preview') === 'true';
    window.__executionCalls = [];
    window.__executionFixture = JSON.parse(sessionStorage.getItem('workflow-ui-fixture') || 'null');
    const respond = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json'}}));
    window.fetch = async (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname;
      if (path === '/api/session') return respond({token:'ui-fixture-token', capabilities:{available:true, version:'0.15.1', workspace:documentation ? 'preview-workspace' : 'fixture-workspace', message:documentation ? 'Configuration preview — no agents are running.' : 'UI fixture only — no agents are started.'}});
      if (path === '/api/herdr/agents' && documentation) return respond({connected:false,agents:[],workspace:'',message:'Demo preview — no live sessions connected.'});
      if (path === '/api/runs' && (!options.method || options.method === 'GET')) return respond({runs:window.__executionFixture ? [window.__executionFixture] : []});
      if (path.startsWith('/api/runs') && options.method === 'POST') {
        const payload = JSON.parse(options.body);
        window.__executionCalls.push({path, payload, token:options.headers['X-Workflow-Token']});
        if (path === '/api/runs') {
          window.__executionFixture = {schema_version:1, id:payload.id, task:payload.task, config:payload.config, base_sha:'a'.repeat(40), baseline_hash:'b'.repeat(64), worktree:'/fixture/isolated-worktree', status:'planning', phase:'plan', signal:'confirmed', message:'UI fixture only', job_id:'fixture-job', fixes:0, panes:{planner:'fixture-planner'}, events:[], checks:[], plan:null, approval:null, review:null};
        } else if (path.endsWith('/plan')) {
          window.__executionFixture.plan = {text:payload.text, revision:2, hash:'c'.repeat(64), summary:'Revised fixture plan'};
        } else if (path.endsWith('/approve')) {
          window.__executionFixture.status = 'implementing';
          window.__executionFixture.approval = {revision:payload.revision, at:'fixture-time'};
        } else if (path.endsWith('/accept')) window.__executionFixture.status = 'completed';
        sessionStorage.setItem('workflow-ui-fixture', JSON.stringify(window.__executionFixture));
        return respond(window.__executionFixture, path === '/api/runs' ? 201 : 200);
      }
      if (options.method && options.method !== 'GET') throw new Error('Unexpected write blocked by the UI test fixture.');
      return realFetch(input, options);
    };
  })();`;
  await call("Page.addScriptToEvaluateOnNewDocument", { source: fixtureScript });
  await evaluate(fixtureScript);
  await click('[data-view="execution"]');
  await wait("document.querySelector('#execution-capabilities').textContent.includes('UI fixture only')");
  await wait("!document.querySelector('#execution-submit').disabled");
  await check("execution clearly discloses opt-in agents and unchanged permissions", "document.querySelector('#mode-notice').textContent.includes('Opt-in real execution') && document.querySelector('.execution-consent').textContent.includes('not a sandbox')");
  await click('[data-execution-action="choose-workflow"]');
  await check("workflow selection opens an accessible dialog without launching agents", "document.querySelector('#workflow-picker').open && document.querySelector('#workflow-picker').getAttribute('aria-labelledby') === 'workflow-picker-title' && document.querySelectorAll('[data-workflow-choice]').length === 3 && window.__executionCalls.length === 0");
  await click('[data-workflow-choice="reviewed-delivery"]');
  await check("a workflow choice updates the preview and its approval checkpoints", "!document.querySelector('#workflow-picker').open && document.querySelector('#execution-workflow-name').textContent === 'Plan, build & review' && document.querySelector('#execution-workflow-preview').textContent.match(/Your approval/g).length === 1");
  await click('[data-view="workflow"]');
  await check("choosing a preset does not overwrite the user's editable workflow", "document.querySelectorAll('[data-stage-field=approval]')[2].checked === true");
  await click('[data-view="execution"]');
  await evaluate("document.querySelector('[data-execution-action=choose-workflow]').focus()");
  await click('[data-execution-action="choose-workflow"]');
  await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await wait("!document.querySelector('#workflow-picker').open");
  await check("Escape closes the picker and restores keyboard focus", "document.activeElement.dataset.executionAction === 'choose-workflow'");
  await click('[data-execution-action="choose-workflow"]');
  await click('[data-workflow-choice="human-delivery"]');
  await check("human-approved delivery previews both human checkpoints", "document.querySelector('#execution-workflow-name').textContent === 'Human-approved delivery' && document.querySelector('#execution-workflow-preview').textContent.match(/Your approval/g).length === 2");
  await fill("#execution-repository", "/fixture/repository");
  await fill("#execution-task", "UI fixture task — no paid agents");
  await fill("#execution-checks", '[["python3","-m","unittest"]]');
  await evaluate("document.querySelector('#execution-start [name=consent]').checked = true");
  await submit("#execution-start");
  await wait("!!document.querySelector('.execution-run')");
  await check("execution submits consent, argv checks, team snapshot, and the mutation token", "window.__executionCalls.length === 1 && window.__executionCalls[0].payload.consent === true && Array.isArray(window.__executionCalls[0].payload.checks[0]) && window.__executionCalls[0].payload.config.agents.length === 4 && window.__executionCalls[0].token === 'ui-fixture-token'");
  await check("execution receives the chosen workflow rather than a mutable demo run", "window.__executionCalls[0].payload.config.stages[2].approval === true && !('run' in window.__executionCalls[0].payload.config)");
  await check("a running workflow cannot be started a second time", "document.querySelector('#execution-submit').disabled && !document.querySelector('[data-execution-action=approve]')");
  await evaluate("window.__executionFixture.status = 'awaiting_approval'; window.__executionFixture.plan = {text:'Inspect the fixture and make one bounded change.',revision:1,hash:'d'.repeat(64),summary:'Actual-plan UI fixture'}");
  await wait("!!document.querySelector('[data-execution-action=approve]')");
  await fill("#execution-plan-text", "Revised UI fixture plan.");
  await evaluate("document.querySelector('#execution-plan-text').dispatchEvent(new Event('input',{bubbles:true}))");
  await check("unsaved plan edits cannot be approved", "document.querySelector('[data-execution-action=approve]').disabled");
  await click('[data-execution-action="save-plan"]');
  await wait("document.querySelector('#execution-current').textContent.includes('revision 2')");
  await click('[data-execution-action="approve"]');
  await wait("document.querySelector('#execution-current').textContent.includes('Implementing')");
  await check("approval sends the displayed plan hash, revision, and baseline", "(() => {const call = window.__executionCalls.find(item => item.path.endsWith('/approve'));return call.payload.revision === 2 && call.payload.plan_hash === 'c'.repeat(64) && call.payload.worktree_hash === 'b'.repeat(64);})()");
  await call("Page.reload");
  await wait("!!document.querySelector('#office-canvas')");
  await click('[data-view="execution"]');
  await wait("document.querySelector('#execution-current').textContent.includes('Implementing')");
  await check("execution reload reads persisted state without redispatching", "window.__executionCalls.length === 0");
  await check("the selected workflow survives a reload in the same tab", "document.querySelector('#execution-workflow-name').textContent === 'Human-approved delivery'");
  await click('[data-execution-action="choose-workflow"]');
  await click('[data-workflow-choice="reviewed-delivery"]');
  await check("choosing a future workflow does not alter an active run snapshot", "window.__executionFixture.config.stages[2].approval === true && window.__executionCalls.length === 0");
  await click('[data-execution-action="office"]');
  await check("the Office links to execution evidence instead of simulated advancement", "document.querySelector('[data-action=execution]').textContent.includes('evidence') && !document.querySelector('[data-action=advance]')");
  await click('[data-agent="planner"]');
  await check("workflow characters open the execution inspector", "!!document.querySelector('#execution-current')");
  await evaluate("window.__executionFixture.status='awaiting_acceptance'; window.__executionFixture.review={verdict:'APPROVE',summary:'UI fixture reviewer result',findings:[],worktree_hash:'e'.repeat(64)}; window.__executionFixture.review_hash='f'.repeat(64); window.__executionFixture.checks=[{argv:['fixture-check'],executed:true,exit_code:0,stdout:'fixture output',stderr:'',output_truncated:false}]");
  await wait("!!document.querySelector('[data-execution-action=accept]')");
  await check("execution shows actual command fields without inventing test counts", "document.querySelector('.execution-check').textContent.includes('exit code: 0') && document.querySelector('#execution-current').textContent.includes('No test counts are inferred')");
  await click('[data-execution-action="accept"]');
  await wait("document.querySelector('#execution-current').textContent.includes('Verified and reviewed')");
  await check("final acceptance is bound to the displayed review", "window.__executionCalls.find(item => item.path.endsWith('/accept')).payload.review_hash === 'f'.repeat(64)");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await check("execution has no horizontal overflow on mobile", "document.documentElement.scrollWidth <= innerWidth");
  await click('[data-execution-action="choose-workflow"]');
  await check("the workflow picker fits a mobile viewport", "document.querySelector('#workflow-picker').open && document.querySelector('#workflow-picker').getBoundingClientRect().right <= innerWidth && document.querySelector('#workflow-picker').scrollWidth <= document.querySelector('#workflow-picker').clientWidth");
  await click('[data-execution-action="close-workflow"]');
  if (process.env.SCREENSHOT_DIR) {
    await evaluate("(async () => {const {initialState,startRun}=await import('/model.js');const preview=initialState();startRun(preview,'Add a search field to the project board.');localStorage.setItem('herdr-office:v1',JSON.stringify(preview));sessionStorage.removeItem('workflow-ui-fixture');sessionStorage.setItem('workflow-docs-preview','true');sessionStorage.setItem('herdr-team-workflow:selection','human-delivery');})()");
    await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
    await call("Page.reload");
    await wait("!!document.querySelector('#office-canvas') && document.querySelector('#connection-label').textContent.includes('disconnected')");
    await new Promise(resolve => setTimeout(resolve, 300));
    const captureDocumentation = async name => {
      const image = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const path = join(process.env.SCREENSHOT_DIR, name);
      await writeFile(path, Buffer.from(image.data, "base64"));
      console.log(`DOCUMENTATION SCREENSHOT ${path}`);
    };
    await captureDocumentation("office.png");
    await click('[data-view="execution"]');
    await wait("document.querySelector('#execution-capabilities').textContent.includes('Configuration preview') && !document.querySelector('.execution-run')");
    await fill("#execution-repository", "/path/to/your/repository");
    await fill("#execution-task", "Add a search field to the project board. Preserve keyboard navigation and cover filtering with tests.");
    await captureDocumentation("execution.png");
    await click('[data-execution-action="choose-workflow"]');
    await captureDocumentation("workflow-picker.png");
    await click('[data-execution-action="close-workflow"]');
  }
  assert.deepEqual(errors, [], `Browser runtime errors: ${JSON.stringify(errors)}`);
  console.log(`PASS no browser runtime exceptions\n${checks + 1} browser checks passed`);
} finally {
  socket?.close();
  chrome.kill("SIGTERM");
  await new Promise(resolve => { if (chrome.exitCode !== null) resolve(); else { chrome.once("exit", resolve); setTimeout(resolve, 5000); } });
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}
