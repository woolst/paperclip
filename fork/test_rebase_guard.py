"""T1: the rebase guard on small repositories in a folder under its work folder, with stubs for
pnpm and the guard's own tests, the live runs and the process on port 3100. Never pnpm itself."""
import contextlib
import importlib.util
import io
import json
import os
import pwd
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("rebase_guard", os.path.join(HERE, "rebase-guard.py"))
G = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(G)
REAL = dict((n, getattr(G, n)) for n in ("account_home", "git", "run_tool", "live_runs", "port_process"))
CALL = "syncDirectoryToSsh("
CHECK = "collectIssueWorkspaceCommandPaths(\n"
LATER = "src/later.test.ts"
HOOKS = {"upstream": {"remote": "upstream", "branch": "master"},
         "commits": [{"subject": "fork(tools): rebase guard", "files": {}, "tests": ["fork/test_rebase_guard.py"]},
                     {"subject": "fork(x): edit", "files": {"src/a.ts": 2}, "tests": ["src/a.test.ts"]},
                     {"subject": "fork(x): later", "files": {"server/src/routes/issues.ts": 1}, "tests": [LATER]}],
         "sshCopyCalls": ["syncDirectoryToSsh"], "sshCopyCallers": ["server/src/ssh.ts"],
         "copyCalls": ["fs.cp(", "\"clone\""], "copyCallers": ["server/src/copy.ts"],
         "issueWorkspaceChecks": 2}

def sh(cwd, *args):
    p = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false"]
                       + list(args), cwd=cwd, capture_output=True, text=True)
    if p.returncode:
        raise AssertionError("git %s: %s" % (" ".join(args), p.stderr))
    return p.stdout.strip()

def commit(repo, subject, files):
    for path, text in files.items():
        os.makedirs(os.path.dirname(os.path.join(repo, path)), exist_ok=True)
        with open(os.path.join(repo, path), "w", encoding="utf-8") as f:
            f.write(text)
    sh(repo, "add", "-A")
    sh(repo, "commit", "-q", "--allow-empty", "-m", subject)

def gone():
    raise KeyError("no account record")

