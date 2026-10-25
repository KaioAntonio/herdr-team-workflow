import json
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

from runner import capture, prepare_phase
from workflow import Service, Store, WorkflowError, fingerprint, verify_command


def git(path, *args):
    return subprocess.run(["git", "-C", str(path), *args], check=True,
                          capture_output=True, text=True).stdout.strip()


class FakeRunner:
    def __init__(self):
        self.jobs = {}
        self.fail_launch = False

    def available(self):
        return {"available": True, "version": "0.15.1", "message": "Test runner"}

    def launch(self, control, workflow):
        if self.fail_launch:
            raise WorkflowError("Launch outcome is unknown.")
        job = str(uuid.uuid4())
        self.jobs[job] = {"id": job, "status": "running", "control": str(control)}
        return job

    def inspect(self, job):
        return dict(self.jobs[job])

    def complete(self, run, response):
        attempt = Path(run["attempt_dir"])
        capture(attempt, "result", {"response": json.dumps(response), "pane_id": f"pane-{run['phase']}"})
        self.jobs[run["job_id"]]["status"] = "succeeded"


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repository"
        self.repo.mkdir()
        git(self.repo, "init", "--quiet")
        (self.repo / "code.txt").write_text("baseline\n")
        git(self.repo, "add", "code.txt")
        git(self.repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
            "commit", "--quiet", "-m", "fixture")
        self.store = Store(self.root / "state")
        self.runner = FakeRunner()
        self.service = Service(self.store, self.runner, "workspace-test")
        self.config = {
            "teamName": "Test team",
            "agents": [
                {"id": "head", "name": "Head", "role": "Coordination", "color": "#57896d",
                 "instructions": "Coordinate.", "context": "Task", "output": "Summary"},
                {"id": "planner", "name": "Planner", "role": "Planning", "color": "#aa86bc",
                 "instructions": "Plan only.", "context": "Task", "output": "Plan"},
                {"id": "implementer", "name": "Builder", "role": "Implementation", "color": "#d59b56",
                 "instructions": "Implement.", "context": "Plan", "output": "Changes"},
                {"id": "reviewer", "name": "Reviewer", "role": "Review", "color": "#648ca9",
                 "instructions": "Review independently.", "context": "Changes", "output": "Verdict"}
            ],
            "stages": [
                {"id": "plan", "label": "Planning", "agentId": "planner", "approval": True},
                {"id": "build", "label": "Implementation", "agentId": "implementer", "approval": False},
                {"id": "review", "label": "Review", "agentId": "reviewer", "approval": False}
            ]
        }
        self.payload = {
            "id": str(uuid.uuid4()), "repository": str(self.repo), "task": "Improve the fixture.",
            "config": self.config, "checks": [[sys.executable, "-c", "print('verified fixture')"]],
            "consent": True
        }

    def tearDown(self):
        self.temp.cleanup()

    def start(self):
        return self.service.start(self.payload)

    def plan(self):
        run = self.start()
        self.runner.complete(run, {"summary": "Ready to review", "plan": "Change the fixture and run the check."})
        return self.service.reconcile(run["id"])

    def approve(self, run):
        return self.service.approve(run["id"], {
            "revision": run["plan"]["revision"], "plan_hash": run["plan"]["hash"],
            "worktree_hash": run["baseline_hash"]
        })

    def review(self):
        run = self.approve(self.plan())
        (Path(run["worktree"]) / "code.txt").write_text("implementation\n")
        self.runner.complete(run, {"summary": "Changed the fixture."})
        return self.service.reconcile(run["id"])

    def test_start_creates_an_isolated_worktree_and_persists_the_snapshot(self):
        run = self.start()
        self.assertEqual(run["status"], "planning")
        self.assertEqual(self.store.get(run["id"])["task"], self.payload["task"])
        self.assertNotEqual(Path(run["worktree"]), self.repo)
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")
        self.assertEqual(run["base_sha"], git(self.repo, "rev-parse", "HEAD"))

    def test_start_is_idempotent_and_rejects_reusing_an_id_for_different_input(self):
        first = self.start()
        self.assertEqual(self.start()["id"], first["id"])
        self.assertEqual(len(self.runner.jobs), 1)
        self.payload["task"] = "Different task"
        with self.assertRaises(WorkflowError):
            self.start()

    def test_only_one_unarchived_active_run_is_allowed(self):
        self.start()
        self.payload["id"] = str(uuid.uuid4())
        with self.assertRaises(WorkflowError):
            self.start()

    def test_dirty_source_is_rejected_without_stashing_or_resetting(self):
        (self.repo / "code.txt").write_text("user changes")
        with self.assertRaises(WorkflowError):
            self.start()
        self.assertEqual((self.repo / "code.txt").read_text(), "user changes")
        self.assertFalse(self.runner.jobs)

    def test_real_execution_requires_explicit_consent_and_checks(self):
        self.payload["consent"] = False
        with self.assertRaises(WorkflowError):
            self.start()
        self.payload["consent"] = True
        self.payload["checks"] = []
        with self.assertRaises(WorkflowError):
            self.start()

    def test_planning_cannot_disable_human_approval_or_self_review(self):
        self.config["stages"][0]["approval"] = False
        with self.assertRaises(WorkflowError):
            self.start()
        self.config["stages"][0]["approval"] = True
        self.config["stages"][2]["agentId"] = "implementer"
        with self.assertRaises(WorkflowError):
            self.start()

    def test_plan_delivery_does_not_launch_implementation(self):
        run = self.plan()
        self.assertEqual(run["status"], "awaiting_approval")
        self.assertEqual(len(self.runner.jobs), 1)
        self.assertIsNone(run["approval"])

    def test_approval_requires_the_exact_plan_revision_and_hash(self):
        run = self.plan()
        for key, value in [("revision", 99), ("plan_hash", "0" * 64), ("worktree_hash", "0" * 64)]:
            request = {"revision": run["plan"]["revision"], "plan_hash": run["plan"]["hash"],
                       "worktree_hash": run["baseline_hash"], key: value}
            with self.assertRaises(WorkflowError):
                self.service.approve(run["id"], request)
        self.assertEqual(len(self.runner.jobs), 1)

    def test_approval_is_idempotent_and_cannot_launch_two_builds(self):
        run = self.plan()
        self.approve(run)
        self.approve(run)
        self.assertEqual(len(self.runner.jobs), 2)

    def test_editing_a_plan_invalidates_the_old_approval_request(self):
        run = self.plan()
        updated = self.service.edit_plan(run["id"], {"revision": 1, "text": "Updated plan."})
        self.assertEqual(updated["plan"]["revision"], 2)
        self.assertNotEqual(updated["plan"]["hash"], run["plan"]["hash"])
        with self.assertRaises(WorkflowError):
            self.approve(run)
        self.assertEqual(self.approve(updated)["status"], "implementing")

    def test_a_changed_worktree_cannot_be_approved(self):
        run = self.plan()
        (Path(run["worktree"]) / "code.txt").write_text("changed after planning")
        with self.assertRaises(WorkflowError):
            self.approve(run)
        self.assertEqual(len(self.runner.jobs), 1)

    def test_a_planner_that_changes_code_does_not_get_an_approval_checkpoint(self):
        run = self.start()
        (Path(run["worktree"]) / "code.txt").write_text("planner wrote code")
        self.runner.complete(run, {"summary": "Plan", "plan": "Do work"})
        result = self.service.reconcile(run["id"])
        self.assertEqual(result["status"], "attention")
        self.assertIsNone(result["plan"])

    def test_the_service_executes_checks_instead_of_trusting_the_builder(self):
        run = self.review()
        self.assertEqual(run["status"], "reviewing")
        self.assertEqual(run["checks"][0]["exit_code"], 0)
        self.assertIn("verified fixture", run["checks"][1]["stdout"])
        self.assertTrue(run["checks"][0]["executed"])

    def test_failed_checks_cannot_produce_a_completed_run(self):
        self.payload["checks"] = [[sys.executable, "-c", "raise SystemExit(7)"]]
        run = self.approve(self.plan())
        self.runner.complete(run, {"summary": "I claim all tests passed."})
        result = self.service.reconcile(run["id"])
        self.assertEqual(result["status"], "attention")
        self.assertEqual(result["checks"][-1]["exit_code"], 7)
        self.assertEqual(len(self.runner.jobs), 2)

    def test_successful_review_is_bound_to_the_verified_tree(self):
        run = self.review()
        self.runner.complete(run, {"summary": "Independent review passed.", "verdict": "APPROVE", "findings": []})
        result = self.service.reconcile(run["id"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["review"]["worktree_hash"], fingerprint(Path(run["worktree"])))
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), run["base_sha"])

    def test_a_review_that_edits_code_is_not_accepted(self):
        run = self.review()
        (Path(run["worktree"]) / "code.txt").write_text("reviewer edited")
        self.runner.complete(run, {"summary": "Approved", "verdict": "APPROVE", "findings": []})
        self.assertEqual(self.service.reconcile(run["id"])["status"], "attention")

    def test_a_configured_final_human_checkpoint_is_not_skipped(self):
        self.config["stages"][2]["approval"] = True
        run = self.review()
        self.runner.complete(run, {"summary": "Approved", "verdict": "APPROVE", "findings": []})
        result = self.service.reconcile(run["id"])
        self.assertEqual(result["status"], "awaiting_acceptance")
        from workflow import digest
        with self.assertRaises(WorkflowError):
            self.service.accept(run["id"], {"review_hash": "incorrect"})
        self.assertEqual(self.service.accept(run["id"], {"review_hash": digest(result["review"])})["status"], "completed")

    def test_changes_after_completion_invalidate_the_current_result(self):
        run = self.review()
        self.runner.complete(run, {"summary": "Approved", "verdict": "APPROVE", "findings": []})
        self.service.reconcile(run["id"])
        (Path(run["worktree"]) / "new.txt").write_text("later change")
        self.assertEqual(self.service.reconcile(run["id"])["status"], "stale")

    def test_review_changes_return_to_the_builder_and_are_bounded(self):
        run = self.review()
        for index in range(4):
            self.runner.complete(run, {"summary": "Fix needed", "verdict": "CHANGES_REQUESTED", "findings": ["Fix it."]})
            run = self.service.reconcile(run["id"])
            if index == 3:
                self.assertEqual(run["status"], "attention")
                break
            self.assertEqual(run["status"], "implementing")
            self.assertEqual(run["fixes"], index + 1)
            self.runner.complete(run, {"summary": "Fixed."})
            run = self.service.reconcile(run["id"])
            self.assertEqual(run["status"], "reviewing")

    def test_restarting_the_service_does_not_repeat_a_dispatched_turn(self):
        run = self.start()
        restarted = Service(self.store, self.runner, "workspace-test")
        self.assertEqual(restarted.reconcile(run["id"])["status"], "planning")
        self.assertEqual(len(self.runner.jobs), 1)

    def test_an_ambiguous_launch_is_never_automatically_retried(self):
        self.runner.fail_launch = True
        run = self.start()
        self.assertEqual(run["status"], "attention")
        self.runner.fail_launch = False
        self.service.reconcile(run["id"])
        self.assertFalse(self.runner.jobs)

    def test_a_crash_between_dispatch_intent_and_job_identity_needs_reconciliation(self):
        run = self.start()
        run["job_id"] = None
        run["status"] = "dispatching"
        self.store.save(run)
        self.assertEqual(self.service.reconcile(run["id"])["status"], "attention")
        self.assertEqual(len(self.runner.jobs), 1)

    def test_a_failed_runner_cannot_validate_a_response_artifact(self):
        run = self.start()
        self.runner.complete(run, {"summary": "Plan", "plan": "Do work"})
        self.runner.jobs[run["job_id"]]["status"] = "failed"
        self.assertEqual(self.service.reconcile(run["id"])["status"], "attention")

    def test_runs_are_scoped_to_the_creating_workspace(self):
        run = self.start()
        other = Service(self.store, self.runner, "other-workspace")
        self.assertEqual(other.list(), [])
        with self.assertRaises(WorkflowError):
            other.get(run["id"])

    def test_archiving_keeps_work_and_never_terminates_agents(self):
        run = self.plan()
        result = self.service.archive(run["id"])
        self.assertEqual(result["status"], "archived")
        self.assertTrue(Path(run["worktree"]).is_dir())

    def test_generated_workflow_does_not_interpret_user_text_as_templates(self):
        self.payload["task"] = "Literal {{steps.other.stdout}}"
        run = self.start()
        recipe = json.loads((Path(run["attempt_dir"]) / ".hwf/workflows/phase.yaml").read_text())
        self.assertNotIn(self.payload["task"], recipe["steps"][2]["agent"])
        self.assertIn(self.payload["task"], (Path(run["attempt_dir"]) / "assignment.txt").read_text())

    def test_capture_rejects_duplicate_or_oversized_artifacts(self):
        run = self.start()
        directory = Path(run["attempt_dir"])
        capture(directory, "result", {"response": "{}", "pane_id": "pane-1"})
        with self.assertRaises(ValueError):
            capture(directory, "result", {"response": "different", "pane_id": "pane-1"})
        with self.assertRaises(ValueError):
            capture(directory, "pane", {"response": "x" * 70000, "pane_id": "pane-1"})

    def test_verification_has_a_real_deadline_and_bounded_output(self):
        result = verify_command([sys.executable, "-c", "import time; time.sleep(5)"], self.repo, timeout=0.05)
        self.assertIsNone(result["exit_code"])
        self.assertIn("deadline", result["stderr"])
        result = verify_command([sys.executable, "-c", "print('x' * 30000)"], self.repo)
        self.assertEqual(result["exit_code"], 0)
        self.assertTrue(result["output_truncated"])
        self.assertLessEqual(len(result["stdout"]), 20000)

    def test_unknown_runner_state_never_counts_as_completion(self):
        run = self.start()
        self.runner.jobs[run["job_id"]]["status"] = "stale"
        result = self.service.reconcile(run["id"])
        self.assertEqual(result["status"], "planning")
        self.assertEqual(result["signal"], "unknown")
        self.assertEqual(len(self.runner.jobs), 1)

    def test_verification_that_modifies_source_is_rejected(self):
        self.payload["checks"] = [[sys.executable, "-c", "from pathlib import Path; Path('code.txt').write_text('mutated')"]]
        run = self.approve(self.plan())
        self.runner.complete(run, {"summary": "Implemented."})
        self.assertEqual(self.service.reconcile(run["id"])["status"], "attention")

    def test_an_incomplete_approval_transition_is_not_silently_replayed(self):
        run = self.plan()
        run["approval"] = {"plan_hash": run["plan"]["hash"], "revision": 1}
        self.store.save(run)
        self.assertEqual(self.service.reconcile(run["id"])["status"], "attention")
        self.assertEqual(len(self.runner.jobs), 1)

    def test_corrupt_saved_state_is_not_replaced_by_a_new_execution(self):
        run = self.start()
        path = self.store.root / f"{run['id']}.json"
        path.write_text("{}")
        with self.assertRaises(WorkflowError):
            self.service.get(run["id"])
        self.payload["id"] = str(uuid.uuid4())
        with self.assertRaises(WorkflowError):
            self.service.start(self.payload)
        self.assertEqual(len(self.runner.jobs), 1)


if __name__ == "__main__":
    unittest.main()
