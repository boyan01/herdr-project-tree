"""Titles of the sessions running in live terminals.

Usage: python3 -I live.py <terminal>...
Prints JSON: {terminal: title}; terminals without a known title are left out.

Claude Code: the terminal's foreground pid -> ~/.claude/sessions/<pid>.json -> sessionId
-> that session's latest custom-title / ai-title (else the pid file's own non-derived name).
pi: `--session <id>` in its argv, else the newest session file in its folder written since
the process started. agy: the presence/<id>.lock (or conversations/<id>.db) the process holds
open -> its title in conversation_summaries.db. Codex sets its terminal title to its thread name already.
"""

import glob
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sessions import HOME, claude_title, first_line, scan, text_of  # noqa: E402


def foreground(address):
    try:
        r = subprocess.run(["hc", "get", address, "--json"], capture_output=True, text=True, timeout=5)
        return json.loads(r.stdout).get("foreground") or {}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {}


def started(pid):
    """The process's start, seconds since the epoch."""
    # macOS ps has no etimes: etime is [[dd-]hh:]mm:ss.
    try:
        r = subprocess.run(["ps", "-o", "etime=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
        days, _, clock = r.stdout.strip().rpartition("-")
        secs = 0
        for part in clock.split(":"):
            secs = secs * 60 + int(part)
        return time.time() - secs - int(days or 0) * 86400
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def claude_session(fg):
    """(path, the pid file) of the Claude Code session running as `fg`."""
    try:
        with open(os.path.join(HOME, ".claude/sessions", f"{fg['pid']}.json"), encoding="utf-8") as f:
            info = json.load(f)
    except (OSError, ValueError, KeyError):
        return None, {}
    sid, cwd = info.get("sessionId"), info.get("cwd") or fg.get("cwd") or ""
    folder = os.path.join(HOME, ".claude/projects", re.sub(r"[^A-Za-z0-9]", "-", cwd))
    return (os.path.join(folder, f"{sid}.jsonl") if sid else None), info


def newest_since(files, fg):
    since = started(fg.get("pid"))
    recent = [p for p in files if since and os.path.getmtime(p) >= since - 5]
    return max(recent, key=os.path.getmtime, default=None)


def arg_after(argv, flag):
    return argv[argv.index(flag) + 1] if flag in argv and argv.index(flag) + 1 < len(argv) else None


def pi_session(fg):
    folder = os.path.join(HOME, ".pi/agent/sessions", "--" + (fg.get("cwd") or "").strip("/").replace("/", "-") + "--")
    files = glob.glob(os.path.join(folder, "*.jsonl"))
    want = arg_after(fg.get("argv") or [], "--session")
    return next((p for p in files if want and want in os.path.basename(p)), None) or newest_since(files, fg)


def codex_session(fg):
    argv = fg.get("argv") or []
    files = glob.glob(os.path.join(HOME, ".codex/sessions/*/*/*/*.jsonl"))
    want = next((a for a in argv[2:] if re.fullmatch(r"[0-9a-f-]{36}", a)), None) if "resume" in argv else None
    if want:
        return next((p for p in files if want in os.path.basename(p)), None)
    # Only the newest few can have been written since the process started.
    files = sorted(files, key=os.path.getmtime)[-20:]
    cwd = fg.get("cwd")
    mine = [p for p in files if (scan(p, lambda o: o.get("payload") if o.get("type") == "session_meta" else None, 1) or {}).get("cwd") == cwd]
    return newest_since(mine, fg)


AGY = os.path.join(HOME, ".gemini/antigravity-cli")


def agy_conversation(fg):
    """The conversation an agy process is on: the presence/<id>.lock (or conversations/<id>.db) it holds open."""
    try:
        r = subprocess.run(["lsof", "-Fn", "-p", str(fg["pid"])], capture_output=True, text=True, timeout=5)
    except (OSError, KeyError, subprocess.TimeoutExpired):
        return None
    m = (
        re.search(r"/presence/([0-9a-f-]{36})\.lock$", r.stdout, re.M)
        or re.search(r"/conversations/([0-9a-f-]{36})\.db$", r.stdout, re.M)
    )
    return m.group(1) if m else arg_after(fg.get("argv") or [], "--conversation")


def agy_titles(where="", args=()):
    """{id: (title, workspace_uris json, last_modified)} from agy's summary index."""
    import sqlite3
    try:
        db = sqlite3.connect(f"file:{AGY}/conversation_summaries.db?mode=ro", uri=True, timeout=2)
        rows = db.execute("select conversation_id, title, workspace_uris, last_modified_time from conversation_summaries " + where, args).fetchall()
        db.close()
    except sqlite3.Error:
        return {}
    return {r[0]: r[1:] for r in rows if r[1]}


def agy(fg):
    cid = agy_conversation(fg)
    return cid and (agy_titles("where conversation_id = ?", (cid,)).get(cid) or (None,))[0]


def agent_of(fg):
    name = os.path.basename((fg.get("argv") or [""])[0])
    return "claude" if fg.get("name") == "claude" else name if name in ("pi", "codex", "agy") else None


def session(fg):
    """(agent, session file) of the agent running as `fg`; (None, None) when unknown."""
    agent = agent_of(fg)
    path = claude_session(fg)[0] if agent == "claude" else pi_session(fg) if agent == "pi" else codex_session(fg) if agent == "codex" else None
    return agent, path


def claude(fg):
    path, info = claude_session(fg)
    title = path and claude_title(path)
    if not title and info.get("nameSource") not in (None, "derived"):
        title = info.get("name")
    if not title and path:
        # No title yet (Claude Code names a session some turns in): its first prompt, as History does.
        def pick(o):
            if o.get("type") == "user" and not o.get("isMeta") and not o.get("isSidechain"):
                return first_line(text_of((o.get("message") or {}).get("content")))
        title = scan(path, pick)
    return title


def pi(fg):
    path = pi_session(fg)
    if not path:
        return None

    def pick(o):
        m = o.get("message") or {}
        if o.get("type") == "message" and m.get("role") == "user":
            return first_line(text_of(m.get("content")))
    return scan(path, pick)


def main():
    out = {}
    for address in sys.argv[1:]:
        fg = foreground(address)
        agent = agent_of(fg)
        title = {"claude": claude, "pi": pi, "agy": agy}.get(agent, lambda fg: None)(fg)
        if title:
            out[address] = " ".join(title.split())[:120]
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
