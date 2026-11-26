// Top bar for the `tree` layout (cloned from the shipped `tabs`): no tab strip, the
// tree in the sidebar switches. Left: the focused pane's program, name, folder and
// status (what the pane header showed); on hover its split / zoom / close buttons.
// Right: +, Files and Changes as before, the side panel remembered per space.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, run, openOverlay, theme, window, shared, layout, settings, home } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class TopBar extends View {
  init() {
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const tab = space?.tabs.find(x => x.active);
    const all = panes();
    const f = focused();
    // The focused pane, else the shown tab's focused or first one.
    const p = all.find(x => x.pane === f?.pane && x.tab === tab?.id) ?? all.find(x => x.tab === tab?.id && x.focused) ?? all.find(x => x.tab === tab?.id);
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const paneButton = (id, icon, command) => div().id(id).p(4).rounded(5).flex_none().text_color(t.dim)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(id)
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run(command.name, { ...command.args, pane: p.pane }); })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
    const prog = p?.program;
    const name = p ? p.name || ((prog?.agent || prog?.shell) && prog.name) || p.title || prog?.name || "shell" : "";
    const st = p?.status;
    const info = h_flex().id("pane-info").flex_1().min_w(0).h_full().gap(8).items_center().text_size(12.8)
      .on_hover((on, cx) => { this.hovered = on; cx.notify(); })
      .when(Boolean(p), el => el
        .when(Boolean(prog?.icon), el => el.child(prog.tint ? svg(prog.icon).size(15).flex_none().text_color(t.muted) : image(prog.icon).size(15).flex_none()))
        .child(div().flex_none().max_w(260).truncate().font_medium().text_color(t.foreground).child(tab?.zoomed ? `${name} Z` : name))
        .child(div().flex_initial().min_w(0).truncate().text_color(t.dim).child(folder(p.cwd)))
        .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
        .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
        .child(div().flex_1())
        .when(this.hovered && Boolean(p.terminal), el => el
          .child(paneButton("Split right", "split-right", { name: "pane.split", args: { direction: "right" } }))
          .child(paneButton("Split down", "split-down", { name: "pane.split", args: { direction: "down" } }))
          .child(paneButton(p.zoomed ? "Unzoom" : "Zoom", p.zoomed ? "unzoom" : "zoom", { name: "pane.zoom", args: {} }))
          .child(paneButton("Close pane", "close", { name: "pane.close", args: {} }))));
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(info)
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/top-bar/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/top-bar/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/top-bar/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
