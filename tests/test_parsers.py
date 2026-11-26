"""Sanitized offline unit tests for chat-view transcript parsing and reply viewport matching.

Run with:
  python3 -m unittest discover -s tests -v
"""

import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mods", "chat-view"))
sys.path.insert(0, os.path.join(ROOT, "mods", "space-tree"))

import reply  # noqa: E402
import transcript  # noqa: E402


def write_jsonl(records):
    f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
    for rec in records:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    f.close()
    return f.name


class TranscriptParserTests(unittest.TestCase):
    def tearDown(self):
        for p in getattr(self, "_files", []):
            try:
                os.unlink(p)
            except OSError:
                pass

    def make_jsonl(self, records):
        path = write_jsonl(records)
        self._files = getattr(self, "_files", []) + [path]
        return path

    def test_claude_parser_groups_tools_and_skips_meta(self):
        path = self.make_jsonl([
            {"type": "user", "isMeta": True, "message": {"content": "injected meta"}},
            {"type": "user", "message": {"content": [{"type": "text", "text": "Fix the title bug"}]}},
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "tool_use", "name": "Read", "input": {"file_path": "src/app.py"}},
                        {"type": "tool_use", "name": "Bash", "input": {"command": "pytest -q"}},
                    ]
                },
            },
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "Fixed the issue in `src/app.py`."}]},
            },
            {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "sidechain"}]}},
        ])
        items, truncated = transcript.build_items(transcript.parse_claude(path))
        self.assertEqual(truncated, 0)
        self.assertEqual([(it["role"], it["kind"]) for it in items], [
            ("user", "text"),
            ("assistant", "tools"),
            ("assistant", "markdown"),
        ])
        self.assertEqual(items[0]["text"], "Fix the title bug")
        self.assertEqual(len(items[1]["tools"]), 2)
        self.assertEqual(items[1]["tools"][0]["summary"], "src/app.py")
        self.assertEqual(items[2]["text"], "Fixed the issue in `src/app.py`.")

    def test_codex_parser_strips_citations_and_injected_context(self):
        path = self.make_jsonl([
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "<environment_context>cwd=/tmp</environment_context>"}],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Explain the diff"}],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "shell_command",
                    "arguments": json.dumps({"command": "git diff"}),
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Here is the summary.\n<oai-mem-citation>id=1</oai-mem-citation>"}],
                },
            },
        ])
        items, _ = transcript.build_items(transcript.parse_codex(path))
        self.assertEqual([(it["role"], it["kind"]) for it in items], [
            ("user", "text"),
            ("assistant", "tools"),
            ("assistant", "markdown"),
        ])
        self.assertEqual(items[0]["text"], "Explain the diff")
        self.assertEqual(items[1]["tools"][0]["summary"], "git diff")
        self.assertEqual(items[2]["text"], "Here is the summary.")

    def test_pi_parser(self):
        path = self.make_jsonl([
            {"type": "message", "message": {"role": "user", "content": "Check tests"}},
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "toolCall", "name": "bash", "arguments": {"command": "npm test"}},
                        {"type": "text", "text": "All 12 tests passed."},
                    ],
                },
            },
        ])
        items, _ = transcript.build_items(transcript.parse_pi(path))
        self.assertEqual([(it["role"], it["kind"]) for it in items], [
            ("user", "text"),
            ("assistant", "tools"),
            ("assistant", "markdown"),
        ])
        self.assertEqual(items[2]["text"], "All 12 tests passed.")

    def test_agy_parser_unwraps_user_request_and_splits_replies(self):
        path = self.make_jsonl([
            {"type": "USER_INPUT", "content": "<USER_REQUEST>\nInvestigate the crash\n</USER_REQUEST>"},
            {"type": "PLANNER_RESPONSE", "tool_calls": [{"name": "read_file", "args": {"Path": "/tmp/a.py"}}]},
            {"type": "GENERIC", "content": "file contents"},
            {"type": "PLANNER_RESPONSE", "content": "Working on it, please wait."},
            {"type": "SYSTEM_MESSAGE", "content": "background task done"},
            {"type": "PLANNER_RESPONSE", "content": "Root cause found and fixed."},
        ])
        items, _ = transcript.build_items(transcript.parse_agy(path))
        self.assertEqual(items[0]["text"], "Investigate the crash")
        self.assertEqual(items[1]["kind"], "tools")
        self.assertEqual(items[1]["tools"][0]["summary"], "/tmp/a.py")

        runs = reply.all_runs(reply.agy_blocks(path))
        self.assertEqual(runs, ["Working on it, please wait.", "Root cause found and fixed."])

    def test_reply_pick_visible_prefers_lowest_on_screen(self):
        runs = [
            "First answer explaining the architecture in detail for the reader.",
            "Second answer listing the exact commands to verify the rollout.",
            "Third answer that is scrolled below the current viewport window.",
        ]
        screen = (
            "First answer explaining the architecture in detail for the reader.\n"
            "Second answer listing the exact commands to verify the rollout.\n"
        )
        self.assertEqual(reply.pick_visible(runs, screen), 1)
        self.assertIsNone(reply.pick_visible(runs, "unrelated compiler output only"))


if __name__ == "__main__":
    unittest.main()
