#!/usr/bin/env python3
"""The fork's rebase guard: python3 fork/rebase-guard.py check [--update-lockfile] | idle. Exit status, with one
printed line: 0 clean; 1 a fork commit conflicts; 2 footprint breach; 3 a fork test fails or is
missing, a tripwire fires, or a type or token check fails on the fork's head only or adds a type
error to those upstream's head has; 4 setup fails,
or port 3100 is served from outside this repository; 5 skipped. The type checks first build the runner's
type definitions (build:typescript, no Rust); the server's is then ensure-build-deps and tsc --noEmit, since its
own typecheck script builds the Rust runner.
--update-lockfile installs without the frozen lockfile, as the deploy script's flag of that name does,
for an upstream head whose own lockfile is stale; the trial worktree and its lockfile are thrown away."""
import datetime
import json
import os
import pwd
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 3100
KEYS = ("upstream", "commits", "sshCopyCalls", "sshCopyCallers", "issueWorkspaceChecks")
LOCKS = ("pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json")
ISSUES = "server/src/routes/issues.ts"
ISSUE_CALL = "collectIssueWorkspaceCommandPaths("
SOURCES = ["%s/*.%s" % (d, e) for d in ("server", "packages") for e in ("ts", "tsx", "js", "mjs", "cjs")]
IDENT = ["-c", "user.name=rebase-guard", "-c", "user.email=rebase-guard@localhost",
         "-c", "commit.gpgsign=false", "-c", "rebase.updateRefs=false"]
VALUED = {"-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "-e", "--eval",
          "-p", "--print", "--env-file-if-exists", "-C", "--conditions", "--input-type", "--title", "--watch-path"}
F = ["pnpm", "--filter"]
CHECKS = [("runner type definitions", [F + ["@paperclipai/paperclip-runner", "run", "build:typescript"]]),
          ("adapter-claude-local typecheck", [F + ["@paperclipai/adapter-claude-local", "typecheck"]]),
          ("server typecheck", [F + ["@paperclipai/plugin-sdk", "ensure-build-deps"],
                                F + ["@paperclipai/server", "exec", "tsc", "--noEmit"]]),
          ("ui typecheck", [F + ["@paperclipai/ui", "typecheck"]]),
          ("cli typecheck", [F + ["paperclipai", "typecheck"]]),
          ("token gates", [["pnpm", "check:token-gates"]])]

class Stop(Exception):
    def __init__(self, code, line, failing=None, upstream_failure=None):
        Exception.__init__(self, line)
        self.code, self.line = code, line
        self.failing, self.upstream_failure = failing, upstream_failure
def _last(text):
    """The line that names the failure: the last error line, else the last line, without colour
    codes and without node's deprecation notes."""
    lines = [re.sub(r"\x1b\[[0-9;]*m", "", line).strip() for line in text.strip().splitlines()]
    lines = [l for l in lines if l and "DeprecationWarning" not in l and "--trace-deprecation" not in l]
    errors = [l for l in lines if "ERR_" in l or "Error" in l]
    return (errors or lines or [""])[-1]

# The outside sources, each replaced by a stub in the tests: the account home, git, pnpm and the
# guard's own tests (run_tool), the live runs (agents.ts:7044), the process on the port.
def account_home():
    return pwd.getpwuid(os.getuid()).pw_dir
def git(args, cwd):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    p = subprocess.run(["git", "-c", "core.quotePath=false"] + args, cwd=cwd, env=env,
                       capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()
def type_errors(text):
    """tsc's error lines without colour codes or positions, so that lines a hook shifts still match."""
    lines = (re.sub(r"\x1b\[[0-9;]*m", "", line).strip() for line in text.splitlines())
    return frozenset(re.sub(r":\d+:\d+ - error", " - error", l) for l in lines if re.search(r"error TS\d+:", l))
def run_tool(argv, cwd):
    try:
        p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True)
    except OSError as e:
        return 127, str(e), frozenset()
    out = p.stdout + "\n" + p.stderr
    return p.returncode, _last(out), type_errors(out)
