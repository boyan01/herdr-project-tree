// Native GPUI chat view for running coding agents (Claude Code, Codex, pi, agy).
// Shares `main-stack` with the real terminal pane so switching TUI <-> GUI keeps
// the underlying process alive and syncs scroll position from the TUI viewport.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, run, theme, layout, window, checking, notify } from "herdr";
import { createTranscriptAdapter } from "./adapter.js";

const POLL_MS = 1200;
const SESSION_RECHECK_MS = 15000;
const MAX_W = 760;
const PAGE_ITEMS = 30;

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
  const count = tools.length === 1 ? "1 tool" : `${tools.length} tools`;
  return shown ? `${count} · ${shown}${extra}` : count;
}

export default class ChatView extends View {
  init(_props, cx) {
    this.adapter = createTranscriptAdapter();
    this.scroll = ScrollHandle.new();
    this.cache = new Map(); // terminal -> { agent, path, pathAt, sig, items, truncated, limit, expanded, draft }
    this.wasVisible = false;
    this.terminal = null;
    this.agent = null;
    this.path = "";
    this.pathAt = 0;
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
    this.pendingScrollItem = null; // item index in `this.items`, or "bottom"
    this.hidingScroll = false;
    this.scrollGen = 0;
    this.rowCount = 0;
    this.itemRowOffset = 0;
    this.limit = PAGE_ITEMS;
    this.immediateScheduled = false;

    this.input = TextareaState.new({ placeholder: "Message agent…", rows: 1 });
    this.input.set_auto_grow(1, 5);
    this.input.set_soft_wrap(true);
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", (_e, cx) => this.send(cx));

    if (!checking()) {
      cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    }
  }

  isVisible() {
    if (window()?.visible === false) return false;
    return find(layout(), "main-stack")?.active === "main-chat";
  }

  isNearBottom() {
    try {
      const vp = this.scroll.viewport_size();
      const cs = this.scroll.content_size();
      const off = this.scroll.offset();
      if (!cs.height || !vp.height) return true;
      return off.y + vp.height >= cs.height - 80;
    } catch {
      return true;
    }
  }

  scrollToTarget(target) {
    const count = this.rowCount;
    if (!count) return;
    if (target === "bottom") {
      this.scroll.scroll_to_item(count - 1);
    } else if (typeof target === "number" && target >= 0) {
      const rowIdx = Math.min(count - 1, this.itemRowOffset + target);
      this.scroll.scroll_to_item(rowIdx);
    }
  }

  scheduleScroll(target, cx, hideDuringSettle = false) {
    // Request the scroll in the current frame, then verify across a few short ticks
    // until Markdown wrapping finishes expanding `content_size()`. When opening or
    // switching chats, keep the list hidden for those ~1-2 frames so it appears
    // directly at the final position with no jump or scroll animation.
    this.pendingScrollItem = target;
    if (hideDuringSettle) this.hidingScroll = true;
    const gen = ++this.scrollGen;
    if (!cx) return;
    cx.spawn(async (cx) => {
      let stable = 0;
      let prevH = -1;
      for (let step = 0; step < 8; step++) {
        await cx.sleep(24);
        if (gen !== this.scrollGen || !this.isVisible()) return;
        let h = 0;
        try { h = this.scroll.content_size().height; } catch {}
        const needMore =
          target === "bottom"
            ? (this.rowCount > 0 && !this.isNearBottom())
            : step === 0;
        if (needMore || (h > 0 && h !== prevH)) {
          this.scrollToTarget(target);
          cx.notify();
          stable = 0;
        } else if (h > 0) {
          stable += 1;
          if (stable >= 2) break;
        }
        prevH = h;
      }
      if (gen === this.scrollGen && this.hidingScroll) {
        this.hidingScroll = false;
        cx.notify();
      }
    });
  }

  switchToTui() {
    this.input.blur();
    run("layout.select", { stack: "main-stack", child: "main" });
  }

  saveCache(term) {
    if (!term) return;
    this.cache.set(term, {
      agent: this.agent,
      path: this.path,
      pathAt: this.pathAt,
      sig: this.sig,
      items: this.items,
      truncated: this.truncated,
      limit: this.limit,
      expanded: this.expanded,
      draft: this.input.value(),
    });
  }

  loadCache(term) {
    const c = this.cache.get(term);
    if (!c) return false;
    this.agent = c.agent;
    this.path = c.path;
    this.pathAt = c.pathAt;
    this.sig = c.sig;
    this.items = c.items;
    this.truncated = c.truncated;
    this.limit = c.limit;
    this.expanded = c.expanded;
    this.input.set_value(c.draft ?? "");
    return true;
  }

