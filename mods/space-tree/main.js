// Spaces with their agents nested underneath. An agent shows a spinner while working
// and a colored dot when it needs you (blocked) or finished while you weren't looking.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, agents, panes, run, openOverlay, theme, shared, setShared, setAgentOrder, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Same avatar colors as the shipped spaces mod, which shares `space.colors` with us.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

// Drops a leading status glyph or spinner from an agent's title ("✦  Working").
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}~/]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function label(a, tab, many) {
  if (tab?.named && !many) return tab.name;
  const title = clean(a.title);
  const telling = title && title !== a.address && title !== a.program?.name && title.toLowerCase() !== a.program?.key && !/^[~/]/.test(title);
  return telling ? title : a.program?.name || tab?.name || a.address;
}

export default class SpaceTree extends View {
  init() {
    this.scroll = ScrollHandle.new();
    try { this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]")); } catch { this.folded = new Set(); }
  }

  toggle(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  colors(sp) {
    const current = shared("space.colors") ?? {};
    const ids = new Set(sp.map((s) => s.id));
    const kept = Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(current).length;
    for (const s of sp) {
      if (kept[s.id] || s.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[s.id] = PALETTE.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return kept;
  }

  indicator(t, status) {
    if (status === "working") return svg("mods/space-tree/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked" || status === "done") return div().size(8).mx(2).flex_none().rounded(4).bg(t[status]);
    return null;
  }

  avatar(t, s, color) {
    const fill = color?.startsWith("#") ? color : (MARK[color ?? "ansi6"] ?? t[color]);
    return h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center()
      .text_size(10.5).font_bold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?");
  }

  spaceRow(t, s, color, mine) {
    const folded = this.folded.has(s.id);
    const hidden = folded ? mine : [];
    const urgent = hidden.find((a) => a.status === "blocked")?.status
      ?? hidden.find((a) => a.status === "done")?.status
      ?? hidden.find((a) => a.status === "working")?.status;
    return h_flex()
      .id(`space-${s.id}`)
      .h(30)
      .px(8)
      .gap(9)
      .flex_none()
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .when(s.active, (el) => el.bg(t.selected))
      .when(!s.active, (el) => el.hover((h) => h.bg(t.hover)))
      .on_click(() => run("space.select", { id: s.id }))
      .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } }))
      .child(this.avatar(t, s, color))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(s.name))
      .when(Boolean(urgent), (el) => el.child(this.indicator(t, urgent)))
      .when(mine.length > 0, (el) => el.child(
        div().id(`fold-${s.id}`).p(3).rounded(4).flex_none().text_color(t.dim)
          .hover((h) => h.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(s.id, cx); })
          .child(svg(`mods/space-tree/chevron-${folded ? "right" : "down"}.svg`).size(11))));
  }

  agentRow(t, a, tab, many) {
    const pic = icon(a.program, 14, t.foreground);
    const quiet = a.status === "idle" && !a.focused;
    return h_flex()
      .id(`agent-${a.address}`)
      .h(26)
      .pl(35)
      .pr(8)
      .gap(8)
      .flex_none()
      .items_center()
      .rounded(8)
      .text_size(12.5)
      .cursor_pointer()
      .when(a.focused, (el) => el.bg(t.raised))
      .hover((h) => h.bg(t.hover))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(label(a, tab, many)))
      .child(this.indicator(t, a.status) ?? div());
  }

  railRow(t, s, color, mine) {
    const urgent = mine.find((a) => a.status === "blocked")?.status
      ?? mine.find((a) => a.status === "done")?.status
      ?? mine.find((a) => a.status === "working")?.status;
    return h_flex().flex_none().justify_center().child(
      h_flex()
        .id(`space-${s.id}`)
        .relative()
        .w(32)
        .h(28)
        .rounded(6)
        .justify_center()
        .items_center()
        .when(s.active, (el) => el.bg(t.selected))
        .when(!s.active, (el) => el.hover((h) => h.bg(t.hover)))
        .tooltip(s.name)
        .on_click(() => run("space.select", { id: s.id }))
        .child(this.avatar(t, s, color))
        .when(Boolean(urgent), (el) => el.child(div().absolute().right(1).top(1).child(this.indicator(t, urgent)))));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const sp = spaces();
    const colors = this.colors(sp);
    const all = agents();
    const tabs = new Map(sp.flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const perTab = new Map();
    for (const a of all) perTab.set(a.tab, (perTab.get(a.tab) ?? 0) + 1);

    const order = [];
    const rows = [];
    let activeAt = -1;
    for (const s of sp) {
      const mine = all.filter((a) => a.space === s.id);
      if (s.active) activeAt = rows.length;
      if (collapsed) {
        rows.push(this.railRow(t, s, colors[s.id], mine));
        order.push(...mine.map((a) => a.address));
        continue;
      }
      rows.push(this.spaceRow(t, s, colors[s.id], mine));
      if (this.folded.has(s.id)) continue;
      for (const a of mine) {
        rows.push(this.agentRow(t, a, tabs.get(a.tab), perTab.get(a.tab) > 1));
        order.push(a.address);
      }
    }
    setAgentOrder(order);

    const active = sp.find((s) => s.active)?.id;
    if (active !== this.revealed && activeAt >= 0) {
      this.revealed = active;
      this.scroll.scroll_to_item(activeAt);
    }

    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).flex_none().pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, (el) => el.pl(0).pr(0).justify_center())
        .when(!collapsed, (el) => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .hover((h) => h.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new"))
          .child(svg("mods/space-tree/plus.svg").size(14))))
      .child(v_flex().id("space-tree-list").flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).gap(1)
        .overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        .children(rows));
  }
}