def _read(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise Stop(4, "port %d answers %s with %s" % (PORT, url, e))
    except (urllib.error.URLError, OSError) as e:
        if isinstance(getattr(e, "reason", e), ConnectionRefusedError): return None
        raise Stop(4, "cannot reach port %d: %s" % (PORT, e))
def live_runs():
    base, runs = "http://127.0.0.1:%d/api/companies" % PORT, []
    for company in _read(base) or []:
        runs += _read("%s/%s/live-runs?minCount=0" % (base, company["id"])) or []
    return runs
def _out(argv):
    try:
        return subprocess.run(argv, capture_output=True, text=True).stdout
    except OSError as e:
        raise Stop(4, "cannot run %s: %s" % (argv[0], e))
def port_process():
    """(command line, working folder) of the process listening on the port, or None."""
    pids = _out(["lsof", "-nP", "-iTCP:%d" % PORT, "-sTCP:LISTEN", "-t"]).split()
    if not pids: return None
    line = _out(["ps", "-o", "command=", "-p", pids[0]]).strip()
    cwd = [l[1:] for l in _out(["lsof", "-a", "-p", pids[0], "-d", "cwd", "-Fn"]).splitlines()
           if l.startswith("n")]
    return line, cwd[0] if cwd else "/"

# Step 1: setup, skip check and live check. The work folder lies under the account home; no fallback.
def folders():
    try:
        home = account_home()
    except (KeyError, OSError):
        home = ""
    if not home or not os.path.isdir(home): raise Stop(4, "no account home")
    base = os.path.join(home, "Library", "Application Support", "paperclip-fork")
    return os.path.join(base, "rebase-check"), os.path.join(base, "live")
def setup(repo, heads):
    """Makes the work folder first, so that every later exit is recorded."""
    work, live = folders()
    try:
        os.makedirs(work, exist_ok=True)
    except OSError as e:
        raise Stop(4, "cannot make the work folder %s: %s" % (work, e))
    heads["work"], heads["fork"] = work, git(["rev-parse", "HEAD"], repo)[1]
    try:
        with open(os.path.join(repo, "fork", "hooks.json"), encoding="utf-8") as f:
            hooks = json.load(f)
    except (OSError, ValueError) as e:
        raise Stop(4, "cannot read fork/hooks.json: %s" % e)
    missing = [k for k in KEYS if k not in hooks]
    if missing: raise Stop(4, "fork/hooks.json lacks %s" % ", ".join(missing))
    if git(["remote", "get-url", hooks["upstream"]["remote"]], repo)[0]:
        raise Stop(4, "no upstream remote named %s" % hooks["upstream"]["remote"])
    return work, live, hooks
def skip_check(live):
    if os.path.exists(os.path.join(live, ".git")):
        rc, out, err = git(["status", "--porcelain"], live)
        if rc: raise Stop(4, "cannot read the deploy clone %s: %s" % (live, _last(err)), live)
        if out: raise Stop(5, "skipped: the deploy clone has changes in its tree", live)
    runs = live_runs()
    if runs: raise Stop(5, "skipped: %d live run(s) on port %d" % (len(runs), PORT))
def git_root(path):
    while not os.path.exists(os.path.join(path, ".git")):
        if os.path.dirname(path) == path: return None
        path = os.path.dirname(path)
    return path
def roots(path):
    return set(git(["rev-list", "--max-parents=0", "HEAD"], path)[1].split())
def _join(p, toks, i):
    """A path with spaces, joined back while the joined path's folder exists."""
    while (not os.path.exists(p) and i < len(toks) and not toks[i].startswith("-")
           and os.path.isdir(os.path.dirname(p + " " + toks[i]))):
        p, i = p + " " + toks[i], i + 1
    return p, i
def command_paths(line, cwd):
    """The script, the first operand after the program and its options, and every other path."""
    toks, script, found, skip = line.split() or [""], None, [], False
    _, i = _join(toks[0], toks, 1)
    while i < len(toks):
        tok, i = toks[i], i + 1
        operand, skip = not tok.startswith("-") and not skip and script is None, tok in VALUED
        text = tok.split("=", 1)[-1] if tok.startswith("-") else tok
        if text.startswith("file://"): text = urllib.parse.unquote(text[len("file://"):])
        p = os.path.join(cwd, text)
        if not tok.startswith("-"): p, i = _join(p, toks, i)
        if operand:
            script = os.path.realpath(p)
        elif "/" in text and "://" not in text:
            found.append(os.path.realpath(p))
    return script or os.path.realpath(cwd), found
def live_check(repo):
    """The script on the port lies in this repository; the line names no other fork checkout."""
    proc = port_process()
    script, found = command_paths(*proc) if proc else (repo, [])
    for path in [script] + found:
        if os.path.commonpath([path, repo]) == repo: continue
        top = git_root(path)
        if path == script or (top and roots(top) & roots(repo)):
            raise Stop(4, "port %d is served from outside this repository: %s" % (PORT, path), path)
def fetch(repo, up):
    ref = "refs/remotes/%s/%s" % (up["remote"], up["branch"])
    rc, _, err = git(["fetch", "--no-tags", up["remote"], "+refs/heads/%s:%s" % (up["branch"], ref)], repo)
    if rc: raise Stop(4, "cannot fetch upstream: %s" % _last(err))
    return git(["rev-parse", ref], repo)[1]

# Step 2: footprint, over upstream..HEAD only. A file upstream's head does not hold is the fork's own.
def footprint(repo, base, rows):
    rc, out, err = git(["log", "--reverse", "--format=%H %s", base + "..HEAD"], repo)
    if rc: raise Stop(4, "cannot list the fork's commits: %s" % _last(err))
    commits = [tuple((l.split(" ", 1) + [""])[:2]) for l in out.splitlines()]
    held = set(git(["ls-tree", "-r", "--name-only", base], repo)[1].splitlines())
    for sha, subject in commits:
        name, row = "%s %s" % (sha[:9], subject), rows.get(subject)
        if not subject.startswith("fork(") or row is None:
            why = "no row in fork/hooks.json" if subject.startswith("fork(") else "no fork( prefix"
            raise Stop(2, "footprint: %s has %s" % (name, why), sha)
        for l in git(["show", "--numstat", "--no-renames", "--format=", sha], repo)[1].splitlines():
            added, removed, path = l.split("\t", 2)
            if os.path.basename(path) in LOCKS: raise Stop(2, "footprint: %s changes %s" % (name, path), path)
            lines = max(int(n) if n.isdigit() else 1 for n in (added, removed))
            allowed = row.get("files", {}).get(path, 0)
            if path in held and lines > allowed:
                raise Stop(2, "footprint: %s changes %d lines of %s, its row allows %d"
                           % (name, lines, path, allowed), path)
    return commits

# Step 3: trial rebase in a worktree of the work folder.
def fresh_worktree(repo, path, rev):
    if os.path.exists(path): git(["worktree", "remove", "--force", path], repo)
    git(["worktree", "prune"], repo)
    rc, _, err = git(["worktree", "add", "--detach", path, rev], repo)
    if rc: raise Stop(4, "cannot make the worktree %s: %s" % (path, _last(err)), path)
def trial_rebase(wt, base, commits):
    """Rebases the worktree onto the kept head; returns the subjects that came out empty."""
    rc, _, err = git(IDENT + ["rebase", base], wt)
    if rc:
        sha = git(["rev-parse", "--verify", "-q", "REBASE_HEAD"], wt)[1]
        files = git(["diff", "--name-only", "--diff-filter=U"], wt)[1].splitlines()
        git(["rebase", "--abort"], wt)
        if not sha: raise Stop(4, "the trial rebase fails: %s" % _last(err))
        raise Stop(1, "conflict: %s %s in %s" % (sha[:9], dict(commits).get(sha, ""), ", ".join(files)), sha)
    after = git(["log", "--format=%s", base + "..HEAD"], wt)[1].splitlines()
    return [s for _, s in commits if s not in after]

# Step 4: tripwires. Callers are source files in server/ and packages/, tests left out.
def is_test(path):
    parts = path.split("/")
    return ".test." in parts[-1] or ".spec." in parts[-1] or bool({"__tests__", "test", "tests"} & set(parts[:-1]))
def callers(cwd, hooks, rev=None):
    args = ["grep", "-l", "-F"] + [a for n in hooks["sshCopyCalls"] for a in ("-e", n + "(")]
    rc, out, err = git(args + ([rev] if rev else []) + ["--"] + SOURCES, cwd)
    if rc > 1: raise Stop(4, "cannot search for the SSH copy calls: %s" % _last(err))
    return sorted(f for f in (l.split(":", 1)[1] if rev else l for l in out.splitlines()) if not is_test(f))
def tripwires(wt, hooks):
    for path in callers(wt, hooks):
        if path not in hooks["sshCopyCallers"]:
            raise Stop(3, "tripwire: %s holds an SSH copy call off the reviewed list" % path, path)
    try:
        with open(os.path.join(wt, ISSUES), encoding="utf-8") as f:
            count = f.read().count(ISSUE_CALL)
    except OSError:
        count = 0
    if count != hooks["issueWorkspaceChecks"]:
        raise Stop(3, "tripwire: %s holds %d workspace checks, fork/hooks.json %d"
                   % (ISSUES, count, hooks["issueWorkspaceChecks"]), ISSUES)

# Step 5: install, type and token checks, the tests of the commits that are in, the guard's own tests.
def _fails(cmds, cwd):
    """The last line of the first failing command and its type errors, or "" when all pass."""
    for argv in cmds:
        rc, tail, errors = run_tool(argv, cwd)
        if rc: return tail or "exit %d" % rc, errors
    return "", frozenset()
def run_tests(repo, work, wt, base, commits, rows, update=False):
    install = [["pnpm", "install", "--no-frozen-lockfile" if update else "--frozen-lockfile", "--prefer-offline", "--store-dir", os.path.join(work, "pnpm-store")]]
    tail = _fails(install, wt)[0]
    if tail: raise Stop(4, "the install fails: %s" % tail)
    results = [(name, _fails(cmds, wt)) for name, cmds in CHECKS]
    failed = dict((name, errors) for name, (tail, errors) in results if tail)
    files = [t for _, s in commits for t in rows[s].get("tests", [])]
    for path in files:
        if not os.path.isfile(os.path.join(wt, path)): raise Stop(3, "fork test missing: %s" % path, path)
    vitest = [f for f in files if not f.endswith(".py")]
    own = [sys.executable, "-m", "unittest", "discover", "-s", "fork", "-p", "test_*.py"]
    for argv, what, names in ((["pnpm", "exec", "vitest", "run"] + vitest, "fork tests", vitest),
                              (own, "the guard's own tests", ["fork/test_rebase_guard.py"])):
        tail = _fails([argv], wt)[0] if names else ""
        if tail: raise Stop(3, "%s fail: %s" % (what, tail), " ".join(names))
    if not failed: return ""
    up = os.path.join(work, "upstream")
    fresh_worktree(repo, up, base)
    tail = _fails(install, up)[0]
    if tail: raise Stop(4, "the install fails on upstream's head: %s" % tail)
    both = dict((name, _fails(cmds, up)) for name, cmds in CHECKS if name in failed)
    only = [name for name in both if not both[name][0]]
    if only: raise Stop(3, "%s fails on the fork's head only" % only[0], only[0])
    added = [(name, sorted(failed[name] - both[name][1])) for name in both]
    added = [(name, new) for name, new in added if new]
    if added: raise Stop(3, "%s adds %d type error(s) to upstream's: %s" % (added[0][0], len(added[0][1]), added[0][1][0]), added[0][0])
    plain = [name for name in both if not failed[name]]
    if plain: raise Stop(5, "skipped: %s fails on upstream's head too" % ", ".join(plain), ", ".join(plain),
                         dict((name, both[name][0]) for name in plain))
    return "; upstream's own type errors, none added: " + ", ".join(both)

# Step 6: record. The worktree is removed on success and kept on failure.
def record(work, command, heads, stop):
    data = {"time": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "command": command, "upstream_head": heads.get("upstream"), "fork_head": heads.get("fork"),
            "result": stop.code, "line": stop.line, "failing": stop.failing, "upstream_failure": stop.upstream_failure}
    path = os.path.join(work, "last.json")
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(path + ".tmp", path)
def check(repo, heads, update=False):
    work, live, hooks = setup(repo, heads)
    skip_check(live)
    base = heads["upstream"] = fetch(repo, hooks["upstream"])
    rows = dict((row["subject"], row) for row in hooks["commits"])
    commits = footprint(repo, base, rows)
    wt = os.path.join(work, "worktree")
    fresh_worktree(repo, wt, "HEAD")
    taken = trial_rebase(wt, base, commits)
    tripwires(wt, hooks)
    types = run_tests(repo, work, wt, base, commits, rows, update)
    git(["worktree", "remove", "--force", wt], repo)
    note = "; taken upstream, empty: " + "; ".join(taken) if taken else ""
    raise Stop(0, "clean: %d fork commits replay onto %s%s%s" % (len(commits), base[:9], note, types))
def main(argv=None, repo=None):
    argv = sys.argv[1:] if argv is None else argv
    repo, heads = os.path.realpath(repo or REPO), {}
    try:
        if argv == ["idle"]:
            skip_check(folders()[1])
            live_check(repo)
            raise Stop(0, "idle: no live run; port %d free or served from this repository" % PORT)
        if argv[:1] != ["check"] or argv[1:] not in ([], ["--update-lockfile"]):
            raise Stop(4, "usage: rebase-guard.py check [--update-lockfile] | idle")
        check(repo, heads, argv[1:] == ["--update-lockfile"])
    except Stop as e:
        stop = e
    except Exception as e:
        stop = Stop(4, "setup fails: %r" % e)
    else:
        stop = Stop(4, "setup fails: the check ended without a verdict")
    print("rebase-guard %d: %s" % (stop.code, stop.line))
    if heads.get("work"): record(heads["work"], " ".join(argv), heads, stop)
    return stop.code

if __name__ == "__main__":
    sys.exit(main())