class Guard(unittest.TestCase):
    def setUp(self):
        tests = os.path.join(G.folders()[0], "tests")
        os.makedirs(tests, exist_ok=True)
        self.root = tempfile.mkdtemp(prefix="t1-", dir=tests)
        self.home, self.up, self.fork = (os.path.join(self.root, n) for n in ("home", "up", "fork"))
        self.base = os.path.join(self.home, "Library", "Application Support", "paperclip-fork")
        os.makedirs(self.up)
        os.makedirs(self.home)
        sh(self.up, "init", "-q")
        sh(self.up, "symbolic-ref", "HEAD", "refs/heads/master")
        commit(self.up, "base", {"src/a.ts": "one\ntwo\nthree\n", "server/src/ssh.ts": CALL + ")\n",
                                 "server/src/copy.ts": "await fs.cp(a, b)\n",
                                 "server/src/routes/issues.ts": CHECK * 2})
        sh(self.root, "clone", "-q", "-o", "upstream", self.up, self.fork)
        commit(self.fork, "fork(tools): rebase guard", {"fork/hooks.json": json.dumps(HOOKS),
                                                        "fork/test_rebase_guard.py": "\n", "src/a.test.ts": "\n"})
        commit(self.fork, "fork(x): edit", {"src/a.ts": "one\nTWO\nthree\n"})
        self.head = sh(self.fork, "rev-parse", "HEAD")
        self.runs, self.proc, self.calls, self.tools = [], None, [], []
        self.failing = lambda argv, cwd: False
        self.errors = lambda argv, cwd: frozenset()
        G.account_home = lambda: self.home
        G.live_runs = lambda: self.calls.append("runs") or self.runs
        G.port_process = lambda: self.proc
        G.run_tool = self.tool

    def tearDown(self):
        for name, f in REAL.items():
            setattr(G, name, f)
        shutil.rmtree(self.root, ignore_errors=True)

    def tool(self, argv, cwd):
        self.tools.append(argv)
        return (1, "failed", self.errors(argv, cwd)) if self.failing(argv, cwd) else (0, "ok", frozenset())

    def run_guard(self, command="check"):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = G.main(command.split(), repo=self.fork)
        self.line = out.getvalue()
        return code

    def last(self):
        with open(os.path.join(self.base, "rebase-check", "last.json"), encoding="utf-8") as f:
            return json.load(f)

    def cases(self, cases, code, command="check"):
        """Each case is one commit on the fork's head; each runs from a fresh head."""
        for subject, files, *words in cases:
            with self.subTest(subject=subject, files=sorted(files)):
                sh(self.fork, "reset", "-q", "--hard", self.head)
                if subject:
                    commit(self.fork, subject, files)
                self.assertEqual(self.run_guard(command), code, self.line)
                for word in words:
                    self.assertIn(word, self.line)

    def test_clean_replay_records_the_upstream_head(self):
        self.assertEqual(self.run_guard(), 0, self.line)
        self.assertEqual(self.last()["upstream_head"], sh(self.up, "rev-parse", "HEAD"))
        self.assertEqual(self.last()["result"], 0)
        work = os.path.join(self.base, "rebase-check")
        self.assertIn(["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--store-dir",
                       os.path.join(work, "pnpm-store")], self.tools)
        self.assertIn(["pnpm", "exec", "vitest", "run", "src/a.test.ts"], self.tools)
        self.assertFalse(os.path.exists(os.path.join(work, "worktree")))

    def test_update_lockfile_installs_without_the_frozen_lockfile(self):
        self.assertEqual(self.run_guard("check --update-lockfile"), 0, self.line)
        self.assertEqual(self.last()["command"], "check --update-lockfile")
        self.assertIn(["pnpm", "install", "--no-frozen-lockfile", "--prefer-offline", "--store-dir",
                       os.path.join(self.base, "rebase-check", "pnpm-store")], self.tools)
        self.assertEqual(self.run_guard("check --other"), 4, self.line)
        self.assertIn("usage", self.line)

    def test_an_upstream_pr_branch_changes_nothing(self):
        sha = sh(self.fork, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "no prefix")
        sh(self.fork, "branch", "upstream-pr/x", sha)
        self.assertEqual(self.run_guard(), 0, self.line)
        self.assertEqual(sh(self.fork, "rev-parse", "upstream-pr/x"), sha)

    def test_a_conflict_names_the_commit_and_its_files(self):
        commit(self.up, "upstream edit", {"src/a.ts": "one\n2\nthree\n"})
        self.assertEqual(self.run_guard(), 1, self.line)
        self.assertIn("fork(x): edit", self.line)
        self.assertIn("src/a.ts", self.line)
        self.assertEqual(self.last()["failing"], self.head)

    def test_a_commit_upstream_has_taken_comes_out_empty(self):
        commit(self.up, "taken", {"src/a.ts": "one\nTWO\nthree\n"})
        self.assertEqual(self.run_guard(), 0, self.line)
        self.assertIn("taken upstream, empty: fork(x): edit", self.line)

    def test_footprint_breaches_exit_2(self):
        self.cases([("fork(x): edit", {"src/a.ts": "1\n2\n3\n"}, "allows 2"),
                    ("x: no prefix", {"src/new.ts": "\n"}, "no fork( prefix"),
                    ("fork(x): no row", {"src/new.ts": "\n"}, "no row"),
                    ("fork(x): later", {"package.json": "{}\n", LATER: "\n"}, "package.json"),
                    ("fork(x): later", {"pnpm-lock.yaml": "\n", LATER: "\n"}, "pnpm-lock.yaml"),
                    ("fork(x): later", {"src/a.ts": "one\nTWO\nthree\nfour\n", LATER: "\n"}, "allows 0")], 2)

    def test_tripwires_exit_3(self):
        self.cases([("fork(x): later", {"server/src/new.ts": CALL + ")\n", LATER: "\n"}, "server/src/new.ts"),
                    ("fork(x): later", {"server/src/routes/issues.ts": CHECK * 3, LATER: "\n"}, "3 workspace"),
                    ("fork(x): later", {"packages/p/src/sync.ts": 'run(["git", "clone", url])\n', LATER: "\n"}, "packages/p/src/sync.ts"),
                    ("fork(x): later", {"server/src/more.ts": "await fs.cp(x, y)\n", LATER: "\n"}, "file copy call")], 3)

    def test_a_readme_or_a_test_that_names_a_call_is_no_caller(self):
        self.cases([("fork(x): later", {"packages/x/README.md": CALL, LATER: "\n"}),
                    ("fork(x): later", {"server/src/new.test.ts": CALL + "fs.cp(", LATER: "\n"})], 0)

    def test_fork_tests_missing_or_failing_exit_3(self):
        self.cases([("fork(x): later", {"src/other.ts": "\n"}, "missing: " + LATER)], 3)
        sh(self.fork, "reset", "-q", "--hard", self.head)
        for word, what in (("vitest", "fork tests fail"), ("unittest", "own tests fail")):
            with self.subTest(failing=word):
                self.failing = lambda argv, cwd: argv[2:3] == [word]
                self.assertEqual(self.run_guard(), 3, self.line)
                self.assertIn(what, self.line)
        self.assertNotIn(LATER, sum(self.tools, []))

    def test_setup_failures_exit_4(self):
        self.failing = lambda argv, cwd: "install" in argv
        self.assertEqual(self.run_guard(), 4, self.line)
        self.failing = lambda argv, cwd: False
        sh(self.fork, "remote", "remove", "upstream")
        self.assertEqual(self.run_guard(), 4, self.line)
        self.assertEqual(self.last()["result"], 4)
        G.account_home = gone
        self.assertEqual(self.run_guard(), 4, self.line)
        self.assertIn("no account home", self.line)

    def test_a_deploy_clone_with_changes_skips(self):
        os.makedirs(self.base, exist_ok=True)
        sh(self.root, "clone", "-q", self.fork, os.path.join(self.base, "live"))
        with open(os.path.join(self.base, "live", "local.txt"), "w", encoding="utf-8") as f:
            f.write("a change\n")
        self.cases([(None, {}, "deploy clone")], 5)
        self.cases([(None, {}, "deploy clone")], 5, "idle")

    def test_a_live_run_skips(self):
        self.runs = [{"id": "run-1"}]
        self.cases([(None, {}, "1 live run")], 5)
        self.cases([(None, {}, "1 live run")], 5, "idle")

    def test_a_type_or_token_check(self):
        self.failing = lambda argv, cwd: "check:token-gates" in argv
        self.assertEqual(self.run_guard(), 5, self.line)
        self.assertEqual(self.last()["upstream_failure"], {"token gates": "failed"})
        self.failing = lambda argv, cwd: "typecheck" in argv and cwd.endswith("worktree")
        self.assertEqual(self.run_guard(), 3, self.line)
        self.assertIn("fork's head only", self.line)

    def test_a_type_check_that_fails_on_both_heads_is_judged_by_its_errors(self):
        same = frozenset({"src/a.ts - error TS2307: Cannot find module 'runner'."})
        self.failing = lambda argv, cwd: "typecheck" in argv
        self.errors = lambda argv, cwd: same
        self.assertEqual(self.run_guard(), 0, self.line)
        self.assertIn("upstream's own type errors, none added: adapter-claude-local typecheck, ui typecheck, cli typecheck", self.line)
        self.errors = lambda argv, cwd: same | ({"src/b.ts - error TS7006: x."} if cwd.endswith("worktree") else set())
        self.assertEqual(self.run_guard(), 3, self.line)
        self.assertIn("adds 1 type error(s) to upstream's: src/b.ts - error TS7006", self.line)

    def test_type_errors_drop_colour_and_position(self):
        out = "\x1b[96msrc/a.ts\x1b[0m:\x1b[93m437\x1b[0m:\x1b[93m89\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2307: \x1b[0mNo module.\nok\n"
        self.assertEqual(G.type_errors(out), {"src/a.ts - error TS2307: No module."})

    def test_without_a_deploy_clone_the_skip_check_reads_only_the_runs(self):
        live, seen = os.path.join(self.base, "live"), []
        G.git = lambda args, cwd: seen.append(cwd) or REAL["git"](args, cwd)
        self.assertEqual(self.run_guard("idle"), 0, self.line)
        self.assertEqual(self.calls, ["runs"])
        self.assertNotIn(live, seen)
        self.assertFalse(os.path.exists(live))

    def test_idle_live_check(self):
        other = os.path.join(self.root, "other")
        sh(self.root, "clone", "-q", self.fork, other)
        cases = [(None, 0),
                 (("node src/a.ts", self.fork), 0),
                 (("node --require /opt/elsewhere/preflight.cjs --import file:///opt/elsewhere/loader.mjs"
                   " src/a.ts --port 3100", self.fork), 0),
                 (("/usr/local/bin/node %s/src/a.ts" % self.fork, "/"), 0),
                 (("node %s/src/a.ts" % other, other), 4),
                 (("node src/a.ts", other), 4),
                 (("node --require %s/src/a.ts /opt/elsewhere/main.js" % self.fork, "/"), 4),
                 (("node src/a.ts --data %s" % self.up, self.fork), 4),
                 (("node --import file://%s/src/a.ts src/a.ts" % other.replace(" ", "%20"), self.fork), 4)]
        for proc, code in cases:
            with self.subTest(proc=proc):
                self.proc = proc
                self.assertEqual(self.run_guard("idle"), code, self.line)

    def test_the_work_folder_lies_under_the_account_home(self):
        G.account_home = REAL["account_home"]
        self.addCleanup(os.environ.__setitem__, "HOME", os.environ.get("HOME", ""))
        os.environ["HOME"] = self.root
        home = pwd.getpwuid(os.getuid()).pw_dir
        self.assertEqual(G.folders()[0], os.path.join(home, "Library", "Application Support",
                                                      "paperclip-fork", "rebase-check"))

