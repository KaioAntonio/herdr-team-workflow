import hashlib
import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from runner import RunnerError, prepare_phase, private_json


class WorkflowError(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def identity(value):
    try:
        if str(uuid.UUID(value)) == value:
            return value
    except (ValueError, TypeError, AttributeError):
        pass
    raise WorkflowError("Invalid run identifier.")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def git(path, *args):
    try:
        return subprocess.run(["git", "-C", str(path), *args], capture_output=True, timeout=20,
                              check=True).stdout
    except (OSError, subprocess.SubprocessError) as error:
        raise WorkflowError("Git could not verify the repository. Inspect it without resetting any work.") from error


def fingerprint(path):
    value = hashlib.sha256(git(path, "rev-parse", "HEAD") + git(path, "diff", "--binary", "HEAD", "--"))
    size = 0
    for raw in sorted(filter(None, git(path, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0"))):
        relative = os.fsdecode(raw)
        file = path / relative
        value.update(raw + b"\0")
        if file.is_symlink():
            value.update(b"symlink:" + os.fsencode(os.readlink(file)))
        elif file.is_file():
            size += file.stat().st_size
            if size > 50_000_000:
                raise WorkflowError("Untracked source exceeds the 50 MB verification limit.")
            value.update(str(file.stat().st_mode & 0o777).encode() + b"\0")
            with file.open("rb") as stream:
                for chunk in iter(lambda: stream.read(65536), b""):
                    value.update(chunk)
        else:
            raise WorkflowError("An untracked file changed while its fingerprint was being read.")
    return value.hexdigest()


def event(run, title, detail=""):
    run["updated_at"] = now()
    run["events"] = [{"time": run["updated_at"], "title": title, "detail": detail}, *run["events"]][:100]


def configuration(value):
    if not isinstance(value, dict) or not isinstance(value.get("teamName"), str) or not 1 <= len(value["teamName"].strip()) <= 60:
        raise WorkflowError("Provide a valid team name.")
    agents = value.get("agents")
    stages = value.get("stages")
    if not isinstance(agents, list) or not 3 <= len(agents) <= 8 or not isinstance(stages, list):
        raise WorkflowError("The executable template needs a planner, implementer, and independent reviewer.")
    ids = set()
    clean = []
    for agent in agents:
        if not isinstance(agent, dict) or not isinstance(agent.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", agent["id"]) or agent["id"] in ids:
            raise WorkflowError("Invalid or duplicate agent identifier.")
        limits = {"name": 40, "role": 60, "instructions": 3000, "context": 1000, "output": 500}
        if any(not isinstance(agent.get(key), str) or not 1 <= len(agent[key].strip()) <= limit for key, limit in limits.items()):
            raise WorkflowError("Invalid agent responsibilities or deliverable.")
        if not re.fullmatch(r"#[a-fA-F0-9]{6}", str(agent.get("color", ""))):
            raise WorkflowError("Invalid agent color.")
        ids.add(agent["id"])
        clean.append({key: agent[key] for key in ["id", "color", *limits]})
    if len(stages) != 3 or any(not isinstance(stage, dict) for stage in stages):
        raise WorkflowError("Real execution currently supports Planning → Implementation → Review only.")
    if [stage.get("id") for stage in stages] != ["plan", "build", "review"]:
        raise WorkflowError("Real execution currently supports Planning → Implementation → Review only.")
    for stage in stages:
        if stage.get("agentId") not in ids or not isinstance(stage.get("label"), str) or not 1 <= len(stage["label"].strip()) <= 50 or not isinstance(stage.get("approval"), bool):
            raise WorkflowError("Invalid executable stage.")
    if not stages[0]["approval"] or stages[1]["approval"]:
        raise WorkflowError("The executable template requires plan approval and an automatic implementation-to-review handoff.")
    if stages[1]["agentId"] == stages[2]["agentId"]:
        raise WorkflowError("The reviewer must be independent from the implementer.")
    return {"teamName": value["teamName"].strip(), "agents": clean,
            "stages": [{key: stage[key] for key in ("id", "label", "agentId", "approval")} for stage in stages]}


def verify_command(command, cwd, timeout=600, output_limit=2_000_000):
    check = {"argv": command, "at": now(), "executed": False, "exit_code": None,
             "stdout": "", "stderr": "", "output_truncated": False}
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            process = subprocess.Popen(command, cwd=cwd, stdout=stdout, stderr=stderr, start_new_session=True)
            check["executed"] = True
            deadline = time.monotonic() + timeout
            interruption = ""
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    interruption = "Verification exceeded its deadline."
                elif os.fstat(stdout.fileno()).st_size + os.fstat(stderr.fileno()).st_size > output_limit:
                    interruption = "Verification exceeded its output limit."
                if interruption:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    break
                time.sleep(0.02)
            check["exit_code"] = process.wait() if not interruption else None
            for key, stream in (("stdout", stdout), ("stderr", stderr)):
                size = os.fstat(stream.fileno()).st_size
                check["output_truncated"] |= size > 20000
                stream.seek(max(0, size - 20000))
                check[key] = stream.read().decode(errors="replace")
            if interruption:
                check["stderr"] += "\n" + interruption
        except OSError as error:
            check["stderr"] = str(error)
    return check


class Store:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        if self.root in (Path.home(), Path("/")) or (self.root / ".git").exists():
            raise WorkflowError("Use a dedicated private state directory outside the source repository.")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.root.stat().st_mode & 0o077:
            raise WorkflowError("The state directory must already be private (mode 0700). Select a dedicated state directory.")

    def get(self, run_id):
        path = self.root / f"{identity(run_id)}.json"
        if not path.is_file():
            raise WorkflowError("Run not found in this workspace.")
        try:
            run = json.loads(path.read_text())
            if not isinstance(run, dict) or run.get("schema_version") != 1 or run.get("id") != run_id or not isinstance(run.get("workspace"), str) or not isinstance(run.get("config"), dict) or not isinstance(run.get("events"), list) or not isinstance(run.get("status"), str) or not isinstance(run.get("created_at"), str):
                raise ValueError("Invalid state schema.")
            return run
        except (OSError, ValueError) as error:
            raise WorkflowError("Run state is unreadable. Preserve its files and inspect it.") from error

    def save(self, run):
        private_json(self.root / f"{identity(run['id'])}.json", run)

    def list(self):
        paths = list(self.root.glob("*.json"))
        if len(paths) > 200:
            raise WorkflowError("This state directory exceeds the 200-run limit. Preserve and relocate older state before continuing.")
        return sorted([self.get(path.stem) for path in paths], key=lambda run: run["created_at"], reverse=True)


class Service:
    def __init__(self, store, runner, workspace, context_ready=None):
        self.store = store
        self.runner = runner
        self.workspace = workspace
        self.lock = threading.RLock()
        self.context_ready = context_ready

    def capabilities(self):
        result = self.runner.available()
        connected = bool(self.workspace) and (self.context_ready is None or self.context_ready())
        if not connected:
            result = {**result, "message": "Start inside a connected Herdr workspace. Demo and read-only observation remain available."}
        return {**result, "available": result["available"] and connected,
                "workspace": self.workspace, "template": "plan-build-review:v1"}

    def get(self, run_id):
        run = self.store.get(run_id)
        if run["workspace"] != self.workspace:
            raise WorkflowError("Run not found in this workspace.")
        return run

    def list(self):
        return [run for run in self.store.list() if run["workspace"] == self.workspace]

    def start(self, payload):
        with self.lock:
            if not isinstance(payload, dict):
                raise WorkflowError("Invalid execution request.")
            run_id = identity(payload.get("id"))
            request_hash = digest(payload)
            if (self.store.root / f"{run_id}.json").exists():
                previous = self.get(run_id)
                if previous["request_hash"] != request_hash:
                    raise WorkflowError("This request identifier belongs to a different task.")
                return previous
            if payload.get("consent") is not True:
                raise WorkflowError("Explicit consent is required to start agents and run verification commands.")
            if not self.capabilities()["available"]:
                raise WorkflowError("Start inside Herdr with HWF 0.15.1+ available before executing a task.")
            if any(run["status"] not in ("completed", "stale", "archived") for run in self.list()):
                raise WorkflowError("An execution is already active. Reconcile or archive it before starting another.")
            config = configuration(payload.get("config"))
            task = payload.get("task")
            commands = payload.get("checks")
            if not isinstance(task, str) or not 1 <= len(task.strip()) <= 5000:
                raise WorkflowError("Describe a task using up to 5000 characters.")
            if not isinstance(commands, list) or not 1 <= len(commands) <= 5:
                raise WorkflowError("Provide between 1 and 5 explicit verification commands as argument arrays.")
            for command in commands:
                if not isinstance(command, list) or not 1 <= len(command) <= 30 or any(not isinstance(arg, str) or not arg or len(arg) > 4096 or "\0" in arg for arg in command):
                    raise WorkflowError("Verification commands must be non-empty argument arrays, not shell strings.")
            repository = payload.get("repository")
            if not isinstance(repository, str) or not repository or len(repository) > 4096 or "\0" in repository:
                raise WorkflowError("Provide the repository's local path.")
            try:
                repository = Path(repository).expanduser().resolve(strict=True)
            except OSError as error:
                raise WorkflowError("The selected repository path does not exist.") from error
            repository = Path(os.fsdecode(git(repository, "rev-parse", "--show-toplevel")).strip()).resolve()
            if git(repository, "status", "--porcelain", "--untracked-files=all"):
                raise WorkflowError("The source repository must be clean. Nothing will be stashed, reset, or discarded.")
            base = os.fsdecode(git(repository, "rev-parse", "HEAD")).strip()
            assets = self.store.root / run_id
            assets.mkdir(mode=0o700)
            worktree = assets / "worktree"
            run = {
                "schema_version": 1, "id": run_id, "request_hash": request_hash, "workspace": self.workspace,
                "task": task.strip(), "repository": str(repository), "worktree": str(worktree),
                "base_sha": base, "config": config, "commands": commands,
                "status": "preparing", "phase": "plan", "created_at": now(), "updated_at": now(),
                "plan": None, "approval": None, "review": None, "checks": [], "fixes": 0,
                "job_id": None, "attempt": None, "attempt_dir": None, "panes": {},
                "events": [], "feedback": "", "message": "", "signal": "confirmed"
            }
            self.store.save(run)
            try:
                git(repository, "worktree", "add", "--detach", str(worktree), base)
                run["baseline_hash"] = fingerprint(worktree)
                event(run, "Isolated worktree created", "The original repository is unchanged. No commits or push will be performed by the service.")
                self._dispatch(run, "plan")
            except (WorkflowError, OSError) as error:
                self._attention(run, str(error))
            return run

    def _attention(self, run, message):
        run["status"] = "attention"
        run["message"] = message
        event(run, "Operator attention required", message)
        self.store.save(run)
        return run

    def _dispatch(self, run, phase):
        attempt = str(uuid.uuid4())
        directory = self.store.root / run["id"] / attempt
        run.update(phase=phase, attempt=attempt, attempt_dir=str(directory), job_id=None,
                   status="dispatching", message="", signal="unknown")
        prepare_phase(run, phase, directory)
        self.store.save(run)
        try:
            job = identity(self.runner.launch(directory, "phase"))
            run.update(job_id=job, status={"plan": "planning", "build": "implementing", "review": "reviewing"}[phase],
                       signal="confirmed")
            event(run, "Runner accepted the stage", phase)
            self.store.save(run)
        except (RunnerError, WorkflowError, OSError) as error:
            self._attention(run, f"Launch could not be confirmed. Do not redispatch blindly. {error}")

    def edit_plan(self, run_id, payload):
        with self.lock:
            run = self.get(run_id)
            if run["status"] != "awaiting_approval" or payload.get("revision") != run["plan"]["revision"]:
                raise WorkflowError("The plan changed or is no longer editable. Refresh before deciding.")
            text = payload.get("text")
            if not isinstance(text, str) or not 1 <= len(text.strip()) <= 24000:
                raise WorkflowError("Provide a plan using up to 24000 characters.")
            run["plan"].update(text=text.strip(), revision=run["plan"]["revision"] + 1)
            run["plan"]["hash"] = digest({key: value for key, value in run["plan"].items() if key != "hash"})
            run["approval"] = None
            event(run, "Plan revised by the operator", "Previous approval requests are invalid.")
            self.store.save(run)
            return run

    def approve(self, run_id, payload):
        with self.lock:
            run = self.get(run_id)
            plan = run["plan"]
            exact = plan and payload.get("revision") == plan["revision"] and payload.get("plan_hash") == plan["hash"] and payload.get("worktree_hash") == run["baseline_hash"]
            if not exact:
                raise WorkflowError("Approval must match the exact plan revision, plan hash, and source fingerprint.")
            if run["approval"] and run["approval"]["plan_hash"] == plan["hash"]:
                return run
            if run["status"] != "awaiting_approval":
                raise WorkflowError("This execution is not waiting for plan approval.")
            if fingerprint(Path(run["worktree"])) != run["baseline_hash"]:
                raise WorkflowError("The worktree changed after planning. Do not approve stale scope.")
            run["approval"] = {"plan_hash": plan["hash"], "revision": plan["revision"], "at": now(),
                               "worktree_hash": run["baseline_hash"]}
            run.update(status="dispatching", phase="build", job_id=None)
            event(run, "Plan approved by the operator", f"Revision {plan['revision']}")
            self.store.save(run)
            self._dispatch(run, "build")
            return run

    def accept(self, run_id, payload):
        with self.lock:
            run = self.get(run_id)
            if run["status"] != "awaiting_acceptance" or payload.get("review_hash") != digest(run["review"]):
                raise WorkflowError("Refresh and inspect the exact review before accepting.")
            if fingerprint(Path(run["worktree"])) != run["review"]["worktree_hash"]:
                raise WorkflowError("The reviewed worktree changed. The result cannot be accepted.")
            run["status"] = "completed"
            event(run, "Reviewed delivery accepted by the operator")
            self.store.save(run)
            return run

    def archive(self, run_id):
        with self.lock:
            run = self.get(run_id)
            if run["status"] not in ("awaiting_approval", "awaiting_acceptance", "attention", "completed", "stale"):
                raise WorkflowError("A running stage cannot be archived. Inspect the owned runner and agents first.")
            if run["job_id"]:
                try:
                    if self.runner.inspect(run["job_id"])["status"] not in ("succeeded", "failed", "interrupted"):
                        raise WorkflowError("The runner is not terminal. Inspect its owned panes; nothing will be stopped automatically.")
                except RunnerError as error:
                    raise WorkflowError("The runner could not be reconciled. Preserve the execution and inspect its history.") from error
            elif run["status"] == "attention" and run.get("attempt"):
                raise WorkflowError("A launch without a confirmed run identity must be inspected outside this UI before any new execution.")
            run["status"] = "archived"
            event(run, "Execution archived", "Worktree, artifacts and agent panes are preserved.")
            self.store.save(run)
            return run

    def _artifact(self, run, kind):
        path = Path(run["attempt_dir"]) / f"{kind}.json"
        if not path.exists():
            return None
        if path.stat().st_size > 150000:
            raise WorkflowError("The runner artifact exceeds its size limit.")
        artifact = json.loads(path.read_text())
        if artifact.get("run_id") != run["id"] or artifact.get("attempt") != run["attempt"] or artifact.get("phase") != run["phase"]:
            raise WorkflowError("The artifact does not belong to this execution attempt.")
        return artifact

    def _checks(self, run):
        run["status"] = "verifying"
        run["checks"] = []
        self.store.save(run)
        before = fingerprint(Path(run["worktree"]))
        for command in [["git", "diff", "--check"], *run["commands"]]:
            check = verify_command(command, run["worktree"])
            run["checks"].append(check)
            self.store.save(run)
            if check["exit_code"] != 0:
                raise WorkflowError("A verification command did not pass. Its actual result is preserved; agent claims do not override it.")
        if fingerprint(Path(run["worktree"])) != before:
            raise WorkflowError("A verification command changed source files. Inspect the worktree before continuing.")
        run["verified_hash"] = before
        event(run, "Verification commands passed", f"{len(run['checks'])} commands exited 0. No test counts were inferred.")
        self.store.save(run)

    def reconcile(self, run_id):
        with self.lock:
            run = self.get(run_id)
            try:
                if run["status"] in ("completed", "awaiting_acceptance"):
                    if fingerprint(Path(run["worktree"])) != run["review"]["worktree_hash"]:
                        run["status"] = "stale"
                        event(run, "Reviewed result invalidated", "The worktree changed after the review.")
                        self.store.save(run)
                    return run
                if run["status"] in ("attention", "archived", "stale", "awaiting_approval"):
                    if run["status"] == "awaiting_approval" and run["approval"]:
                        return self._attention(run, "Approval was recorded without a confirmed implementation dispatch. Inspect the runner before continuing.")
                    return run
                if run["status"] in ("preparing", "verifying") or not run.get("job_id"):
                    return self._attention(run, "The service restarted between side effects. Inspect existing work; the stage will not be repeated automatically.")
                job = self.runner.inspect(run["job_id"])
                pane = self._artifact(run, "pane")
                if pane:
                    owner = next(stage["agentId"] for stage in run["config"]["stages"] if stage["id"] == run["phase"])
                    run["panes"][owner] = pane["pane_id"]
                if job["status"] in ("running", "stale"):
                    run["signal"] = "confirmed" if job["status"] == "running" else "unknown"
                    self.store.save(run)
                    return run
                if job["status"] != "succeeded":
                    return self._attention(run, f"HWF ended with status {job['status']}. A terminal turn is not an approved delivery.")
                artifact = self._artifact(run, "result")
                if not artifact:
                    return self._attention(run, "The runner finished without a matching delivery artifact.")
                owner = next(stage["agentId"] for stage in run["config"]["stages"] if stage["id"] == run["phase"])
                run["panes"][owner] = artifact["pane_id"]
                response = json.loads(artifact["response"])
                if not isinstance(response, dict) or not isinstance(response.get("summary"), str) or not 1 <= len(response["summary"]) <= 12000:
                    raise WorkflowError("The agent did not return the required structured delivery.")
                tree = fingerprint(Path(run["worktree"]))
                if run["phase"] == "plan":
                    if tree != run["baseline_hash"]:
                        raise WorkflowError("The planner changed the worktree. Planning is not allowed to authorize its own implementation.")
                    text = response.get("plan")
                    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 24000:
                        raise WorkflowError("The planner did not return a bounded implementation plan.")
                    run["plan"] = {"text": text.strip(), "summary": response["summary"], "revision": 1}
                    run["plan"]["hash"] = digest(run["plan"])
                    run["status"] = "awaiting_approval"
                    event(run, "Plan ready for human approval", "No implementation has been dispatched.")
                    self.store.save(run)
                elif run["phase"] == "build":
                    if not run["approval"] or run["approval"]["plan_hash"] != run["plan"]["hash"]:
                        raise WorkflowError("The approved plan no longer matches implementation.")
                    run["build"] = response
                    self._checks(run)
                    self._dispatch(run, "review")
                else:
                    if tree != run["verified_hash"]:
                        raise WorkflowError("The reviewer changed the verified worktree, or it changed during review.")
                    if artifact["pane_id"] == run["panes"].get(next(stage["agentId"] for stage in run["config"]["stages"] if stage["id"] == "build")):
                        raise WorkflowError("The reviewer is not independent from the implementer.")
                    verdict = response.get("verdict")
                    findings = response.get("findings", [])
                    if verdict not in ("APPROVE", "CHANGES_REQUESTED") or not isinstance(findings, list) or len(findings) > 50 or any(not isinstance(item, str) or len(item) > 2000 for item in findings):
                        raise WorkflowError("The reviewer did not return a valid verdict and bounded findings.")
                    if verdict == "APPROVE" and findings:
                        raise WorkflowError("Approval cannot contain unresolved findings. Request changes or return an empty findings list.")
                    run["review"] = {**response, "worktree_hash": tree, "at": now()}
                    if verdict == "CHANGES_REQUESTED":
                        if run["fixes"] >= 3:
                            raise WorkflowError("The limit of 3 correction rounds has been reached. Human intervention is required.")
                        run["fixes"] += 1
                        run["feedback"] = response["summary"] + "\n" + "\n".join(findings)
                        event(run, "Reviewer requested changes", f"Correction round {run['fixes']}/3")
                        self._dispatch(run, "build")
                    else:
                        run["status"] = "awaiting_acceptance" if run["config"]["stages"][2]["approval"] else "completed"
                        event(run, "Independent review approved the verified tree", "Work remains local. No commit, push, or PR was performed by the service.")
                        self.store.save(run)
                return run
            except RunnerError:
                run["signal"] = "unknown"
                run["message"] = "Runner state could not be confirmed. No stage will be replayed or approved while disconnected."
                self.store.save(run)
                return run
            except (WorkflowError, OSError, ValueError, KeyError, TypeError) as error:
                return self._attention(run, str(error) or "The execution could not be reconciled.")
