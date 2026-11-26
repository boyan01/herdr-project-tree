"""Structured conversation transcript adapter for Herdr's chat-view mod.

Usage: python3 -I transcript.py <terminal> [since_sig] [--tail] [--anchor <from_bottom> <rows>]
Prints JSON:
  {agent, sig, items: [{id, role, kind, ...}], truncated, anchor, tail?}
  or {unchanged: true, sig, anchor?, tail?} when the session file has not changed
  or {error: "..."} when no agent session is available.

Supports Claude Code, Codex, pi and agy via the shared locator in space-tree/live.py.
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "space-tree")))
from live import foreground, session  # noqa: E402
from reply import compact, strip_md, viewport  # noqa: E402
from sessions import text_of  # noqa: E402

MAX_ITEMS = 80


def records(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def clean_markdown(text):
    text = re.sub(r"\s*<oai-mem-citation>.*?</oai-mem-citation>\s*", "\n", text, flags=re.S)
    return text.strip()


def clean_user_text(text):
    s = (text or "").strip()
    if not s:
        return ""
    m = re.search(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", s, flags=re.S)
    if m:
        s = m.group(1).strip()
    if (
        not s
        or s.startswith("<environment_context>")
        or s.startswith("<permissions")
        or s.startswith("<INSTRUCTIONS>")
        or s.startswith("# AGENTS.md")
        or s.startswith("Caveat:")
        or s.startswith("<local-command-")
        or s.startswith("<command-name>")
    ):
        return ""
    return s


def summarize_args(args):
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except ValueError:
            return " ".join(args.split())[:100]
    if not isinstance(args, dict):
        return ""
    for key in (
        "toolSummary",
        "command",
        "CommandLine",
        "cmd",
        "path",
        "Path",
        "file_path",
        "TargetFile",
        "pattern",
        "query",
        "url",
        "Description",
        "Prompt",
    ):
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            return " ".join(val.split())[:100]
    for val in args.values():
        if isinstance(val, str) and val.strip():
            return " ".join(val.split())[:100]
    return ""


def parse_claude(path):
    events = []
    for o in records(path):
        if o.get("isSidechain"):
            continue
        t = o.get("type")
        content = (o.get("message") or {}).get("content")
        if t == "user" and not o.get("isMeta"):
            text = clean_user_text(text_of(content))
            if text:
                events.append(("user", text))
        elif t == "assistant" and isinstance(content, list):
            for b in content:
                bt = b.get("type")
                if bt == "text":
                    md = clean_markdown(b.get("text") or "")
                    if md:
                        events.append(("markdown", md))
                elif bt == "tool_use":
                    events.append(("tool", {
                        "name": b.get("name") or "tool",
                        "summary": summarize_args(b.get("input")),
                    }))
    return events


def parse_pi(path):
    events = []
    for o in records(path):
        if o.get("type") != "message":
            continue
        m = o.get("message") or {}
        role = m.get("role")
        content = m.get("content")
        if role == "user":
            text = clean_user_text(text_of(content))
            if text:
                events.append(("user", text))
        elif role == "assistant":
            for b in content or []:
                bt = b.get("type")
                if bt == "text":
                    md = clean_markdown(b.get("text") or "")
                    if md:
                        events.append(("markdown", md))
                elif bt == "toolCall":
                    events.append(("tool", {
                        "name": b.get("name") or "tool",
                        "summary": summarize_args(b.get("arguments")),
                    }))
    return events


def parse_codex(path):
    events = []
    for o in records(path):
        if o.get("type") != "response_item":
            continue
        p = o.get("payload") or {}
        pt = p.get("type")
        if pt == "message":
            role = p.get("role")
            if role == "user":
                text = clean_user_text(text_of(p.get("content")))
                if text:
                    events.append(("user", text))
            elif role == "assistant":
                parts = [b.get("text") or "" for b in p.get("content") or [] if b.get("type") == "output_text"]
                md = clean_markdown("\n\n".join(x for x in parts if x.strip()))
                if md:
                    events.append(("markdown", md))
        elif pt in ("function_call", "custom_tool_call"):
            events.append(("tool", {
                "name": p.get("name") or "tool",
                "summary": summarize_args(p.get("arguments") or p.get("input")),
            }))
    return events


def parse_agy(path):
    events = []
    for o in records(path):
        t = o.get("type")
        if t == "USER_INPUT":
            text = clean_user_text(o.get("content") or "")
            if text:
                events.append(("user", text))
        elif t == "PLANNER_RESPONSE":
            md = clean_markdown(o.get("content") or "")
            if md:
                events.append(("markdown", md))
            for tc in o.get("tool_calls") or []:
                if isinstance(tc, dict):
                    name = tc.get("name") or tc.get("tool") or "tool"
                    args = tc.get("args") or tc.get("arguments") or tc.get("input") or {}
                    events.append(("tool", {"name": name, "summary": summarize_args(args)}))
    return events


PARSERS = {
    "claude": parse_claude,
    "pi": parse_pi,
    "codex": parse_codex,
    "agy": parse_agy,
}


def build_items(events, max_items=MAX_ITEMS):
    """Groups consecutive tool calls and markdown chunks into renderable chat items."""
    items = []
    for kind, payload in events:
        if kind == "user":
            items.append({"role": "user", "kind": "text", "text": payload})
        elif kind == "tool":
            if items and items[-1]["kind"] == "tools":
                items[-1]["tools"].append(payload)
            else:
                items.append({"role": "assistant", "kind": "tools", "tools": [payload]})
        elif kind == "markdown":
            if items and items[-1]["kind"] == "markdown":
                items[-1]["text"] += "\n\n" + payload
            else:
                items.append({"role": "assistant", "kind": "markdown", "text": payload})
    truncated = max(0, len(items) - max_items)
    if truncated:
        items = items[-max_items:]
    for i, it in enumerate(items):
        it["id"] = f"m-{truncated + i}"
    return items, truncated


def screen_tail(address, max_lines=6):
    try:
        r = subprocess.run(["hc", "read", address], capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if r.returncode != 0:
        return ""
    lines = [ln.rstrip() for ln in r.stdout.splitlines() if ln.strip()]
    return "\n".join(lines[-max_lines:])


def file_sig(path):
    try:
        st = os.stat(path)
        return f"{path}:{st.st_size}:{st.st_mtime_ns}"
    except OSError:
        return ""


def match_anchor(items, screen):
    """Index of the lowest chat item visible on `screen`, or None when none matches."""
    s_norm = compact(screen)
    if not s_norm or not items:
        return None
    best = None  # (lowest end offset in s_norm, item index)
    win = 32
    for idx, it in enumerate(items):
        if it["kind"] not in ("markdown", "text"):
            continue
        r_norm = compact(strip_md(it.get("text") or ""))
        if len(r_norm) < 4:
            continue
        pos = -1
        if len(r_norm) < win:
            p = s_norm.rfind(r_norm)
            if p != -1:
                pos = p + len(r_norm)
        else:
            for i in range(0, len(r_norm) - win + 1, win // 2):
                p = s_norm.rfind(r_norm[i : i + win])
                if p != -1 and p + win > pos:
                    pos = p + win
            p = s_norm.rfind(r_norm[-win:])
            if p != -1 and p + win > pos:
                pos = p + win
        if pos != -1 and (best is None or (pos, idx) > best):
            best = (pos, idx)
    return best[1] if best else None


def main():
    raw = sys.argv[1:]
    want_tail = False
    anchor_args = None
    pos_args = []
    i = 0
    while i < len(raw):
        if raw[i] == "--tail":
            want_tail = True
            i += 1
        elif raw[i] == "--anchor" and i + 2 < len(raw):
            anchor_args = (int(raw[i + 1]), int(raw[i + 2]))
            i += 3
        else:
            pos_args.append(raw[i])
            i += 1
    if not pos_args:
        return {"error": "Missing terminal address"}
    address = pos_args[0]
    since_sig = pos_args[1] if len(pos_args) > 1 else ""
    agent, path = session(foreground(address))
    if not agent:
        return {"error": "No agent running in this terminal"}
    if not path:
        return {
            "agent": agent,
            "sig": "",
            "items": [],
            "truncated": 0,
            "anchor": None,
            "tail": screen_tail(address) if want_tail else "",
        }
    sig = file_sig(path)
    tail = screen_tail(address) if want_tail else ""
    if since_sig and sig == since_sig and anchor_args is None:
        return {"agent": agent, "unchanged": True, "sig": sig, "tail": tail}
    events = PARSERS[agent](path)
    items, truncated = build_items(events)
    anchor = None
    if anchor_args is not None:
        fb, rows = anchor_args
        anchor = match_anchor(items, viewport(address, fb, rows))
    if since_sig and sig == since_sig:
        return {"agent": agent, "unchanged": True, "sig": sig, "anchor": anchor, "tail": tail}
    return {
        "agent": agent,
        "sig": sig,
        "items": items,
        "truncated": truncated,
        "anchor": anchor,
        "tail": tail,
    }


if __name__ == "__main__":
    try:
        out = main()
    except Exception as e:
        out = {"error": str(e)}
    print(json.dumps(out, ensure_ascii=False))