class Budget(unittest.TestCase):
    """fork/hooks.json against the rules' budget and, at a1ab55a, the reviewed lists."""
    def setUp(self):
        with open(os.path.join(HERE, "hooks.json"), encoding="utf-8") as f:
            self.hooks = json.load(f)

    def test_a_failure_line_names_the_error_not_a_deprecation_note(self):
        out = ("Progress: resolved 1\n(node:1) [DEP0169] DeprecationWarning: url.parse()\n"
               "\x1b[41m ERR_PNPM_LOCKFILE_CONFIG_MISMATCH \x1b[49m Cannot proceed\n"
               "(Use `node --trace-deprecation ...` to show where the warning was created)\n")
        self.assertEqual(G._last(out), "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed")
        self.assertEqual(G._last("one\ntwo\n"), "two")

    def test_the_budget_rows(self):
        rows = self.hooks["commits"]
        self.assertEqual(len(rows), 12)
        self.assertTrue(all(r["subject"].startswith("fork(") and r["tests"] for r in rows))
        files = [(path, n) for r in rows for path, n in r["files"].items()]
        self.assertEqual(sum(n for _, n in files), 150)
        self.assertEqual(len(set(path for path, _ in files)), 46)

    def test_the_reviewed_lists_hold_at_the_base_commit(self):
        if G.git(["cat-file", "-e", "a1ab55a^{commit}"], G.REPO)[0]:
            self.skipTest("a1ab55a is not in this repository")
        self.assertEqual(G.callers(G.REPO, self.hooks, "a1ab55a"), sorted(self.hooks["sshCopyCallers"]))
        text = G.git(["show", "a1ab55a:" + G.ISSUES], G.REPO)[1]
        self.assertEqual(text.count(G.ISSUE_CALL), self.hooks["issueWorkspaceChecks"])

    def test_the_copy_callers_hold_at_the_head(self):
        # Every file of the head that holds a copy call is reviewed; the list may name upstream files the head lacks yet.
        self.assertLessEqual(set(G.copy_callers(G.REPO, self.hooks)), set(self.hooks["copyCallers"]))

if __name__ == "__main__":
    unittest.main()
