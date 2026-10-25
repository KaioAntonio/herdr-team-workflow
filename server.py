import argparse
import fcntl
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from runner import HWFRunner
from workflow import Service, Store, WorkflowError, digest


ROOT = Path(__file__).resolve().parent
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/model.js": ("model.js", "text/javascript; charset=utf-8"),
    "/migration.js": ("migration.js", "text/javascript; charset=utf-8"),
    "/office.js": ("office.js", "text/javascript; charset=utf-8"),
    "/execution.js": ("execution.js", "text/javascript; charset=utf-8"),
    "/workflows.js": ("workflows.js", "text/javascript; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}
WORKSPACE = os.environ.get("HERDR_WORKSPACE_ID", "")
HERDR = os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")
LOCK = threading.Lock()
CACHE = {"time": 0, "data": None}


def filter_agents(agents, workspace):
    if not workspace:
        return []
    return [
        {"pane_id": agent["pane_id"], "name": agent.get("name") or agent["pane_id"],
         "kind": agent.get("agent") or "agent", "status": agent.get("agent_status", "unknown")}
        for agent in agents
        if isinstance(agent, dict) and agent.get("workspace_id") == workspace and agent.get("pane_id")
    ]


def allowed_request(host, origin, port):
    return host in (f"127.0.0.1:{port}", f"localhost:{port}") and (
        origin is None or origin == f"http://{host}"
    )


def get_agents():
    if not WORKSPACE or not HERDR:
        return {"connected": False, "agents": [], "workspace": WORKSPACE,
                "message": "Start the server from a terminal inside Herdr."}
    with LOCK:
        if time.monotonic() - CACHE["time"] < 2 and CACHE["data"]:
            return CACHE["data"]
        try:
            result = subprocess.run([HERDR, "agent", "list"], capture_output=True, text=True,
                                    timeout=5, check=True)
            payload = json.loads(result.stdout)
            agents = payload["result"]["agents"]
            if not isinstance(agents, list):
                raise ValueError("Invalid agent response")
            data = {"connected": True, "agents": filter_agents(agents, WORKSPACE),
                    "workspace": WORKSPACE, "message": "Read-only · current workspace",
                    "checkedAt": time.time()}
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
            data = {"connected": False, "agents": [], "workspace": WORKSPACE,
                    "message": "Disconnected from Herdr. No activity will be assumed."}
        CACHE.update(time=time.monotonic(), data=data)
        return data


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def json_payload(self, status, value):
        self.send_payload(status, json.dumps(value).encode())

    def run_payload(self, run):
        return {**run, "review_hash": digest(run["review"]) if run.get("review") else None}

    def send_payload(self, status, body, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' blob:; connect-src 'self'; object-src 'none'; "
                         "base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if not allowed_request(self.headers.get("Host"), self.headers.get("Origin"), self.server.server_port):
            self.send_payload(403, b'{"error":"Forbidden origin"}')
            return
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.send_payload(403, b'{"error":"Cross-site requests are not allowed"}')
            return
        path = urlsplit(self.path).path
        service = getattr(self.server, "workflow", None)
        if path == "/api/herdr/agents":
            self.send_payload(200, json.dumps(get_agents()).encode())
        elif service and path == "/api/session":
            self.json_payload(200, {"token": self.server.token, "capabilities": service.capabilities()})
        elif service and path == "/api/runs":
            try:
                self.json_payload(200, {"runs": [self.run_payload(run) for run in service.list()]})
            except WorkflowError as error:
                self.json_payload(409, {"error": str(error)})
        elif service and path.startswith("/api/runs/"):
            try:
                self.json_payload(200, self.run_payload(service.get(path.removeprefix("/api/runs/"))))
            except WorkflowError as error:
                self.json_payload(404, {"error": str(error)})
        elif path in STATIC_FILES:
            filename, mime = STATIC_FILES[path]
            self.send_payload(200, (ROOT / filename).read_bytes(), mime)
        else:
            self.send_payload(404, b'{"error":"Not found"}')

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        service = getattr(self.server, "workflow", None)
        if service is None:
            self.send_payload(405, b'{"error":"Read-only integration"}')
            return
        host, origin = self.headers.get("Host"), self.headers.get("Origin")
        token = self.headers.get("X-Workflow-Token", "")
        if not allowed_request(host, origin, self.server.server_port) or origin != f"http://{host}" or self.headers.get("Sec-Fetch-Site") == "cross-site" or len(token) > 512 or not secrets.compare_digest(token.encode(), self.server.token.encode()):
            self.json_payload(403, {"error": "A same-origin request with a valid workflow token is required."})
            return
        if self.headers.get("Content-Type", "").split(";")[0].lower() != "application/json":
            self.json_payload(415, {"error": "Use application/json."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if self.headers.get("Transfer-Encoding") or not 0 < length <= 150000:
                raise ValueError("Invalid request length.")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("Expected an object.")
        except (ValueError, OSError):
            self.json_payload(400, {"error": "Provide a bounded JSON request."})
            return
        path = urlsplit(self.path).path
        try:
            if path == "/api/runs":
                run = service.start(payload)
                self.json_payload(201, self.run_payload(run))
                return
            parts = path.strip("/").split("/")
            actions = {"approve": service.approve, "plan": service.edit_plan, "accept": service.accept}
            if len(parts) == 4 and parts[:2] == ["api", "runs"]:
                if parts[3] in actions:
                    run = actions[parts[3]](parts[2], payload)
                elif parts[3] == "archive":
                    run = service.archive(parts[2])
                elif parts[3] == "reconcile":
                    run = service.get(parts[2])
                    self.server.reconcile_event.set()
                else:
                    self.json_payload(404, {"error": "Unknown execution action."})
                    return
                self.json_payload(200, self.run_payload(run))
                return
            self.json_payload(404, {"error": "Not found."})
        except WorkflowError as error:
            self.json_payload(409, {"error": str(error)})

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8427)
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--hwf")
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    base = Path(os.environ.get("HERDR_PLUGIN_STATE_DIR") or
                Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "herdr-team-workflow")
    state_path = args.state_dir or base / hashlib.sha256(WORKSPACE.encode()).hexdigest()[:16]
    store = Store(state_path)
    lease = (store.root / "server.lock").open("a")
    try:
        fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another Team Workflows server owns this state directory. Reuse it instead of starting duplicate coordinators.")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.workflow = Service(store, HWFRunner(args.hwf), WORKSPACE, context_ready=lambda: get_agents()["connected"])
    server.token = secrets.token_urlsafe(32)
    server.reconcile_event = threading.Event()
    stopped = threading.Event()

    def monitor():
        while not stopped.is_set():
            try:
                runs = server.workflow.list()
                if runs and runs[0]["status"] not in ("attention", "archived", "stale"):
                    server.workflow.reconcile(runs[0]["id"])
            except (WorkflowError, OSError):
                pass
            server.reconcile_event.wait(2)
            server.reconcile_event.clear()

    threading.Thread(target=monitor, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"Herdr Team Workflows: {url}", flush=True)
    print(f"Workspace: {WORKSPACE or 'not connected'} | State: {store.root}", flush=True)
    if args.open and os.environ.get("HERDR_ENV") == "1":
        ui = os.environ.get("HERDR_UI_BIN", "/Applications/Herdr.app/Contents/MacOS/Herdr")
        try:
            subprocess.run([ui, "browser", "open", url, "--no-focus"], check=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            print("The Herdr browser could not be opened. Use the local URL printed above.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stopped.set()
        server.reconcile_event.set()
        server.server_close()
        lease.close()


if __name__ == "__main__":
    main()
