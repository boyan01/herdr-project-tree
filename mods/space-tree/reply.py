"""Copies an agent's reply from a terminal, as the raw Markdown it wrote.

Usage: python3 -I reply.py <terminal> [from_bottom [rows]]
Prints JSON: {agent, chars, fallback} on success, {error} otherwise.

Matches the terminal's current viewport against every run of assistant text in the session
(runs are separated by tool calls or user prompts) and picks the lowest match on screen;
falls back to the newest run when no reply is visible.
"""

import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from live import foreground, session  # noqa: E402


def records(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def clean_text(text):
    # Codex appends citations of its memory files to an answer.
    return re.sub(r"\s*<oai-mem-citation>.*?</oai-mem-citation>\s*", "\n", text, flags=re.S).strip()


def all_runs(blocks):
    """blocks: ("text", s) or ("tool", None) in file order -> all runs of assistant texts."""
    runs, run = [], []
    for kind, text in blocks:
        if kind == "tool":
            if run:
                runs.append("\n\n".join(run))
                run = []
        elif text and text.strip():
            run.append(text.strip())
    if run:
        runs.append("\n\n".join(run))
    return [t for t in (clean_text(r) for r in runs) if t]


def viewport(address, from_bottom=0, rows=0):
    """Text currently visible in the terminal's viewport."""
    cmd = ["hc", "read", address]
    if from_bottom > 0:
        cmd += ["--lines", str(from_bottom)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if r.returncode != 0:
        return ""
    if from_bottom <= 0:
        return r.stdout
    lines = r.stdout.splitlines()
    end = max(0, len(lines) - from_bottom)
    start = max(0, end - rows) if rows > 0 else 0
    return "\n".join(lines[start:end])


def strip_md(text):
    text = re.sub(r"^```[^\n]*$", "", text, flags=re.M)
    return re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)


def compact(text):
    return re.sub(r"[^\w]+", "", text.lower())


def pick_visible(runs, screen):
    """Index of the lowest reply visible on `screen`, or None when none matches."""
    s_norm = compact(screen)
    if not s_norm:
        return None
    best = None  # (lowest end offset in s_norm, run index)
    win = 32
    for idx, text in enumerate(runs):
        r_norm = compact(strip_md(text))
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


def claude_blocks(path):
    for o in records(path):
        if o.get("isSidechain"):
            continue
        content = (o.get("message") or {}).get("content")
        if o.get("type") == "assistant" and isinstance(content, list):
            for b in content:
                if b.get("type") == "text":
                    yield "text", b.get("text")
                elif b.get("type") == "tool_use":
                    yield "tool", None
        elif o.get("type") == "user" and not o.get("isMeta"):
            yield "tool", None  # a prompt or tool result ends the run


def pi_blocks(path):
    for o in records(path):
        m = o.get("message") or {}
        if o.get("type") != "message":
            continue
        if m.get("role") != "assistant":
            yield "tool", None
            continue
        for b in m.get("content") or []:
            if b.get("type") == "text":
                yield "text", b.get("text")
            elif b.get("type") == "toolCall":
                yield "tool", None


def codex_blocks(path):
    blocks = []
    for o in records(path):
        p = o.get("payload") or {}
        if o.get("type") == "response_item":
            if p.get("type") == "message" and p.get("role") == "assistant":
                blocks += [("text", b.get("text")) for b in p.get("content") or [] if b.get("type") == "output_text"]
            elif p.get("type") != "reasoning":
                blocks.append(("tool", None))
    return blocks


def agy_blocks(path):
    for o in records(path):
        t = o.get("type")
        if t == "PLANNER_RESPONSE":
            if o.get("content"):
                yield "text", o.get("content")
            if o.get("tool_calls"):
                yield "tool", None
        else:
            yield "tool", None


def main():
    address = sys.argv[1]
    from_bottom = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    rows = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    agent, path = session(foreground(address))
    if not path:
        return {"error": "No agent session found in this terminal"}
    runs = all_runs({"claude": claude_blocks, "pi": pi_blocks, "codex": codex_blocks, "agy": agy_blocks}[agent](path))
    if not runs:
        return {"error": "No answer yet"}
    idx = pick_visible(runs, viewport(address, from_bottom, rows))
    fallback = idx is None
    text = runs[-1] if fallback else runs[idx]
    env = dict(os.environ, LANG="en_US.UTF-8")
    subprocess.run(["pbcopy"], input=text.encode("utf-8"), env=env, check=True, timeout=5)
    return {"agent": agent, "chars": len(text), "fallback": fallback}


if __name__ == "__main__":
    try:
        out = main()
    except Exception as e:  # reported in the status bar
        out = {"error": str(e)}
    print(json.dumps(out, ensure_ascii=False))
