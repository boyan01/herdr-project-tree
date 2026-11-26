// One tree in place of the separate Spaces and Agents lists:
//   project (space)
//     agent / terminal (one row per agent pane, else the tab's first terminal)
//       sub-agent
// Click a project to fold it, a row to focus that pane (and show its project).
// Right-click a project or a row for the shipped menus.
// Each project ends with a folded "History" node: past Claude Code / Codex / pi / agy
// sessions started in its terminals' folders (sessions.py); click one to resume it in a new tab.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, terminals, focused, run, theme, shared, openOverlay, setAgentOrder, layout, exec, appHome, window } from "herdr";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
// How each agent resumes a session, and its icon from the app's program table.
const RESUME = {
  claude: { argv: (id) => ["claude", "--resume", id], icon: "icons/claude.svg", tint: false },
  codex: { argv: (id) => ["codex", "resume", "--no-daemon", id], icon: "icons/codex.svg", tint: false },
  pi: { argv: (id) => ["pi", "--session", id], icon: "icons/pi.svg", tint: true },
  agy: { argv: (id) => ["agy", "--conversation", id], icon: "icons/antigravity.svg", tint: false },
};
const PAGE = 15;

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// Same avatar colors as the shipped spaces mod, so both layouts look alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Drops a status glyph / spinner an agent puts before its title (same rule as the agents mod).
const clean = (s) => (s ?? "").replace(/^(?:\[ [!.] \] |[✋⏳]️?(?=\s)|(?!(?:\p{Emoji}️|[#*]⃣))[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}])+/u, "").trim();

// A name someone gave (pane, then tab) wins, then the session's own title (live.py),
// then what the program put in the terminal title.
function label(tab, p, session) {
  if (p.name) return p.name;
  if (tab.named) return tab.name;
  if (session) return session;
  const prog = p.program?.name;
  const live = clean(p.title);
  const path = /^[~/]/.test((p.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== p.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== p.program?.key;
  return p.name || (telling ? live : prog || tab.name);
}

// A sub-agent without a pane reports its raw word; error counts as blocked, done as idle.
const kidStatus = (s) => (s === "error" ? "blocked" : s === "done" ? "idle" : s);

function icon(prog, size, color) {
  if (!prog?.icon) return null;
  return prog.tint ? svg(prog.icon).size(size).flex_none().text_color(color) : image(prog.icon).w(size).h(size).flex_none();
}

export default class SpaceTree extends View {
  init(_props, cx) {
    this.hist = {}; // space -> { open, loading, limit, items, error }
    this.titles = {}; // terminal -> its session's title (live.py)
    this.titlesKey = null;
    this.titlesAt = 0;
    // Titles change when a turn ends: look again then, and every 20 s anyway.
    cx.timer.every(2000, (cx) => this.refreshTitles(cx));
    try { this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]")); } catch { this.folded = new Set(); }
  }

  refreshTitles(cx) {
    if (this.titlesBusy || window()?.visible === false) return;
    const live = panes().filter((p) => p.terminal && p.program?.agent);
    const key = JSON.stringify(live.map((p) => [p.terminal, p.status]));
    if (key === this.titlesKey && Date.now() - this.titlesAt < 20000) return;
    this.titlesKey = key;
    this.titlesAt = Date.now();
    if (!live.length) return;
    this.titlesBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-I", `${appHome()}/mods/space-tree/live.py`, ...live.map((p) => p.terminal)]);
        if (r.code === 0) this.titles = JSON.parse(r.stdout);
      } catch {}
      this.titlesBusy = false;
      cx.notify();
    });
  }

  toggle(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  status(t, s) {
    if (s === "working") return svg(ICON("spinner")).size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (s === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (s === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    if (s === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none();
  }

  // Live sub-agents of `addr`, depth first.
  kids(all, addr, depth = 1) {
    return all
      .filter((k) => k.parent === addr && k.state === "live")
      .flatMap((k) => [{ k, depth }, ...this.kids(all, k.address, depth + 1)]);
  }

  spaceRow(t, s, folded, count) {
    const color = (shared("space.colors") ?? {})[s.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return h_flex()
      .id(`sp-${s.id}`)
      .h(32)
      .px(6)
      .flex_none()
      .gap(8)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => this.toggle(s.id, cx))
      .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } }))
      .child(h_flex().size(20).flex_none().rounded(6).bg(fill).items_center().justify_center().text_size(11).font_bold().text_color("#ffffff")
        .when(!s.active, (el) => el.opacity(0.55))
        .child([...s.name][0]?.toUpperCase() ?? "?"))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(s.active ? t.foreground : t.muted).child(s.name))
      .when(Boolean(s.branch) && s.branch !== "main" && s.branch !== "master", (el) => el.child(div().max_w(80).truncate().text_size(11).text_color(t.dim).child(s.branch)))
      .when(Boolean(s.machine), (el) => el.child(div().text_size(10).text_color(t.dim).child(s.machine)))
      // Folded: how many rows hide, and the most urgent state among them.
      .when(folded, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(count))))
      .when(folded && Boolean(s.status) && s.status !== "idle", (el) => el.child(this.status(t, s.status)))
      .child(div().id(`new-${s.id}`).flex_none().px(4).rounded(4).text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
        .tooltip("New tab here")
        .on_click((_e, cx) => { cx.stop_propagation(); run("tab.new", { space: s.id }); })
        .child(svg(ICON("plus")).size(12)))
      .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(11).flex_none().text_color(t.dim));
  }

  paneRow(t, tab, p, on) {
    const pic = icon(p.program, 15, t.foreground) ?? svg(ICON("terminal")).size(14).flex_none().text_color(t.dim);
    const quiet = !p.status || p.status === "idle";
    return h_flex()
      .id(`p-${p.pane}`)
      .h(27)
      .pl(8)
      .pr(6)
      .text_size(12.5)
      .flex_none()
      .gap(8)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .hover((x) => x.bg(t.hover))
      .on_click(() => run("pane.focus", { pane: p.pane }))
      .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "tab", target: { id: tab.id, space: tab.space } } }))
      .child(pic)
      .child(div().flex_1().min_w(0).truncate().text_color(on || !quiet ? t.foreground : t.muted).child(label(tab, p, this.titles[p.terminal])))
      .child(this.status(t, p.status));
  }

  kidRow(t, { k, depth }, on) {
    const pic = icon(k.program, 13, t.foreground);
    return h_flex()
      .id(`k-${k.address}`)
      .h(24)
      .pl(8 + depth * 14)
      .pr(6)
      .flex_none()
      .gap(7)
      .items_center()
      .rounded(8)
      .text_size(12)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.raised))
      .hover((x) => x.bg(t.hover))
      .on_click(() => run("terminal.peek", { terminal: k.address }))
      .child(div().text_color(t.dim).child("└"))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, kidStatus(k.status)));
  }

  // Sessions are read again each time the node opens or asks for more.
  load(s, cwds, cx) {
    const h = this.hist[s.id];
    h.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-I", `${appHome()}/mods/space-tree/sessions.py`, String(h.limit + 1), ...cwds]);
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
        h.items = JSON.parse(r.stdout);
        h.error = null;
      } catch (e) {
        h.error = String(e.message ?? e);
      }
      h.loading = false;
      cx.notify();
    });
  }

  historyRows(t, s, cwds) {
    const h = (this.hist[s.id] ??= { open: false, loading: false, limit: PAGE, items: [], error: null });
    const head = h_flex()
      .id(`hist-${s.id}`)
      .h(26)
      .pl(8)
      .pr(6)
      .flex_none()
      .gap(8)
      .items_center()
      .rounded(8)
      .text_size(12)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((x) => x.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        h.open = !h.open;
        if (h.open) { h.limit = PAGE; this.load(s, cwds, cx); } else cx.notify();
      })
      .child(svg(ICON("clock")).size(13).flex_none())
      .child(div().flex_1().child("History"))
      .when(h.loading, (el) => el.child(svg(ICON("spinner")).size(11).flex_none().spin(900)))
      .child(svg(ICON(h.open ? "chevron-down" : "chevron-right")).size(11).flex_none());
    if (!h.open) return [head];
    const now = Date.now();
    const rows = h.items.slice(0, h.limit).map((it) => {
      const a = RESUME[it.agent];
      const pic = a.tint ? svg(a.icon).size(13).flex_none().text_color(t.muted) : image(a.icon).w(13).h(13).flex_none();
      return h_flex()
        .id(`hs-${it.agent}-${it.id}`)
        .h(24)
        .pl(22)
        .pr(6)
        .flex_none()
        .gap(7)
        .items_center()
        .rounded(8)
        .text_size(12)
        .cursor_pointer()
        .hover((x) => x.bg(t.hover))
        .tooltip(`${it.title}\n${it.cwd}`)
        .on_click(() => run("tab.new", { space: s.id, folder: it.cwd, argv: a.argv(it.id) }))
        .child(pic)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(it.title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(now - it.at)));
    });
    const note = (id, text) => div().id(id).h(24).pl(22).flex_none().flex().items_center().text_size(11.5).text_color(t.dim).child(text);
    if (h.error) rows.push(note(`hist-err-${s.id}`, `Couldn't read: ${h.error}`));
    else if (!h.loading && !h.items.length) rows.push(note(`hist-none-${s.id}`, "No past sessions here"));
    if (h.items.length > h.limit) rows.push(note(`hist-more-${s.id}`, "More…")
      .cursor_pointer().hover((x) => x.text_color(t.foreground))
      .on_click((_e, cx) => { h.limit += PAGE; this.load(s, cwds, cx); }));
    return [head, ...rows];
  }

  render() {
    const t = theme();
    const sp = spaces();
    const ps = panes();
    const all = terminals();
    const shown = focused();
    const rail = narrow();
    const order = [];
    const rows = [];

    for (const s of sp) {
      const folded = this.folded.has(s.id);
      if (rail) {
        rows.push(h_flex().id(`sp-${s.id}`).h(28).mx(6).rounded(6).justify_center().items_center()
          .when(s.active, (el) => el.bg(t.selected)).hover((x) => x.bg(t.hover))
          .on_click(() => run("space.select", { id: s.id }))
          .child(div().text_color(s.active ? t.foreground : t.muted).child([...s.name][0]?.toUpperCase() ?? "?"))
          .when(Boolean(s.status) && s.status !== "idle", (el) => el.child(div().ml(3).child(this.status(t, s.status)))));
        continue;
      }
      const items = [];
      for (const tab of s.tabs) {
        const mine = ps.filter((p) => p.tab === tab.id && p.terminal);
        const ags = mine.filter((p) => p.status || p.program?.agent);
        // Every agent pane gets a row; a tab without one shows its first terminal.
        const list = ags.length ? ags : mine.slice(0, 1);
        for (const p of list) {
          order.push(p.terminal);
          const on = s.active && tab.active && (p.focused || list.length === 1);
          items.push(this.paneRow(t, { ...tab, space: s.id }, p, on));
          for (const kid of this.kids(all, p.terminal)) items.push(this.kidRow(t, kid, shown?.terminal === kid.k.address));
        }
      }
      // History matches where its terminals are now, which is also what names the space.
      const cwds = [...new Set(ps.filter((p) => s.tabs.some((tb) => tb.id === p.tab) && p.cwd).map((p) => p.cwd))];
      if (!cwds.length && s.folder) cwds.push(s.folder);
      const count = items.length;
      if (!folded && cwds.length) items.push(...this.historyRows(t, s, cwds));
      rows.push(v_flex().id(`g-${s.id}`).flex_none().mt(rows.length ? 10 : 4)
        .child(this.spaceRow(t, s, folded, count))
        .when(!folded && items.length > 0, (el) => el.child(v_flex().ml(15).pl(6).mt(2).gap(1).border_l(1.5).border_color(t.input).children(items))));
    }
    // agent.next / agent.prev follow the tree.
    setAgentOrder(order);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .when(!rail, (el) => el.child(h_flex().h(31).pl(16).pr(10).flex_none().items_center().justify_between().text_size(11.5).text_color(t.dim)
        .child("Projects")
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover((x) => x.bg(t.hover).text_color(t.foreground))
          .tooltip("New space")
          .on_click(() => run("space.new"))
          .child(svg(ICON("plus")).size(14)))))
      .child(v_flex().id("tree").flex_1().min_h(0).px(rail ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always").children(rows));
  }
}
