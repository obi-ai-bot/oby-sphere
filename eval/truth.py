"""For a fix commit and the earlier commit that introduced the code it changed: the lines of the earlier
commit's version that the fix removed or changed (git blame, porcelain: original file and line numbers)."""
import re, subprocess, sys, json, collections
repo, fix, intro = sys.argv[1:4]
def git(*a):
    return subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True).stdout
intro_full = git("rev-parse", intro).strip()
diff = git("diff", "-U0", f"{fix}^", fix)
cur, removed = None, collections.defaultdict(list)
for d in diff.splitlines():
    if d.startswith("--- a/"): cur = d[6:]
    elif d.startswith("--- /dev/null"): cur = None
    elif d.startswith("@@") and cur:
        m = re.match(r"@@ -(\d+)(?:,(\d+))? ", d); s, n = int(m.group(1)), int(m.group(2) or 1)
        if n > 0: removed[cur].append((s, s + n - 1))
# Tests, fixtures and docs aren't where a reviewer finds the bug: they leave the ground truth, as mine.py's SKIP.
SKIP = re.compile(r"(^|/)(tests?|e2e|fixtures?|docs?)/|_test\.|\.test\.|Tests?/|spikes/|design/")
out = collections.defaultdict(list)
for f, ranges in removed.items():
    if SKIP.search(f):
        continue
    args = ["blame", "--porcelain"]
    for a, b in ranges: args += ["-L", f"{a},{b}"]
    lines = git(*args, f"{fix}^", "--", f).splitlines()
    sha = orig = None; fname = {}
    for l in lines:
        m = re.match(r"^([0-9a-f]{40}) (\d+) (\d+)", l)
        if m: sha, orig = m.group(1), int(m.group(2)); continue
        if l.startswith("filename ") and sha: fname[sha] = l[9:]
        if l.startswith("\t") and sha == intro_full:
            out[fname.get(sha, f)].append(orig)
res = {f: sorted(set(v)) for f, v in out.items()}
print(json.dumps(res))
