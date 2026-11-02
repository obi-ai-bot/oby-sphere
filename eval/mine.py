"""SZZ-style mining: for each fix or revert commit on origin/dev (or --ref), blame the lines it removed or changed in its
parent, and report the earlier squash-merged pull requests that wrote them (README.md, "The cases", step 1).
With --candidates it also applies step 2's size filter: the earlier pull request changed at most 700 lines,
the fix at most 25, and at least 2 of the fix's lines blame back to it.

    python3 eval/mine.py <oby checkout> [--candidates] [--ref <commit>] > pairs.json
"""
import re, subprocess, sys, json, collections
repo = sys.argv[1]
CANDIDATES = "--candidates" in sys.argv[2:]
REF = sys.argv[sys.argv.index("--ref") + 1] if "--ref" in sys.argv else "origin/dev"
def git(*a):
    return subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True).stdout
CODE = re.compile(r"\.(rs|ts|tsx|mjs|js|swift|py|sh)$")
SKIP = re.compile(r"(^|/)(tests?|e2e|fixtures?|docs?)/|_test\.|\.test\.|Tests?/|spikes/|design/")
out = []
for line in git("log", "--format=%H\t%s", REF).splitlines():
    sha, subj = line.split("\t", 1)
    if not re.match(r"(fix|revert)", subj, re.I):
        continue
    m = re.search(r"\(#(\d+)\)\s*$", subj)
    fix_pr = int(m.group(1)) if m else None
    diff = git("diff", "-U0", f"{sha}^", sha)
    files, cur, removed = {}, None, collections.defaultdict(list)
    for d in diff.splitlines():
        if d.startswith("--- a/"):
            cur = d[6:]
        elif d.startswith("--- /dev/null"):
            cur = None
        elif d.startswith("@@") and cur:
            mm = re.match(r"@@ -(\d+)(?:,(\d+))? ", d)
            start, n = int(mm.group(1)), int(mm.group(2) or 1)
            if n > 0:
                removed[cur].append((start, start + n - 1))
    code = {f: r for f, r in removed.items() if CODE.search(f) and not SKIP.search(f)}
    nlines = sum(b - a + 1 for r in code.values() for a, b in r)
    if not code or nlines > 40:
        continue
    blamed = collections.Counter()
    for f, ranges in code.items():
        args = ["blame", "--porcelain"]
        for a, b in ranges:
            args += ["-L", f"{a},{b}"]
        bl = git(*args, f"{sha}^", "--", f)
        for bline in bl.splitlines():
            mm = re.match(r"^([0-9a-f]{40}) \d+ \d+", bline)
            if mm:
                blamed[mm.group(1)] += 1
    for intro, count in blamed.most_common():
        isubj = git("log", "-1", "--format=%s", intro).strip()
        im = re.search(r"\(#(\d+)\)\s*$", isubj)
        if not im or (fix_pr and int(im.group(1)) == fix_pr):
            continue
        stat = git("show", "--shortstat", "--format=", intro).strip()
        out.append({"fix": sha[:10], "fix_subject": subj, "fix_lines": nlines, "intro": intro[:10], "intro_subject": isubj, "blamed_lines": count, "intro_stat": stat})
def size(stat):
    return sum(int(n) for n, _ in re.findall(r"(\d+) (insertion|deletion)", stat))


if CANDIDATES:
    out = [x for x in out if size(x["intro_stat"]) <= 700 and x["fix_lines"] <= 25 and x["blamed_lines"] >= 2]
    out.sort(key=lambda x: (x["fix_lines"], size(x["intro_stat"])))
json.dump(out, sys.stdout, indent=1)
