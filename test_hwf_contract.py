import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from runner import HWFRunner, private_json
import test_workflow


@unittest.skipUnless(os.environ.get("HWF_TEST_BIN"), "Set HWF_TEST_BIN to run the real-HWF, no-agent contract test.")
class HWFContractTests(unittest.TestCase):
    def test_generated_devin_phase_passes_the_real_loader_without_starting_agents(self):
        fixture = test_workflow.WorkflowTests("test_start_creates_an_isolated_worktree_and_persists_the_snapshot")
        fixture.setUp()
        try:
            run = fixture.start()
            control = Path(run["attempt_dir"])
            result = subprocess.run([os.environ["HWF_TEST_BIN"], "workflow", "validate",
                                     str(control / ".hwf/workflows/phase.yaml"), "phase"],
                                    cwd=control, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
        finally:
            fixture.tearDown()

    def test_detached_local_command_has_a_confirmed_identity_and_terminal_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "evidence.json"
            private_json(root / ".hwf/workflows/adapter-proof.yaml", {
                "version": "v1alpha1", "title": "Team Workflows adapter proof (no agents)",
                "steps": [{"id": "proof", "run": [sys.executable, "-c",
                           "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('{\"fixture\":true}')",
                           str(output)], "timeout": "30s"}]
            })
            runner = HWFRunner(os.environ["HWF_TEST_BIN"])
            runner.environment["XDG_STATE_HOME"] = str(root / "state")
            runner.environment["XDG_CONFIG_HOME"] = str(root / "config")
            runner.environment["HERDR_PLUGIN_STATE_DIR"] = str(root / "plugin-state")
            self.assertTrue(runner.available()["available"])
            job = runner.launch(root, "adapter-proof")
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                result = runner.inspect(job)
                if result["status"] != "running":
                    break
                time.sleep(0.1)
            self.assertEqual(result["id"], job)
            self.assertEqual(result["status"], "succeeded", result)
            self.assertEqual(json.loads(output.read_text()), {"fixture": True})
            self.assertEqual(result["steps"][0]["outcome"], "succeeded")


if __name__ == "__main__":
    unittest.main()
