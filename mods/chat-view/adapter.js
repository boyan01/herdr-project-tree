// Data adapter boundary for chat-view.
// V1 implements the local transcript adapter (JSONL + `hc send` / `hc interrupt`).
// Future streaming backends (e.g. `codex app-server`) only need to implement the same
// { poll, send, interrupt, sendKeys } contract.

import { exec, hc, appHome } from "herdr";

export function createTranscriptAdapter() {
  return {
    async poll(terminal, { sinceSig = "", wantTail = false, anchor = null } = {}) {
      const args = ["-I", `${appHome()}/mods/chat-view/transcript.py`, terminal];
      if (sinceSig) args.push(sinceSig);
      if (wantTail) args.push("--tail");
      if (anchor) args.push("--anchor", String(anchor.from_bottom ?? 0), String(anchor.len ?? 0));
      const r = await exec("python3", args, { timeout: 10000 });
      if (r.code !== 0) {
        const msg = r.stderr.trim().split("\n").pop() || `exit ${r.code}`;
        return { error: msg };
      }
      return JSON.parse(r.stdout || "{}");
    },

    async send(terminal, text) {
      const r = await hc(["send", terminal, text]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `hc send failed (${r.code})`);
    },

    async interrupt(terminal) {
      const r = await hc(["interrupt", terminal]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `hc interrupt failed (${r.code})`);
    },

    async sendKeys(terminal, keys) {
      const r = await hc(["keys", terminal, ...keys]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `hc keys failed (${r.code})`);
    },
  };
}
