import http.client
import json
import secrets
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import Mock

from server import Handler
from workflow import WorkflowError


class ExecutionHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.token = secrets.token_urlsafe(32)
        cls.server.workflow = Mock()
        cls.server.reconcile_event = threading.Event()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.host = f"127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.server.workflow.reset_mock()
        self.server.workflow.start.side_effect = None
        self.server.workflow.start.return_value = {"id": "fixture", "review": None}
        self.server.workflow.list.return_value = []
        self.server.workflow.capabilities.return_value = {"available": False}

    def request(self, method, path, payload=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        body = json.dumps(payload) if payload is not None else None
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        result = response.status, response.getheaders(), json.loads(response.read())
        connection.close()
        return result

    def mutation_headers(self):
        return {"Origin": f"http://{self.host}", "Content-Type": "application/json",
                "X-Workflow-Token": self.server.token}

    def test_session_returns_the_mutation_token_without_cors_or_caching(self):
        status, headers, data = self.request("GET", "/api/session")
        self.assertEqual(status, 200)
        self.assertEqual(data["token"], self.server.token)
        self.assertNotIn("Access-Control-Allow-Origin", dict(headers))
        self.assertEqual(dict(headers)["Cache-Control"], "no-store")

    def test_cross_origin_sites_cannot_obtain_the_token(self):
        status, _, _ = self.request("GET", "/api/session", headers={"Origin": "https://example.invalid"})
        self.assertEqual(status, 403)

    def test_missing_origin_or_missing_token_cannot_start_agents(self):
        for headers in [{"Content-Type": "application/json"}, {**self.mutation_headers(), "X-Workflow-Token": ""},
                        {**self.mutation_headers(), "Origin": "null"}]:
            status, _, _ = self.request("POST", "/api/runs", {}, headers)
            self.assertEqual(status, 403)
        self.server.workflow.start.assert_not_called()

    def test_a_cross_site_request_is_rejected_even_with_the_token(self):
        headers = {**self.mutation_headers(), "Sec-Fetch-Site": "cross-site"}
        self.assertEqual(self.request("POST", "/api/runs", {}, headers)[0], 403)
        self.server.workflow.start.assert_not_called()

    def test_non_ascii_tokens_are_rejected_without_crashing_the_handler(self):
        headers = {**self.mutation_headers(), "X-Workflow-Token": "£"}
        self.assertEqual(self.request("POST", "/api/runs", {}, headers)[0], 403)

    def test_unexpected_host_is_rejected(self):
        headers = {**self.mutation_headers(), "Host": "example.invalid"}
        self.assertEqual(self.request("POST", "/api/runs", {}, headers)[0], 403)

    def test_valid_same_origin_mutation_reaches_the_service_once(self):
        self.assertEqual(self.request("POST", "/api/runs", {"task": "fixture"}, self.mutation_headers())[0], 201)
        self.server.workflow.start.assert_called_once_with({"task": "fixture"})

    def test_form_posts_cannot_dispatch_agents(self):
        headers = {**self.mutation_headers(), "Content-Type": "text/plain"}
        self.assertEqual(self.request("POST", "/api/runs", {}, headers)[0], 415)
        self.server.workflow.start.assert_not_called()

    def test_oversized_payloads_are_rejected_before_dispatch(self):
        self.assertEqual(self.request("POST", "/api/runs", {"task": "x" * 150001}, self.mutation_headers())[0], 400)
        self.server.workflow.start.assert_not_called()

    def test_conflicts_do_not_return_tracebacks(self):
        self.server.workflow.start.side_effect = WorkflowError("An execution is already active.")
        status, _, data = self.request("POST", "/api/runs", {}, self.mutation_headers())
        self.assertEqual(status, 409)
        self.assertEqual(data, {"error": "An execution is already active."})

    def test_source_and_state_files_are_not_served(self):
        for path in ("/workflow.py", "/runner.py", "/AGENTS.md", "/.git/config", "/../server.py"):
            self.assertEqual(self.request("GET", path)[0], 404)


if __name__ == "__main__":
    unittest.main()
