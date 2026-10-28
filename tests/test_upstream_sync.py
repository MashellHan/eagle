import importlib.util
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
MODULE = Path(__file__).resolve().parents[1] / "scripts/upstream-sync.py"
spec = importlib.util.spec_from_file_location("upstream_sync", MODULE)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def git(path, *args):
    return subprocess.check_output(
        ["git", "-C", str(path), *args],
        env={**{key: value for key, value in os.environ.items()
                if not key.startswith("GIT_")}, "GIT_OPTIONAL_LOCKS": "0"},
        stderr=subprocess.PIPE,
    ).decode().strip()


class UpstreamSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="eagle-upstream-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def repository(self):
        upstream = self.root / "upstream"
        upstream.mkdir()
        git(upstream, "init", "-b", "main")
        git(upstream, "config", "user.name", "Isolated test")
        git(upstream, "config", "user.email", "test@example.invalid")
        (upstream / "shared").write_text("base\n")
        git(upstream, "add", "shared")
        git(upstream, "commit", "-m", "base")
        source = self.root / "source"
        subprocess.check_call(
            ["git", "clone", "--no-hardlinks", str(upstream), str(source)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        git(source, "config", "user.name", "Isolated test")
        git(source, "config", "user.email", "test@example.invalid")
        fork = self.root / "fork.git"
        subprocess.check_call(
            ["git", "clone", "--bare", str(upstream), str(fork)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return source, upstream, fork

    def test_real_process_lock_and_dead_owner_recovery(self):
        lock = self.root / "driver.lock"
        program = (
            "import importlib.util,sys;"
            "s=importlib.util.spec_from_file_location('driver',sys.argv[1]);"
            "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
            "c=m.exclusive_lock(sys.argv[2]);c.__enter__();"
            "print('owned',flush=True);sys.stdin.read()"
        )
        owner = subprocess.Popen(
            [sys.executable, "-B", "-c", program, str(MODULE), str(lock)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        def cleanup():
            if owner.poll() is None:
                owner.kill()
            owner.communicate()
        self.addCleanup(cleanup)
        self.assertEqual(owner.stdout.readline().strip(), "owned")
        with self.assertRaises(driver.Busy):
            with driver.exclusive_lock(lock):
                self.fail("second live owner entered")
        owner.terminate()
        owner.communicate(timeout=3)
        self.assertTrue(lock.exists())
        with driver.exclusive_lock(lock):
            with self.assertRaises(driver.Busy):
                with driver.exclusive_lock(lock):
                    self.fail("same-process second owner entered")

    def test_snapshot_identifies_dirty_content_without_changing_index_or_config(self):
        source, _, _ = self.repository()
        (source / "shared").write_text("dirty tracked\n")
        (source / "untracked").write_text("first\n")
        before = (git(source, "rev-parse", "HEAD"), (source / ".git/index").read_bytes(),
                  (source / ".git/config").read_bytes())
        first = driver.source_snapshot(source)
        self.assertTrue(first["dirty"])
        (source / "untracked").write_text("second\n")
        second = driver.source_snapshot(source)
        self.assertNotEqual(first["fingerprint"], second["fingerprint"])
        self.assertEqual(first["head"], second["head"])
        self.assertEqual(before, (git(source, "rev-parse", "HEAD"),
                                 (source / ".git/index").read_bytes(),
                                 (source / ".git/config").read_bytes()))

    def test_real_merge_preserves_source_work_and_protected_commit(self):
        source, upstream, fork = self.repository()
        (source / "ours").write_text("protected\n")
        git(source, "add", "ours")
        git(source, "commit", "-m", "protected")
        (upstream / "theirs").write_text("upstream\n")
        git(upstream, "add", "theirs")
        git(upstream, "commit", "-m", "upstream")
        (source / "shared").write_text("local uncommitted\n")
        (source / "untracked").write_text("keep\n")
        before = driver.source_snapshot(source)
        result = driver.prepare_candidate(
            source, str(upstream), str(fork), "feature/test", self.root / "candidate",
        )
        self.assertEqual(result["merge_exit_code"], 0)
        self.assertTrue(result["merge_attempted"])
        self.assertIsNone(result["candidate_commit"])
        candidate = self.root / "candidate"
        self.assertEqual((candidate / "ours").read_text(), "protected\n")
        self.assertEqual((candidate / "theirs").read_text(), "upstream\n")
        self.assertTrue((candidate / ".git/MERGE_HEAD").exists())
        self.assertEqual(before["fingerprint"], driver.source_snapshot(source)["fingerprint"])
        self.assertEqual(before["head"], git(source, "rev-parse", "HEAD"))
        self.assertEqual(git(fork, "for-each-ref", "refs/heads/feature/test"), "")

    def test_conflicts_leave_the_candidate_and_merge_head_intact(self):
        source, upstream, fork = self.repository()
        for repo, text in [(source, "ours\n"), (upstream, "theirs\n")]:
            (repo / "shared").write_text(text)
            git(repo, "add", "shared")
            git(repo, "commit", "-m", text.strip())
        candidate = self.root / "conflicted"
        result = driver.prepare_candidate(source, str(upstream), str(fork), "feature/test", candidate)
        self.assertNotEqual(result["merge_exit_code"], 0)
        self.assertEqual(result["result"], "conflict")
        self.assertTrue((candidate / ".git/MERGE_HEAD").exists())
        self.assertIn("<<<<<<<", (candidate / "shared").read_text())
        self.assertIsNone(result["candidate_tree"])

    def test_catchup_runs_once_for_the_latest_period_and_failure_does_not_storm(self):
        now = 1793160000
        self.assertEqual(driver.due_modes(now, {}), ["check", "merge"])
        cadence = {"check": int(now // 14400), "merge": int(now // 28800)}
        self.assertEqual(driver.due_modes(now, cadence), [])
        self.assertEqual(driver.due_modes(now + 4 * 86400, cadence), ["check", "merge"])

    def test_main_and_unscoped_destinations_are_rejected(self):
        for branch in ["main", "master", "HEAD", "refs/heads/main", "../main", "feature/../main"]:
            with self.assertRaises(driver.SyncFailure):
                driver.validate_branch(branch)
        driver.validate_branch("feature/eagle-machines-herdr")
        driver.validate_branch("integration/eagle-upstream")

    def test_foreign_git_environment_cannot_redirect_candidate_writes(self):
        source, upstream, fork = self.repository()
        foreign_config = self.root / "foreign-config"
        foreign_config.write_text("[user]\n\tname = injected\n")
        before = driver.source_snapshot(source)
        source_config = (source / ".git/config").read_bytes()
        foreign = {
            "GIT_DIR": str(source / ".git"),
            "GIT_COMMON_DIR": str(source / ".git"),
            "GIT_WORK_TREE": str(source),
            "GIT_INDEX_FILE": str(source / ".git/index"),
            "GIT_OBJECT_DIRECTORY": str(source / ".git/objects"),
            "GIT_CONFIG_GLOBAL": str(foreign_config),
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "core.hooksPath",
            "GIT_CONFIG_VALUE_0": "/untrusted/hooks",
        }
        with patch.dict(os.environ, foreign):
            top = driver.command(["git", "rev-parse", "--show-toplevel"], upstream)[1].decode().strip()
            self.assertEqual(top, str(upstream.resolve()))
            destination = self.root / "candidate"
            result = driver.prepare_candidate(source, str(upstream), str(fork), "feature/test", destination)
            driver.command(["git", "checkout", "-b", "candidate-only"], destination)
            self.assertEqual(git(destination, "branch", "--show-current"), "candidate-only")
            self.assertEqual(git(destination, "config", "--get", "user.name"), "Isolated test")
            self.assertEqual(result["source_sha"], before["head"])
        self.assertEqual(git(source, "branch", "--show-current"), "main")
        self.assertEqual((source / ".git/config").read_bytes(), source_config)
        self.assertEqual(driver.source_snapshot(source)["fingerprint"], before["fingerprint"])

    def test_sigterm_stops_the_tick_without_starting_merge(self):
        state = self.root / "state"
        state.mkdir(mode=0o700)
        ready, pids = self.root / "ready", self.root / "pids"
        helper = self.root / "identity.py"
        helper.write_text(
            "import os,time\nfrom pathlib import Path\n"
            "with open(" + repr(str(pids)) + ",'a') as f: f.write(str(os.getpid())+'\\n')\n"
            "Path(" + repr(str(ready)) + ").touch()\ntime.sleep(30)\n"
        )
        driver.write_json(state / "config.json", {
            "source": str(self.root), "branch": "feature/test",
            "github_helper": str(helper), "path": os.environ["PATH"],
            "registry": "https://packages.example.test",
        })
        process = subprocess.Popen(
            [sys.executable, "-B", str(MODULE), "tick", "--state", str(state)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 3
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready.exists())
            process.terminate()
            try:
                process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                self.fail("SIGTERM did not stop tick; merge_started=" + str((state / "latest-merge.json").exists()))
            self.assertFalse((state / "latest-merge.json").exists())
            self.assertNotIn("merge", driver.read_json(state / "cadence.json"))
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=2)
            for pid in pids.read_text().splitlines() if pids.exists() else []:
                try:
                    os.kill(int(pid), 9)
                except ProcessLookupError:
                    pass

    def test_timeout_cleanup_does_not_wait_on_a_detached_descendants_pipe(self):
        pidfile = self.root / "descendant"
        payload = (
            "import os,time,sys;pid=os.fork()\n"
            "if pid==0:\n os.setsid();open(sys.argv[1],'w').write(str(os.getpid()));time.sleep(30)\n"
            "else:\n time.sleep(30)\n"
        )
        probe = (
            "import importlib.util,sys\n"
            "s=importlib.util.spec_from_file_location('d',sys.argv[1]);d=importlib.util.module_from_spec(s);s.loader.exec_module(d)\n"
            "try: d.command([sys.executable,'-c',sys.argv[2],sys.argv[3]],sys.argv[4],timeout=0.2)\n"
            "except d.SyncFailure: print('bounded-failure')\n"
        )
        process = subprocess.Popen(
            [sys.executable, "-B", "-c", probe, str(MODULE), payload, str(pidfile), str(self.root)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            try:
                stdout, stderr = process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                self.fail("Cleanup waited indefinitely for a detached child's pipe")
            self.assertEqual(process.returncode, 0, stderr.decode())
            self.assertIn(b"bounded-failure", stdout)
        finally:
            if pidfile.exists():
                try:
                    os.kill(int(pidfile.read_text()), 9)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=2)

    def test_commit_hook_changes_cannot_reuse_a_previous_gate_tree_for_publication(self):
        source, upstream, fork = self.repository()
        checkout = self.root / "candidate"
        driver.prepare_candidate(source, str(upstream), str(fork), "feature/test", checkout)
        (checkout / "shared").write_text("gated content\n")
        git(checkout, "add", "shared")
        gated = git(checkout, "write-tree")
        hook = checkout / ".git/hooks/pre-commit"
        hook.write_text("#!/bin/sh\nprintf 'changed by hook\\n' > shared\ngit add shared\n")
        hook.chmod(0o755)
        git(checkout, "commit", "-m", "hook changes content")
        head = git(checkout, "rev-parse", "HEAD")
        tree = git(checkout, "rev-parse", "HEAD^{tree}")
        self.assertNotEqual(gated, tree)
        state = self.root / "state"
        driver.private_directory(state)
        run = driver.Run(state, "merge", {"branch": "feature/test", "path": os.environ["PATH"],
                                         "registry": "https://packages.example.test"})
        run.manifest.update(gates_passed=True, gates_tree=gated, candidate_tree=tree,
                            candidate_commit=head, target_sha=None,
                            review={"decision": "approve", "candidate_commit": head, "candidate_tree": tree})
        with patch.object(driver, "FORK", str(fork)):
            with self.assertRaisesRegex(driver.SyncFailure, "gate|tree"):
                driver.publish_candidate(run, checkout)
        self.assertFalse(run.manifest["push_attempted"])
        self.assertIsNone(driver.remote_head(checkout, "fork", "feature/test"))

    def test_prepare_failure_preserves_fetched_sha_and_failure_log(self):
        source, upstream, _ = self.repository()
        helper = self.root / "identity.py"
        helper.write_text("print('{}')\n")
        state = self.root / "state"
        driver.private_directory(state)
        config = {"source": str(source), "branch": "feature/test",
                  "github_helper": str(helper), "path": os.environ["PATH"],
                  "registry": "https://packages.example.test"}
        with patch.object(driver, "UPSTREAM", str(upstream)), \
                patch.object(driver, "FORK", str(self.root / "missing-fork")):
            self.assertFalse(driver.run_once(config, state, "merge"))
        result = driver.read_json(state / "latest-merge.json")
        self.assertEqual(result["upstream_sha"], git(upstream, "rev-parse", "HEAD"))
        self.assertTrue((Path(result["run_dir"]) / "checkout/.git").exists())
        failures = [step for step in result["steps"] if step["status"] == "failed"]
        self.assertTrue(failures)
        self.assertTrue(Path(failures[-1]["log"]).read_text())

    def test_disable_and_enable_persist_only_the_owned_launchd_target(self):
        state = self.root / "state"
        driver.private_directory(state)
        driver.write_json(state / "config.json", {"branch": "feature/test"})
        target = "gui/" + str(os.getuid()) + "/" + driver.LABEL
        for action in ["disable", "enable"]:
            calls = []
            def fake_command(args, *_args, **_kwargs):
                calls.append(list(args))
                return (1 if args[1] == "print" else 0), b"", b""
            with patch.object(sys, "argv", [str(MODULE), action, "--state", str(state)]), \
                    patch.object(driver, "command", fake_command):
                self.assertEqual(driver.main(), 0)
            self.assertIn(["launchctl", action, target], calls)
            verb = "bootout" if action == "disable" else "bootstrap"
            self.assertTrue(any(call[:2] == ["launchctl", verb] for call in calls))

    def test_status_reads_actual_launchctl_disabled_words(self):
        state = self.root / "state"
        driver.private_directory(state)
        driver.write_json(state / "config.json", {"branch": "feature/test"})
        for word, disabled in [("disabled", True), ("enabled", False), ("true", True), ("false", False)]:
            def fake_command(args, *_args, **_kwargs):
                if args[1] == "print-disabled":
                    return 0, ('disabled services = { "' + driver.LABEL + '" => ' + word + ' }').encode(), b""
                return 1, b"", b"unloaded"
            output = io.StringIO()
            with patch.object(sys, "argv", [str(MODULE), "status", "--state", str(state)]), \
                    patch.object(driver, "command", fake_command), redirect_stdout(output):
                self.assertEqual(driver.main(), 0)
            self.assertEqual(json.loads(output.getvalue())["disabled"], disabled)
            self.assertFalse(json.loads(output.getvalue())["loaded"])

    def publish_fixture(self):
        source, upstream, fork = self.repository()
        checkout = self.root / "publish-candidate"
        driver.prepare_candidate(source, str(upstream), str(fork), "feature/test", checkout)
        state = driver.private_directory(self.root / "state")
        run = driver.Run(state, "merge", {"branch": "feature/test", "path": os.environ["PATH"],
                                         "registry": "https://packages.example.test"})
        head, tree = git(checkout, "rev-parse", "HEAD"), git(checkout, "rev-parse", "HEAD^{tree}")
        run.manifest.update(gates_passed=True, gates_tree=tree, candidate_tree=tree,
                            candidate_commit=head, target_sha=None,
                            review={"decision": "approve", "candidate_commit": head, "candidate_tree": tree})
        return checkout, fork, run

    def test_publication_never_follows_annotated_tags_from_git_configuration(self):
        checkout, fork, run = self.publish_fixture()
        git(checkout, "config", "push.followTags", "true")
        git(checkout, "tag", "-a", "unrequested-tag", "-m", "not authorized for publication")
        with patch.object(driver, "FORK", str(fork)):
            driver.publish_candidate(run, checkout)
        self.assertEqual(git(fork, "for-each-ref", "refs/tags"), "")
        self.assertEqual(driver.remote_head(checkout, "fork", "feature/test"), run.manifest["candidate_commit"])

    def test_publication_rejects_multiple_effective_push_destinations(self):
        checkout, fork, run = self.publish_fixture()
        other = self.root / "other.git"
        other.mkdir()
        git(other, "init", "--bare")
        git(checkout, "config", "--add", "remote.fork.pushurl", str(fork))
        git(checkout, "config", "--add", "remote.fork.pushurl", str(other))
        with patch.object(driver, "FORK", str(fork)):
            with self.assertRaisesRegex(driver.SyncFailure, "remote|destination"):
                driver.publish_candidate(run, checkout)
        self.assertFalse(run.manifest["push_attempted"])
        for remote in [fork, other]:
            self.assertEqual(git(remote, "for-each-ref", "refs/heads/feature/test"), "")

    def test_file_log_timeout_stops_tick_when_detached_descendant_cannot_be_certified_dead(self):
        state = driver.private_directory(self.root / "state")
        pids = self.root / "descendants"
        helper = self.root / "identity.py"
        helper.write_text(
            "import os,time\n"
            "if os.fork()==0:\n"
            " os.setsid()\n"
            " with open(" + repr(str(pids)) + ",'a') as f: f.write(str(os.getpid())+'\\n')\n"
            " time.sleep(30)\n"
            "else: time.sleep(30)\n"
        )
        driver.write_json(state / "config.json", {"source": str(self.root), "branch": "feature/test",
            "github_helper": str(helper), "path": os.environ["PATH"], "registry": "https://packages.example.test"})
        probe = (
            "import importlib.util,sys\n"
            "s=importlib.util.spec_from_file_location('d',sys.argv[1]);d=importlib.util.module_from_spec(s);s.loader.exec_module(d)\n"
            "original=d.Run.step\n"
            "def bounded(self,*a,**kw):\n kw['timeout']=0.2\n return original(self,*a,**kw)\n"
            "d.Run.step=bounded;sys.argv=[sys.argv[1],'tick','--state',sys.argv[2]]\n"
            "try: d.main()\n"
            "except d.SyncFailure: pass\n"
        )
        process = subprocess.Popen([sys.executable, "-B", "-c", probe, str(MODULE), str(state)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.communicate(timeout=3)
            self.assertFalse((state / "latest-merge.json").exists(), "Timeout must not proceed to merge")
            result = driver.read_json(state / "latest-check.json")
            self.assertEqual(result["result"], "interrupted")
            self.assertFalse(result["steps"][-1]["cleanup_confirmed"])
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=2)
            for pid in pids.read_text().splitlines() if pids.exists() else []:
                try:
                    os.kill(int(pid), 9)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main()
