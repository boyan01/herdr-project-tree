// Native GPUI chat view for running coding agents (Claude Code, Codex, pi, agy).
// Shares the `main-stack` with the real terminal pane so switching TUI <-> GUI keeps
// the underlying process alive. Consumes the unified adapter contract from ./adapter.js.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, run, theme, layout, window, checking, notify } from "herdr";
import { createTranscriptAdapter } from "./adapter.js";

const POLL_MS = 1200;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function activePane() {
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs.find((t) => t.active);
  const all = panes();
  const f = focused();
  return (
    all.find((x) => x.pane === f?.pane && x.tab === tab?.id) ??
    all.find((x) => x.tab === tab?.id && x.focused) ??
    all.find((x) => x.tab === tab?.id) ??
    null
  );
}

function toolSummary(tools) {
  const names = [];
  for (const t of tools) {
    if (!names.includes(t.name)) names.push(t.name);
  }
  const shown = names.slice(0, 3).join(", ");
  const extra = names.length > 3 ? ` +${names.length - 3}` : "";
  const count = tools.length === 1 ? "1 tool call" : `${tools.length} tool calls`;
  return shown ? `${count} · ${shown}${extra}` : count;
}

export default class ChatView extends View {
  init(_props, cx) {
    this.adapter = createTranscriptAdapter();
    this.terminal = null;
    this.agent = null;
    this.sig = "";
    this.items = [];
    this.truncated = 0;
    this.tail = "";
    this.error = null;
    this.loading = false;
    this.busy = false;
    this.sending = false;
    this.expanded = new Set();
    this.hoveredMsg = null;
    this.copiedId = null;

    this.input = TextareaState.new({ placeholder: "Message agent… (⌘Enter to send)", rows: 2 });
    this.input.set_auto_grow(2, 6);
    this.input.set_soft_wrap(true);
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", (_e, cx) => this.send(cx));

    if (!checking()) {
      cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    }
  }

  isVisible() {
    if (window()?.visible === false) return false;
    const stack = find(layout(), "main-stack");
    return stack?.active === "main-chat";
  }

  switchToTui() {
    this.input.blur();
    run("layout.select", { stack: "main-stack", child: "main" });
  }

