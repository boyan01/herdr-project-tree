import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, theme, run, window, keys, focused, exec, appHome } from "herdr";

// workspace-status plus "Copy reply": the focused agent's visible (or latest) reply, as the
// Markdown it wrote (space-tree/reply.py reads it from the session file and puts it on the clipboard).
export default class StatusBar extends View {
  copy(f, cx) {
    if (this.copying) return;
    const pane = f.pane ? panes().find((p) => p.pane === f.pane) : panes().find((p) => p.terminal === f.terminal);
    const args = ["-I", `${appHome()}/mods/space-tree/reply.py`, f.terminal];
    if (pane?.scroll) args.push(String(pane.scroll.from_bottom), String(pane.scroll.len));
    this.copying = { text: "Copying…" };
    cx.notify();
    cx.spawn(async (cx) => {
      let out;
      try {
        const r = await exec("python3", args, { timeout: 15000 });
        out = JSON.parse(r.stdout || "{}");
        if (!out.chars && !out.error) out.error = r.stderr.trim().split("\n").pop() || `exit ${r.code}`;
      } catch (e) {
        out = { error: String(e.message ?? e) };
      }
      this.copying = out.error
        ? { text: out.error, error: true }
        : { text: out.fallback ? `Copied latest (${out.chars.toLocaleString()} chars)` : `Copied ${out.chars.toLocaleString()} chars` };
      cx.notify();
      await cx.sleep(2500);
      this.copying = null;
      cx.notify();
    });
  }

  copyButton(t) {
    const f = focused();
    if (!f?.agent || !f.terminal) return null;
    const c = this.copying;
    return h_flex().id("copy-reply").gap(6).items_center().px(6).h(20).rounded(5).cursor_pointer()
      .text_color(c?.error ? t.blocked : c ? t.foreground : t.muted)
      .hover((x) => x.bg(t.hover).text_color(t.foreground))
      .tooltip("Copy the visible agent reply as Markdown (falls back to latest)")
      .on_click((_e, cx) => this.copy(f, cx))
      .child(svg(c && !c.error ? "mods/workspace-chrome/check.svg" : "mods/status-bar/copy.svg").size(12))
      .child(c?.text ?? "Copy reply");
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} ${list.length === 1 ? "agent" : "agents"}`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} ${needs === 1 ? "needs" : "need"} you`))))
      .child(div().flex_1())
      .when(Boolean(focused()?.agent), el => el.child(this.copyButton(t)))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
