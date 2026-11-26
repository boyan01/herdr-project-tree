"""Copies the latest answer of the agent in a terminal, as the raw Markdown it wrote.

Usage: python3 -I reply.py <terminal>
Prints JSON: {agent, chars} on success, {error} otherwise.

The answer is the newest run of assistant text: text blocks up to the next tool call, so a
turn's closing reply rather than its narration between tools.
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


def last_run(blocks):
    """blocks: ("text", s) or ("tool", None) in file order -> the newest run of texts."""
    run, last = [], []
    for kind, text in blocks:
        if kind == "tool":
            run = []
        elif text and text.strip():
            run.append(text.strip())
            last = run
    return "\n\n".join(last)


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


def main():
    agent, path = session(foreground(sys.argv[1]))
    if agent == "agy":
        return {"error": "agy answers can't be read yet"}
    if not path:
        return {"error": "No agent session found in this terminal"}
    text = last_run({"claude": claude_blocks, "pi": pi_blocks, "codex": codex_blocks}[agent](path))
    # Codex appends citations of its memory files to an answer.
    text = re.sub(r"\s*<oai-mem-citation>.*?</oai-mem-citation>\s*", "\n", text, flags=re.S).strip()
    if not text:
        return {"error": "No answer yet"}
    env = dict(os.environ, LANG="en_US.UTF-8")
    subprocess.run(["pbcopy"], input=text.encode("utf-8"), env=env, check=True, timeout=5)
    return {"agent": agent, "chars": len(text)}


if __name__ == "__main__":
    try:
        out = main()
    except Exception as e:  # reported in the status bar
        out = {"error": str(e)}
    print(json.dumps(out, ensure_ascii=False))