  poll(cx, force = false) {
    const visible = this.isVisible();
    const justEntered = visible && !this.wasVisible;
    this.wasVisible = visible;
    if (!visible || this.busy) return;

    const p = activePane();
    const term = p?.terminal ?? null;
    if (!term || !p?.program?.agent) {
      if (this.terminal !== null || this.items.length) {
        this.saveCache(this.terminal);
        this.terminal = null;
        this.agent = null;
        this.path = "";
        this.pathAt = 0;
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
      this.saveCache(this.terminal);
      this.terminal = term;
      this.tail = "";
      this.error = null;
      const hit = this.loadCache(term);
      if (!hit) {
        this.agent = null;
        this.path = "";
        this.pathAt = 0;
        this.sig = "";
        this.items = [];
        this.truncated = 0;
        this.expanded = new Set();
        this.limit = PAGE_ITEMS;
        this.input.set_value("");
      }
      this.loading = !hit;
      if (hit && (!p.scroll || p.scroll.from_bottom === 0)) {
        this.scheduleScroll("bottom", cx, true);
      }
      cx.notify();
    }

    const wantTail = p.status === "working" || p.status === "blocked";
    const syncTui = justEntered || switched;
    // Only sync a historical TUI viewport position when Herdr explicitly reports
    // scrollback (`from_bottom > 0`). On alt-screen TUIs like agy (`p.scroll == null`),
    // we cannot tell scroll position reliably, so always open at the bottom.
    const anchor = syncTui && p.scroll && p.scroll.from_bottom > 0 ? p.scroll : null;
    const wasAtBottom = this.isNearBottom();
    const prevTail = this.tail;
    const sinceSig = force ? "" : this.sig;
    // Reuse cached session path to skip `hc get` + `lsof`, re-verifying periodically
    // (or on enter) so `/new` inside the same terminal still switches cleanly.
    const reuseSession =
      !force &&
      !justEntered &&
      this.agent &&
      this.path &&
      Date.now() - this.pathAt < SESSION_RECHECK_MS
        ? { agent: this.agent, path: this.path }
        : null;

    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const res = await this.adapter.poll(term, { sinceSig, wantTail, anchor, limit: this.limit, session: reuseSession });
        if (term === this.terminal) {
          if (res.error) {
            this.error = res.error;
          } else {
            this.error = null;
            this.agent = res.agent ?? this.agent;
            if (res.path !== undefined) {
              this.path = res.path;
              if (!reuseSession) this.pathAt = Date.now();
            }
            const nextTail = wantTail ? (res.tail ?? "") : "";
            const tailChanged = nextTail !== prevTail;
            this.tail = nextTail;
            if (!res.unchanged) {
              this.sig = res.sig ?? "";
              this.items = res.items ?? [];
              this.truncated = res.truncated ?? 0;
            }
            this.saveCache(term);
            if (syncTui) {
              let lastTextIdx = -1;
              for (let i = this.items.length - 1; i >= 0; i--) {
                if (this.items[i].kind !== "tools") { lastTextIdx = i; break; }
              }
              const useAnchor = Boolean(anchor) && typeof res.anchor === "number" && res.anchor >= 0 && res.anchor < lastTextIdx;
              this.scheduleScroll(useAnchor ? res.anchor : "bottom", cx, true);
            } else if (wasAtBottom && (!res.unchanged || tailChanged)) {
              this.scheduleScroll("bottom", cx, false);
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
        this.scheduleScroll("bottom", cx);
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
      await cx.sleep(1600);
      if (this.copiedId === id) {
        this.copiedId = null;
        cx.notify();
      }
    });
  }

  wrapRow(id, child, pt = 0, pb = 0) {
    return div()
      .id(id)
      .flex_none()
      .w_full()
      .px(24)
      .pt(pt)
      .pb(pb)
      .child(div().w_full().max_w(MAX_W).mx_auto().child(child));
  }

  renderUser(t, item, isFirst) {
    const bubble = div()
      .max_w(600)
      .px(14)
      .py(10)
      .rounded(12)
      .bg(t.raised)
      .text_size(13.5)
      .text_color(t.foreground)
      .child(item.text);

    return this.wrapRow(
      `row-${item.id}`,
      h_flex().w_full().justify_end().child(bubble),
      isFirst ? 8 : 22,
      8
    );
  }

  renderTools(t, item) {
    const open = this.expanded.has(item.id);
    const pill = h_flex()
      .id(`tools-${item.id}`)
      .h(24)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(11.8)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.muted))
      .on_click((_e, cx) => {
        open ? this.expanded.delete(item.id) : this.expanded.add(item.id);
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/${open ? "chevron-down" : "chevron-right"}.svg`).size(10).flex_none())
      .child(div().truncate().child(toolSummary(item.tools)));

    const body = v_flex()
      .w_full()
      .gap(4)
      .child(h_flex().child(pill))
      .when(open, (el) =>
        el.child(
          v_flex()
            .ml(10)
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
                  .text_size(11.5)
                  .child(div().flex_none().font_medium().text_color(t.muted).child(tl.name))
                  .when(Boolean(tl.summary), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(tl.summary)))
              )
            )
        )
      );

    return this.wrapRow(`row-${item.id}`, body, 4, 4);
  }

  renderMarkdown(t, item) {
    const copied = this.copiedId === item.id;
    const showCopy = this.hoveredMsg === item.id || copied;
    const content = div()
      .id(`md-wrap-${item.id}`)
      .relative()
      .w_full()
      .on_hover((on, cx) => {
        if (on) this.hoveredMsg = item.id;
        else if (this.hoveredMsg === item.id) this.hoveredMsg = null;
        cx.notify();
      })
      .child(
        div()
          .w_full()
          .text_size(13.8)
          .text_color(t.foreground)
          .child(TextView.markdown(`md-${item.id}`, item.text).selectable(true))
      )
      .when(showCopy, (el) =>
        el.child(
          h_flex()
            .id(`copy-${item.id}`)
            .absolute()
            .top(0)
            .right(0)
            .h(22)
            .px(7)
            .gap(4)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .text_size(11)
            .text_color(copied ? t.done : t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.copyItem(item.id, item.text, cx))
            .child(svg(copied ? "mods/workspace-chrome/check.svg" : "mods/status-bar/copy.svg").size(11))
            .child(copied ? "Copied" : "Copy")
        )
      );

    return this.wrapRow(`row-${item.id}`, content, 8, 8);
  }

  renderBlockedBanner(t) {
    const quickBtn = (id, label, action, primary = false) =>
      div()
        .id(id)
        .h(24)
        .px(9)
        .flex()
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(11.5)
        .bg(primary ? t.accent : t.background)
        .text_color(primary ? t.accent_foreground : t.foreground)
        .border_1()
        .border_color(primary ? t.accent : t.border)
        .hover((s) => (primary ? s.opacity(0.9) : s.bg(t.hover)))
        .on_click(action)
        .child(label);

    return v_flex()
      .id("blocked-banner")
      .w_full()
      .max_w(MAX_W)
      .mx_auto()
      .mb(10)
      .p(10)
      .gap(8)
      .rounded(10)
      .bg(t.blocked + "16")
      .border_1()
      .border_color(t.blocked + "44")
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().size(16).rounded(4).bg(t.blocked + "26").flex().items_center().justify_center().text_size(10.5).font_bold().text_color(t.blocked).child("!"))
          .child(div().flex_1().text_size(12.2).font_semibold().text_color(t.blocked).child("Needs approval"))
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
      .id("composer-wrap")
      .w_full()
      .flex_none()
      .px(24)
      .pt(6)
      .pb(14)
      .bg(t.background)
      .when(blocked, (el) => el.child(this.renderBlockedBanner(t)))
      .child(
        v_flex()
          .id("composer-box")
          .w_full()
          .max_w(MAX_W)
          .mx_auto()
          .rounded(12)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .on_key_down((e, cx) => {
            if (e.key === "enter" && (e.modifiers?.platform || e.modifiers?.control)) {
              this.send(cx);
            }
          })
          .child(
            Textarea.new(this.input)
              .w_full()
              .px(14)
              .pt(10)
              .pb(4)
              .bg(t.raised)
              .text_color(t.foreground)
              .text_size(13.5)
          )
          .child(
            h_flex()
              .px(12)
              .pb(8)
              .pt(4)
              .items_center()
              .justify_between()
              .text_size(11.5)
              .text_color(t.dim)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().size(6).rounded(3).bg(working ? t.working : blocked ? t.blocked : t.done))
                  .child(this.agent ? `${this.agent} · ⌘↵` : "⌘↵")
              )
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(
                    div()
                      .id("composer-tui")
                      .h(24)
                      .px(8)
                      .flex()
                      .items_center()
                      .rounded(6)
                      .cursor_pointer()
                      .text_color(t.dim)
                      .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      .on_click(() => this.switchToTui())
                      .child("TUI")
                  )
                  .when(working, (el) =>
                    el.child(
                      div()
                        .id("composer-stop")
                        .h(24)
                        .px(9)
                        .flex()
                        .items_center()
                        .rounded(6)
                        .cursor_pointer()
                        .bg(t.background)
                        .border_1()
                        .border_color(t.border)
                        .text_size(11.8)
                        .text_color(t.blocked)
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) => this.interrupt(cx))
                        .child("Stop")
                    )
                  )
                  .child(
                    div()
                      .id("composer-send")
                      .h(24)
                      .px(11)
                      .flex()
                      .items_center()
                      .rounded(6)
                      .cursor_pointer()
                      .bg(canSend ? t.accent : t.background)
                      .text_size(11.8)
                      .font_medium()
                      .text_color(canSend ? t.accent_foreground : t.dim)
                      .when(canSend, (el) => el.hover((s) => s.opacity(0.9)))
                      .on_click((_e, cx) => { if (canSend) this.send(cx); })
                      .child(this.sending ? "…" : "Send")
                  )
              )
          )
      );
  }

  render(cx) {
    const t = theme();
    const p = activePane();
    const isAgent = Boolean(p?.terminal && p?.program?.agent);

    // Trigger an immediate poll when switching into Chat or switching agent tabs,
    // instead of waiting for the next 1.2s timer tick.
    if (!checking() && isAgent && this.isVisible() && (!this.wasVisible || p.terminal !== this.terminal) && !this.busy && !this.immediateScheduled) {
      this.immediateScheduled = true;
      cx.spawn(async (cx) => {
        this.immediateScheduled = false;
        this.poll(cx);
      });
    }

    if (!isAgent) {
      this.rowCount = 0;
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
        .child(div().text_size(13).text_color(t.muted).child("Chat view is available for agent terminals"))
        .child(
          div()
            .id("empty-to-tui")
            .h(26)
            .px(12)
            .flex()
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .text_size(12)
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
        this.wrapRow(
          "row-trunc",
          h_flex()
            .justify_center()
            .child(
              h_flex()
                .id("load-earlier")
                .h(24)
                .px(10)
                .items_center()
                .rounded(12)
                .cursor_pointer()
                .bg(t.raised)
                .border_1()
                .border_color(t.border)
                .text_size(11.5)
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => {
                  this.limit += PAGE_ITEMS;
                  this.poll(cx, true);
                })
                .child(`Load earlier (${this.truncated} hidden)`)
            ),
          14,
          4
        )
      );
    }

    this.itemRowOffset = rows.length;

    if (this.error) {
      rows.push(
        this.wrapRow(
          "row-error",
          div()
            .p(10)
            .rounded(8)
            .bg(t.blocked + "16")
            .border_1()
            .border_color(t.blocked + "44")
            .text_size(12.5)
            .text_color(t.blocked)
            .child(`Couldn't load transcript: ${this.error}`),
          14,
          8
        )
      );
    } else if (this.loading && !this.items.length) {
      rows.push(
        this.wrapRow(
          "row-loading",
          h_flex()
            .gap(8)
            .items_center()
            .text_size(12.5)
            .text_color(t.dim)
            .child(svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.muted).spin(900))
            .child("Loading conversation…"),
          24,
          8
        )
      );
    } else if (!this.items.length) {
      rows.push(
        this.wrapRow(
          "row-empty",
          div().text_size(13).text_color(t.dim).child("No messages yet. Send a prompt below to start."),
          24,
          8
        )
      );
    } else {
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i];
        if (item.role === "user") rows.push(this.renderUser(t, item, i === 0));
        else if (item.kind === "tools") rows.push(this.renderTools(t, item));
        else if (item.kind === "markdown") rows.push(this.renderMarkdown(t, item));
      }
    }

    if (working) {
      rows.push(
        this.wrapRow(
          "row-working",
          v_flex()
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
                  .rounded(8)
                  .bg(t.raised)
                  .text_size(11.5)
                  .text_color(t.dim)
                  .child(this.tail)
              )
            ),
          8,
          12
        )
      );
    }

    // Bottom breathing spacer so `scroll_to_item(last)` reveals the final reply cleanly.
    rows.push(div().id("row-end-spacer").flex_none().h(12).w_full());
    this.rowCount = rows.length;
    if (this.pendingScrollItem !== null) {
      const target = this.pendingScrollItem;
      this.pendingScrollItem = null;
      this.scrollToTarget(target);
    }
    const showLatest = !this.hidingScroll && this.items.length > 0 && !this.isNearBottom();

    return v_flex()
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .w_full()
          .child(
            v_flex()
              .id("chat-scroll")
              .size_full()
              .when(this.hidingScroll, (el) => el.opacity(0))
              .overflow_y_scrollbar()
              .track_scroll(this.scroll)
              .mode("always")
              .children(rows)
          )
          .when(showLatest, (el) =>
            el.child(
              h_flex()
                .id("jump-latest")
                .absolute()
                .bottom(10)
                .right(20)
                .h(26)
                .px(10)
                .gap(4)
                .items_center()
                .rounded(13)
                .cursor_pointer()
                .bg(t.raised)
                .border_1()
                .border_color(t.border)
                .text_size(11.5)
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => { this.scrollToTarget("bottom"); cx.notify(); })
                .child("↓ Latest")
            )
          )
      )
      .child(this.renderComposer(t, p));
  }
}
