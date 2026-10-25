import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path


class RunnerError(Exception):
    pass


def private_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + f".{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def capture(directory, kind, data):
    if kind not in ("pane", "result") or not isinstance(data, dict):
        raise ValueError("Invalid artifact kind.")
    response = data.get("response", "")
    pane = data.get("pane_id", "")
    if not isinstance(response, str) or len(response.encode()) > 65536:
        raise ValueError("Agent response exceeds the artifact limit.")
    if not isinstance(pane, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}", pane):
        raise ValueError("Invalid owned pane identifier.")
    metadata = json.loads((directory / "metadata.json").read_text())
    value = {**metadata, "response": response, "pane_id": pane}
    path = directory / f"{kind}.json"
    if path.exists():
        if json.loads(path.read_text()) == value:
            return
        raise ValueError("An artifact cannot be overwritten.")
    temporary = directory / f".{kind}.{uuid.uuid4().hex}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            if json.loads(path.read_text()) != value:
                raise ValueError("An artifact cannot be overwritten.")
    finally:
        temporary.unlink()


def prepare_phase(run, phase, directory):
    directory.mkdir(parents=True, mode=0o700)
    stage = next(stage for stage in run["config"]["stages"] if stage["id"] == phase)
    agent = next(agent for agent in run["config"]["agents"] if agent["id"] == stage["agentId"])
    metadata = {"run_id": run["id"], "attempt": directory.name, "phase": phase}
    private_json(directory / "metadata.json", metadata)
    formats = {
        "plan": '{"summary":"Short summary","plan":"Concrete implementation plan, risks and acceptance criteria"}',
        "build": '{"summary":"Changes made and limitations"}',
        "review": '{"summary":"Independent findings","verdict":"APPROVE or CHANGES_REQUESTED","findings":["Specific issues, if any"]}'
    }
    assignment = {
        "task": run["task"], "phase": phase, "repository": run["worktree"],
        "base_sha": run["base_sha"], "role": agent["role"],
        "instructions": agent["instructions"], "context": agent["context"],
        "expected_deliverable": agent["output"], "approved_plan": run.get("plan"),
        "feedback": run.get("feedback", ""), "verification": run.get("checks", []),
        "verification_commands": run["commands"],
        "rules": [
            "Work only in the isolated repository worktree.",
            "Do not commit, push, merge, open pull requests, send messages, or change permission settings.",
            "Do not run destructive commands or read unrelated credentials.",
            "For planning and review, do not edit source files. Role instructions are not a security sandbox.",
            "For implementation, implement only the approved plan and address substantiated review feedback.",
            "The service runs the user-configured verification commands separately. Never invent test results.",
            "For review, independently inspect the full diff and untracked files against the approved plan.",
            "Do not modify the workflow's control files or artifacts.",
            "Return only one JSON object, without markdown fences, using the format below. Keep it under 12 KiB."
        ], "response_format": formats[phase]
    }
    assignment_path = directory / "assignment.txt"
    private_json(assignment_path, assignment)
    bridge = str(Path(__file__).resolve())
    callback = [sys.executable, bridge, "capture", "--directory", str(directory)]
    recipe = {
        "version": "v1alpha1", "title": f"Team workflow: {stage['label']}",
        "steps": [
            {"id": "bootstrap", "agent": "Reply exactly READY.", "using": "team_devin",
             "cwd": run["worktree"], "timeout": "5m", "pane": {"open": "tab", "focus": False},
             "expect": {"one_of": ["READY"], "require": ["READY"]}},
            {"id": "identify", "run": [*callback, "--kind", "pane"],
             "env": {"OFFICE_PANE": "{{steps.bootstrap.pane_id}}"}, "timeout": "30s"},
            {"id": "work", "agent": f"Read the assignment at {assignment_path}. Follow it and return its required JSON response.",
             "target": "{{steps.bootstrap.pane_id}}", "timeout": "30m"},
            {"id": "capture", "run": [*callback, "--kind", "result"], "timeout": "30s",
             "env": {"OFFICE_PANE": "{{steps.bootstrap.pane_id}}", "OFFICE_RESPONSE": "{{steps.work.response}}"}}
        ]
    }
    private_json(directory / ".hwf/workflows/phase.yaml", recipe)
    private_json(directory / ".hwf/config.yaml",
                 {"profiles": {"team_devin": {"kind": "devin"}}, "default_profile": "team_devin"})
    return directory


class HWFRunner:
    def __init__(self, binary=None):
        self.binary = binary or os.environ.get("HWF_BIN") or shutil.which("hwf")
        self.environment = dict(os.environ)
        if self.binary:
            self.binary = str(Path(self.binary).resolve())
            self.environment["PATH"] = str(Path(self.binary).parent) + os.pathsep + self.environment.get("PATH", "")
        self.checked_at = 0
        self.readiness = None

    def available(self):
        if self.readiness and time.monotonic() - self.checked_at < 30:
            return dict(self.readiness)
        self.readiness = self._available()
        self.checked_at = time.monotonic()
        return dict(self.readiness)

    def _available(self):
        if not self.binary:
            return {"available": False, "version": None, "message": "HWF 0.15.1+ is required. Install it explicitly or start with --hwf PATH."}
        try:
            result = subprocess.run([self.binary, "--version"], capture_output=True, text=True,
                                    timeout=5, check=True, env=self.environment)
            match = re.search(r"(\d+)\.(\d+)\.(\d+)", result.stdout)
            if not match or tuple(map(int, match.groups())) < (0, 15, 1):
                raise RunnerError("HWF 0.15.1 or newer is required.")
            return {"available": True, "version": match.group(0), "message": "HWF runner is available."}
        except (OSError, subprocess.SubprocessError, RunnerError) as error:
            return {"available": False, "version": None, "message": str(error)}

    def _json(self, arguments, cwd=None, timeout=15):
        try:
            result = subprocess.run([self.binary, *arguments], cwd=cwd, env=self.environment,
                                    capture_output=True, text=True, timeout=timeout)
            payload = json.loads(result.stdout)
            if result.returncode or not isinstance(payload, dict) or payload.get("schema_version") != 1 or payload.get("ok") is not True:
                raise RunnerError("HWF could not confirm the operation. Inspect its run history before retrying.")
            if not isinstance(payload.get("run"), dict):
                raise RunnerError("HWF returned an invalid run envelope.")
            return payload["run"]
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
            raise RunnerError("HWF did not return a confirmed run. Reconcile before retrying.") from error

    def launch(self, control, workflow):
        return self._json(["run", workflow, "--detach", "--json"], cwd=control)["id"]

    def inspect(self, job):
        return self._json(["runs", "get", job, "--json"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["capture"])
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--kind", required=True, choices=["pane", "result"])
    args = parser.parse_args()
    capture(args.directory, args.kind,
            {"response": os.environ.get("OFFICE_RESPONSE", ""), "pane_id": os.environ.get("OFFICE_PANE", "")})


if __name__ == "__main__":
    main()
