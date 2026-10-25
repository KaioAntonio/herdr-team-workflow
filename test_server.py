import json
import subprocess
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

from server import filter_agents, allowed_request, get_agents, Handler, STATIC_FILES


class ServerTests(unittest.TestCase):
    def test_only_current_workspace_metadata_is_exposed(self):
        agents = [
            {"workspace_id": "wB", "pane_id": "wB:p1", "agent_status": "working",
             "agent": "devin", "name": "Head", "cwd": "/private/path",
             "terminal_title": "private title", "agent_session": {"value": "private"}},
            {"workspace_id": "wX", "pane_id": "wX:p1", "agent_status": "idle"},
        ]
        result = filter_agents(agents, "wB")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["status"], "working")
        self.assertNotIn("cwd", result[0])
        self.assertNotIn("terminal_title", result[0])
        self.assertNotIn("agent_session", result[0])

    def test_missing_workspace_never_exposes_all_agents(self):
        self.assertEqual(filter_agents([{"workspace_id": "wB"}], ""), [])

    def test_host_and_cross_origin_checks(self):
        self.assertTrue(allowed_request("127.0.0.1:8427", None, 8427))
        self.assertTrue(allowed_request("localhost:8427", "http://localhost:8427", 8427))
        self.assertFalse(allowed_request("evil.test:8427", None, 8427))
        self.assertFalse(allowed_request("localhost:8427", "https://evil.test", 8427))
        self.assertFalse(allowed_request("localhost:8427", "http://127.0.0.1:8427", 8427))

    def test_static_serving_is_an_allowlist(self):
        self.assertNotIn("/AGENTS.md", STATIC_FILES)
        self.assertNotIn("/server.py", STATIC_FILES)
        self.assertNotIn("/../AGENTS.md", STATIC_FILES)
        self.assertIn("/app.js", STATIC_FILES)

    def test_invalid_agent_entries_are_ignored(self):
        self.assertEqual(filter_agents([None, "invalid", {}], "wB"), [])

    @patch("server.WORKSPACE", "")
    def test_no_workspace_is_a_disconnected_state(self):
        self.assertFalse(get_agents()["connected"])

    @patch("server.WORKSPACE", "wB")
    @patch("server.HERDR", "/test/herdr")
    @patch("server.CACHE", {"time": 0, "data": None})
    @patch("server.subprocess.run")
    def test_cli_timeout_discards_activity(self, run):
        run.side_effect = subprocess.TimeoutExpired("herdr", 5)
        result = get_agents()
        self.assertFalse(result["connected"])
        self.assertEqual(result["agents"], [])

    @patch("server.WORKSPACE", "wB")
    @patch("server.HERDR", "/test/herdr")
    @patch("server.CACHE", {"time": 0, "data": None})
    @patch("server.subprocess.run")
    def test_invalid_cli_payload_is_not_a_positive_connection(self, run):
        for value in ["not json", "{}", '{"result":{"agents":null}}']:
            with patch("server.CACHE", {"time": 0, "data": None}):
                run.return_value = SimpleNamespace(stdout=value)
                self.assertFalse(get_agents()["connected"])

    @patch("server.WORKSPACE", "wB")
    @patch("server.HERDR", "/test/herdr")
    @patch("server.CACHE", {"time": 0, "data": None})
    @patch("server.subprocess.run")
    def test_cli_invocation_is_fixed_and_scoped(self, run):
        run.return_value = SimpleNamespace(stdout=json.dumps({"result": {"agents": [
            {"pane_id": "wB:p1", "workspace_id": "wB", "agent_status": "idle"},
            {"pane_id": "wX:p1", "workspace_id": "wX", "agent_status": "working"},
        ]}}))
        result = get_agents()
        self.assertEqual([agent["pane_id"] for agent in result["agents"]], ["wB:p1"])
        self.assertEqual(run.call_args.args[0], ["/test/herdr", "agent", "list"])
        self.assertNotIn("shell", run.call_args.kwargs)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def assert_status(self, path, code, headers=None, method="GET"):
        request = urllib.request.Request(self.base + path, headers=headers or {}, method=method)
        with self.assertRaises(urllib.error.HTTPError) as result:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(result.exception.code, code)
        result.exception.close()

    def test_static_content_has_security_headers(self):
        with urllib.request.urlopen(self.base) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
            self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])

    def test_source_and_parent_files_cannot_be_downloaded(self):
        for path in ["/server.py", "/AGENTS.md", "/../AGENTS.md", "/%2e%2e/AGENTS.md"]:
            self.assert_status(path, 404)

    def test_other_websites_cannot_read_agent_metadata(self):
        self.assert_status("/api/herdr/agents", 403, {"Origin": "https://evil.test"})
        self.assert_status("/api/herdr/agents", 403, {"Host": f"evil.test:{self.server.server_port}"})
        self.assert_status("/api/herdr/agents", 403, {"Sec-Fetch-Site": "cross-site"})

    def test_mutating_requests_are_rejected(self):
        self.assert_status("/api/herdr/agents", 405, method="POST")


if __name__ == "__main__":
    unittest.main()
