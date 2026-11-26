"""Past Claude Code / Codex / pi / agy sessions started in the given folders, newest first.

Usage: python3 -I sessions.py <limit> <folder>...
Prints JSON: [{agent, id, cwd, title, at}] (at: mtime, ms since the epoch).
"""

import glob
import json
import os
import re
import sys

HOME = os.path.expanduser("~")


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") in ("text", "input_text"))
    return ""


def first_line(s):
    """A prompt fit for a title: skips injected context (<tags>, # AGENTS.md ...)."""
    s = (s or "").strip()
    if not s or s.startswith("<") or s.startswith("# AGENTS.md") or s.startswith("Caveat:"):
        return None
    return " ".join(s.split())[:120]


def scan(path, pick, lines=400):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= lines:
                    break
                try:
                    found = pick(json.loads(line))
                except ValueError:
                    continue
                if found:
                    return found
    except OSError:
        pass
    return None


def claude_title(path):
    """The session's latest title record: custom-title (named, by /rename or Claude Code) or ai-title."""
    title = None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if '"custom-title"' not in line and '"ai-title"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                title = o.get("customTitle") or o.get("aiTitle") or title
    except OSError:
        pass
    return title


def claude(cwd):
    folder = os.path.join(HOME, ".claude/projects", re.sub(r"[^A-Za-z0-9]", "-", cwd))
    for path in glob.glob(os.path.join(folder, "*.jsonl")):
        def pick(o):
            if o.get("type") == "user" and not o.get("isMeta") and not o.get("isSidechain"):
                return first_line(text_of((o.get("message") or {}).get("content")))
        title = claude_title(path) or scan(path, pick)
        title = title and " ".join(title.split())[:120]
        if title:
            yield {"agent": "claude", "id": os.path.basename(path)[:-6], "cwd": cwd, "title": title, "at": int(os.path.getmtime(path) * 1000)}


def pi(cwd):
    folder = os.path.join(HOME, ".pi/agent/sessions", "--" + cwd.strip("/").replace("/", "-") + "--")
    for path in glob.glob(os.path.join(folder, "*.jsonl")):
        meta = scan(path, lambda o: o if o.get("type") == "session" else None, 1)
        def pick(o):
            m = o.get("message") or {}
            if o.get("type") == "message" and m.get("role") == "user":
                return first_line(text_of(m.get("content")))
        title = scan(path, pick)
        if meta and title:
            yield {"agent": "pi", "id": meta["id"], "cwd": cwd, "title": title, "at": int(os.path.getmtime(path) * 1000)}


def codex(cwds):
    names = {}
    try:
        with open(os.path.join(HOME, ".codex/session_index.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    o = json.loads(line)
                    if o.get("thread_name"):
                        names[o["id"]] = o["thread_name"]
                except ValueError:
                    pass
    except OSError:
        pass
    for path in glob.glob(os.path.join(HOME, ".codex/sessions/*/*/*/*.jsonl")):
        meta = scan(path, lambda o: o.get("payload") if o.get("type") == "session_meta" else None, 1)
        if not meta or meta.get("cwd") not in cwds:
            continue
        def pick(o):
            p = o.get("payload") or {}
            if o.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
                return first_line(text_of(p.get("content")))
        title = names.get(meta["id"]) or scan(path, pick)
        if title:
            yield {"agent": "codex", "id": meta["id"], "cwd": meta["cwd"], "title": " ".join(title.split())[:120], "at": int(os.path.getmtime(path) * 1000)}


def agy(cwds):
    import sqlite3
    try:
        db = sqlite3.connect(f"file:{HOME}/.gemini/antigravity-cli/conversation_summaries.db?mode=ro", uri=True, timeout=2)
        rows = db.execute("select conversation_id, title, workspace_uris, last_modified_time from conversation_summaries where title != '' and nesting_depth = 0").fetchall()
        db.close()
    except sqlite3.Error:
        return
    from datetime import datetime
    for cid, title, uris, at in rows:
        try:
            folders = [u.removeprefix("file://") for u in json.loads(uris)]
            ms = int(datetime.fromisoformat(at).timestamp() * 1000)
        except ValueError:
            continue
        cwd = next((f for f in folders if f in cwds), None)
        if cwd:
            yield {"agent": "agy", "id": cid, "cwd": cwd, "title": " ".join(title.split())[:120], "at": ms}


def main():
    limit = int(sys.argv[1])
    cwds = set(sys.argv[2:])
    out = [s for cwd in cwds for s in (*claude(cwd), *pi(cwd))]
    out += list(codex(cwds)) + list(agy(cwds))
    out.sort(key=lambda s: -s["at"])
    print(json.dumps(out[:limit], ensure_ascii=False))


if __name__ == "__main__":
    main()