  poll(cx, force = false) {
    if (this.busy || !this.isVisible()) return;
    const p = activePane();
    const term = p?.terminal ?? null;
    if (!term || !p?.program?.agent) {
      if (this.terminal !== null || this.items.length) {
        this.terminal = null;
        this.agent = null;
        this.sig = "";
        this.items = [];
        this.truncated = 0;
        this.tail = "";
        this.error = null;
        cx.notify();
      }
      return;
    }

    const switched = term !== this.terminal;
    if (switched) {
      this.terminal = term;
      this.agent = null;
      this.sig = "";
      this.items = [];
      this.truncated = 0;
      this.tail = "";
      this.error = null;
      this.expanded = new Set();
      this.loading = true;
      cx.notify();
    }

    const wantTail = p.status === "working" || p.status === "blocked";
    const sinceSig = force || switched ? "" : this.sig;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const res = await this.adapter.poll(term, sinceSig, wantTail);
        if (term === this.terminal) {
          if (res.error) {
            this.error = res.error;
          } else {
            this.error = null;
            this.agent = res.agent ?? this.agent;
            this.tail = wantTail ? (res.tail ?? "") : "";
            if (!res.unchanged) {
              this.sig = res.sig ?? "";
              this.items = res.items ?? [];
              this.truncated = res.truncated ?? 0;
            }
          }
        }
      } catch (e) {
        if (term === this.terminal) this.error = String(e.message ?? e);
      }
      this.loading = false;
      this.busy = false;
      cx.notify();
    });
  }

  send(cx) {
    const text = this.input.value().trim();
    const term = this.terminal ?? activePane()?.terminal;
    if (!text || !term || this.sending) return;
    this.sending = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.adapter.send(term, text);
        this.input.set_value("");
      } catch (e) {
        notify({ title: "Couldn't send message", body: String(e.message ?? e), level: "error" });
      }
      this.sending = false;
      cx.notify();
      this.poll(cx, true);
    });
  }

  interrupt(cx) {
    const term = this.terminal ?? activePane()?.terminal;
    if (!term) return;
    cx.spawn(async (cx) => {
      try {
        await this.adapter.interrupt(term);
      } catch (e) {
        notify({ title: "Couldn't interrupt agent", body: String(e.message ?? e), level: "error" });
      }
      this.poll(cx, true);
    });
  }

  sendKeys(keys, cx) {
    const term = this.terminal ?? activePane()?.terminal;
    if (!term) return;
    cx.spawn(async (cx) => {
      try {
        await this.adapter.sendKeys(term, keys);
      } catch (e) {
        notify({ title: "Couldn't send keys", body: String(e.message ?? e), level: "error" });
      }
      this.poll(cx, true);
    });
  }

  copyItem(id, text, cx) {
    cx.write_to_clipboard(text);
    this.copiedId = id;
    cx.notify();
    cx.spawn(async (cx) => {
      await cx.sleep(1800);
      if (this.copiedId === id) {
        this.copiedId = null;
        cx.notify();
      }
    });
  }

  renderUser(t, item) {
    return v_flex()
      .id(`msg-${item.id}`)
      .w_full()
      .px(14)
      .py(10)
      .rounded(8)
      .bg(t.raised)
      .border_1()
      .border_color(t.border)
      .child(
        h_flex()
          .gap(10)
          .items_start()
          .child(div().w(2).self_stretch().rounded(1).bg(t.accent).flex_none())
          .child(div().flex_1().min_w(0).text_size(13.5).text_color(t.foreground).child(item.text))
      );
  }

  renderTools(t, item) {
    const open = this.expanded.has(item.id);
    const header = h_flex()
      .id(`tools-${item.id}`)
      .h(26)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(12)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.muted))
      .on_click((_e, cx) => {
        open ? this.expanded.delete(item.id) : this.expanded.add(item.id);
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/${open ? "chevron-down" : "chevron-right"}.svg`).size(11).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(toolSummary(item.tools)));

    if (!open) return header;

    return v_flex()
      .id(`tools-wrap-${item.id}`)
      .w_full()
      .gap(2)
      .child(header)
      .child(
        v_flex()
          .ml(12)
          .pl(10)
          .py(4)
          .gap(4)
          .border_l(1)
          .border_color(t.border)
          .children(
            item.tools.map((tl, idx) =>
              h_flex()
                .id(`tl-${item.id}-${idx}`)
                .gap(8)
                .items_center()
                .text_size(11.8)
                .child(div().flex_none().font_medium().text_color(t.muted).child(tl.name))
                .when(Boolean(tl.summary), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(tl.summary)))
            )
          )
      );
  }

  renderMarkdown(t, item) {
    const copied = this.copiedId === item.id;
    const showCopy = this.hoveredMsg === item.id || copied;
    return v_flex()
      .id(`md-wrap-${item.id}`)
      .w_full()
      .gap(4)
      .on_hover((on, cx) => {
        if (on) this.hoveredMsg = item.id;
        else if (this.hoveredMsg === item.id) this.hoveredMsg = null;
        cx.notify();
      })
      .child(
        h_flex()
          .h(20)
          .items_center()
          .justify_end()
          .when(showCopy, (el) =>
            el.child(
              h_flex()
                .id(`copy-${item.id}`)
                .h(20)
                .px(6)
                .gap(4)
                .items_center()
                .rounded(5)
                .cursor_pointer()
                .text_size(11)
                .text_color(copied ? t.done : t.dim)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => this.copyItem(item.id, item.text, cx))
                .child(svg(copied ? "mods/workspace-chrome/check.svg" : "mods/status-bar/copy.svg").size(11))
                .child(copied ? "Copied" : "Copy")
            )
          )
      )
      .child(
        div()
          .w_full()
          .text_size(13.5)
          .text_color(t.foreground)
          .child(TextView.markdown(`md-${item.id}`, item.text).selectable(true))
      );
  }

  renderBlockedBanner(t) {
    const quickBtn = (id, label, action, primary = false) =>
      div()
        .id(id)
        .h(24)
        .px(10)
        .flex()
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(11.8)
        .bg(primary ? t.accent : t.raised)
        .text_color(primary ? t.accent_foreground : t.foreground)
        .border_1()
        .border_color(primary ? t.accent : t.border)
        .hover((s) => (primary ? s.opacity(0.9) : s.bg(t.hover)))
        .on_click(action)
        .child(label);

    return v_flex()
      .id("blocked-banner")
      .w_full()
      .max_w(820)
      .mx_auto()
      .mb(8)
      .p(10)
      .gap(8)
      .rounded(8)
      .bg(t.blocked + "18")
      .border_1()
      .border_color(t.blocked + "55")
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().size(16).rounded(4).bg(t.blocked + "26").flex().items_center().justify_center().text_size(11).font_bold().text_color(t.blocked).child("!"))
          .child(div().flex_1().text_size(12.5).font_semibold().text_color(t.blocked).child("Agent needs your input"))
          .child(quickBtn("blk-tui", "Open in TUI", () => this.switchToTui(), true))
      )
      .when(Boolean(this.tail), (el) =>
        el.child(
          div()
            .w_full()
            .px(10)
            .py(6)
            .rounded(6)
            .bg(t.background)
            .border_1()
            .border_color(t.border)
            .text_size(11.5)
            .text_color(t.muted)
            .child(this.tail)
        )
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(quickBtn("blk-enter", "Enter", (_e, cx) => this.sendKeys(["enter"], cx)))
          .child(quickBtn("blk-y", "Allow (y)", (_e, cx) => this.sendKeys(["y", "enter"], cx)))
          .child(quickBtn("blk-n", "Deny (n)", (_e, cx) => this.sendKeys(["n", "enter"], cx)))
          .child(quickBtn("blk-esc", "Esc", (_e, cx) => this.sendKeys(["esc"], cx)))
      );
  }

  renderComposer(t, pane) {
    const working = pane?.status === "working";
    const blocked = pane?.status === "blocked";
    const hasText = Boolean(this.input.value().trim());
    const canSend = hasText && !this.sending && Boolean(pane?.terminal);

    return v_flex()
      .id("composer")
      .w_full()
      .flex_none()
      .px(20)
      .py(12)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .when(blocked, (el) => el.child(this.renderBlockedBanner(t)))
      .child(
        v_flex()
          .w_full()
          .max_w(820)
          .mx_auto()
          .gap(8)
          .on_key_down((e, cx) => {
            if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) {
              this.send(cx);
            }
          })
          .child(
            Textarea.new(this.input)
              .w_full()
              .px(12)
              .py(8)
              .rounded(8)
              .bg(t.background)
              .border_1()
              .border_color(t.input)
              .text_color(t.foreground)
              .text_size(13)
          )
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .text_size(11.5)
              .text_color(t.dim)
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(this.agent ? `${this.agent} · ⌘Enter to send` : "⌘Enter to send")
                  .child(
                    div()
                      .id("composer-tui")
                      .px(6)
                      .py(2)
                      .rounded(4)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      .on_click(() => this.switchToTui())
                      .child("Switch to TUI")
                  )
              )
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .when(working, (el) =>
                    el.child(
                      div()
                        .id("composer-stop")
                        .h(26)
                        .px(10)
                        .flex()
                        .items_center()
                        .rounded(6)
                        .cursor_pointer()
                        .bg(t.raised)
                        .border_1()
                        .border_color(t.border)
                        .text_size(12)
                        .text_color(t.blocked)
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) => this.interrupt(cx))
                        .child("Stop")
                    )
                  )
                  .child(
                    div()
                      .id("composer-send")
                      .h(26)
                      .px(12)
                      .flex()
                      .items_center()
                      .rounded(6)
                      .cursor_pointer()
                      .bg(canSend ? t.accent : t.raised)
                      .text_size(12)
                      .font_medium()
                      .text_color(canSend ? t.accent_foreground : t.dim)
                      .when(canSend, (el) => el.hover((s) => s.opacity(0.9)))
                      .on_click((_e, cx) => { if (canSend) this.send(cx); })
                      .child(this.sending ? "Sending…" : "Send")
                  )
              )
          )
      );
  }

  render() {
    const t = theme();
    const p = activePane();
    const isAgent = Boolean(p?.terminal && p?.program?.agent);

    if (!isAgent) {
      return v_flex()
        .size_full()
        .rounded(10)
        .overflow_hidden()
        .bg(t.background)
        .border_1()
        .border_color(t.border)
        .items_center()
        .justify_center()
        .gap(10)
        .child(div().text_size(13.5).text_color(t.muted).child("GUI chat view is available for agent terminals"))
        .child(
          div()
            .id("empty-to-tui")
            .h(28)
            .px(12)
            .flex()
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .text_size(12.5)
            .text_color(t.foreground)
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.switchToTui())
            .child("Switch to Terminal")
        );
    }

    const working = p.status === "working";
    const rows = [];

    if (this.truncated > 0) {
      rows.push(
        div()
          .id("trunc-note")
          .w_full()
          .py(4)
          .text_size(11.5)
          .text_color(t.dim)
          .child(`Showing latest ${this.items.length} items (${this.truncated} earlier hidden · switch to TUI for full scrollback)`)
      );
    }

    if (this.error) {
      rows.push(
        div()
          .id("chat-error")
          .w_full()
          .p(10)
          .rounded(8)
          .bg(t.blocked + "18")
          .border_1()
          .border_color(t.blocked + "44")
          .text_size(12.5)
          .text_color(t.blocked)
          .child(`Couldn't load transcript: ${this.error}`)
      );
    } else if (this.loading && !this.items.length) {
      rows.push(
        h_flex()
          .id("chat-loading")
          .gap(8)
          .py(20)
          .items_center()
          .text_size(12.5)
          .text_color(t.dim)
          .child(svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.muted).spin(900))
          .child("Loading conversation…")
      );
    } else if (!this.items.length) {
      rows.push(
        div()
          .id("chat-empty")
          .py(24)
          .text_size(13)
          .text_color(t.dim)
          .child("No messages yet. Send a prompt below to start.")
      );
    } else {
      for (const item of this.items) {
        if (item.role === "user") rows.push(this.renderUser(t, item));
        else if (item.kind === "tools") rows.push(this.renderTools(t, item));
        else if (item.kind === "markdown") rows.push(this.renderMarkdown(t, item));
      }
    }

    if (working) {
      rows.push(
        v_flex()
          .id("working-indicator")
          .w_full()
          .pt(6)
          .gap(6)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .text_size(12)
              .text_color(t.muted)
              .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900))
              .child("Working…")
          )
          .when(Boolean(this.tail), (el) =>
            el.child(
              div()
                .w_full()
                .px(10)
                .py(6)
                .rounded(6)
                .bg(t.raised)
                .border_1()
                .border_color(t.border)
                .text_size(11.5)
                .text_color(t.dim)
                .child(this.tail)
            )
          )
      );
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .child(
        v_flex()
          .id("chat-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .mode("always")
          .px(24)
          .py(18)
          .child(v_flex().w_full().max_w(820).mx_auto().gap(14).children(rows))
      )
      .child(this.renderComposer(t, p));
  }
}
