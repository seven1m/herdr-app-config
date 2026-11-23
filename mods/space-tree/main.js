// Spaces with their tabs nested underneath, and a tab's agents under it when it has more
// than one. A spinner means working; a colored dot means it needs you (blocked) or
// finished while you weren't looking.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, agents, panes, machines, run, openOverlay, theme, shared, setShared, setAgentOrder, layout } from "herdr";

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

// Same as the tabs mod: a tab nobody named follows its agent's live title.
function tabLabel(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
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

  // Every row of a space takes spaces dragged from its machine; a tab's rows take tabs dragged from
  // its space. The accent line marks where the dragged one will land.
  droppable(el, t, s, tab, { head = false, last = false, tabHead = false, tabLast = false } = {}) {
    const target = (d) => d?.kind === "space" ? ((s.machine ?? null) === d.machine ? s.id : null)
      : d?.kind === "tab" && tab && d.space === s.id ? tab.id : null;
    const d = this.drag;
    const moving = Boolean(d && this.over && this.over !== d.id);
    let line = null;
    if (moving && this.over === target(d)) {
      const list = d.kind === "space" ? spaces() : s.tabs;
      const down = list.findIndex((x) => x.id === d.id) < list.findIndex((x) => x.id === this.over);
      const [top, bottom] = d.kind === "space" ? [head, last] : [tabHead, tabLast];
      if (down && bottom) line = "bottom";
      else if (!down && top) line = "top";
    }
    const dimmed = moving && (d.kind === "space" ? s.id === d.id : tab?.id === d.id);
    return el.relative()
      .when(dimmed, (el) => el.opacity(0.5))
      .when(Boolean(line), (el) => el.child(div().absolute().left(0).right(0).h(2).rounded(1).bg(t.accent)
        .when(line === "top", (l) => l.top(0))
        .when(line === "bottom", (l) => l.bottom(0))))
      .on_mouse_move((_e, cx) => {
        if (!this.drag) return;
        const over = target(this.drag);
        if (over !== this.over) { this.over = over; cx.notify(); }
      });
  }

  drop() {
    const { drag: d, over } = this;
    this.drag = this.over = null;
    if (!d || !over || over === d.id) return;
    if (d.kind === "space") {
      const i = spaces().findIndex((x) => x.id === over);
      if (i >= 0) run("space.move", { id: d.id, index: i + 1 });
    } else {
      const i = spaces().find((x) => x.id === d.space)?.tabs.findIndex((x) => x.id === over) ?? -1;
      if (i >= 0) run("tab.move", { id: d.id, index: i + 1 });
    }
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

  spaceRow(t, s, color, last) {
    const folded = this.folded.has(s.id);
    const hidden = folded ? s.tabs : [];
    const urgent = hidden.find((tab) => tab.status === "blocked")?.status
      ?? hidden.find((tab) => tab.status === "done")?.status
      ?? hidden.find((tab) => tab.status === "working")?.status;
    return this.droppable(h_flex(), t, s, null, { head: true, last })
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
      .on_mouse_down("left", () => { this.drag = { kind: "space", id: s.id, machine: s.machine ?? null }; this.over = s.id; })
      .on_click(() => run("space.select", { id: s.id }))
      .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } }))
      .child(this.avatar(t, s, color))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(s.name))
      .when(Boolean(urgent), (el) => el.child(this.indicator(t, urgent)))
      // new-menu opens its tab in the shown space, so only the shown space offers it.
      .when(s.active, (el) => el.child(
        div().id(`tab-new-${s.id}`).px(4).rounded(4).flex_none().text_color(t.dim)
          .hover((h) => h.bg(t.hover).text_color(t.foreground))
          .tooltip("New tab")
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }); })
          .child("+")))
      .when(s.tabs.length > 0, (el) => el.child(
        div().id(`fold-${s.id}`).p(3).rounded(4).flex_none().text_color(t.dim)
          .hover((h) => h.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(s.id, cx); })
          .child(svg(`mods/space-tree/chevron-${folded ? "right" : "down"}.svg`).size(11))));
  }

  tabRow(t, s, tab, lead, edges) {
    const pic = icon(lead?.program, 14, t.muted);
    const shown = s.active && tab.active;
    const name = tabLabel(tab, lead);
    const select = () => {
      if (!s.active) run("space.select", { id: s.id });
      run("tab.select", { id: tab.id });
    };
    return this.droppable(h_flex(), t, s, tab, { tabHead: true, ...edges })
      .id(`tab-${tab.id}`)
      .h(26)
      .pl(35)
      .pr(8)
      .gap(8)
      .flex_none()
      .items_center()
      .rounded(8)
      .text_size(12.5)
      .cursor_pointer()
      .when(shown, (el) => el.bg(t.raised))
      .hover((h) => h.bg(t.hover))
      .on_mouse_down("left", (e) => {
        if (e.click_count === 2) run("tab.rename", { id: tab.id });
        this.drag = { kind: "tab", id: tab.id, space: s.id };
        this.over = tab.id;
      })
      .on_click(select)
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: s.id } } }); })
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().min_w(0).truncate().text_color(shown ? t.foreground : tab.settled ? t.dim : t.muted).child(tab.zoomed ? `${name} Z` : name))
      .child(this.indicator(t, tab.status) ?? div())
      .when(shown, (el) => el.child(div().id(`close-${tab.id}`).flex_none().text_color(t.dim)
        .hover((h) => h.text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: tab.id }); })
        .child(svg("mods/pane/close.svg").size(12))));
  }

  agentRow(t, s, a, tab, edges) {
    const pic = icon(a.program, 14, t.foreground);
    const quiet = a.status === "idle" && !a.focused;
    return this.droppable(h_flex(), t, s, tab, edges)
      .id(`agent-${a.address}`)
      .h(24)
      .pl(57)
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
      .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(label(a, tab, true)))
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

  // A machine's header, shown once any machine besides this computer is known. Clicking folds it.
  machineRow(t, m, collapsed) {
    const key = `machine:${m.name ?? ""}`, folded = this.folded.has(key), ready = !m.name || m.layout === "ready";
    const label = m.name ?? "This computer";
    const icon = svg(`mods/space-tree/${m.name ? "server" : "monitor"}.svg`).size(13).flex_none();
    const menu = (el) => el.on_mouse_down("right", () => openOverlay({ mod: "machine-menu", kind: "popup", width: 200, height: 41, props: { name: m.name } }));
    if (collapsed) {
      return h_flex().flex_none().justify_center().mt(4).child(h_flex().id(`machine-${m.name ?? "local"}`).relative().w(32).h(24).rounded(6)
        .justify_center().items_center().text_color(t.dim).cursor_pointer().hover((h) => h.bg(t.hover))
        .tooltip(m.name ? `${label} · ${m.layout}` : label)
        .on_click((_e, cx) => this.toggle(key, cx))
        .when(Boolean(m.name), menu)
        .child(icon)
        .when(Boolean(m.name), (el) => el.child(div().absolute().right(7).bottom(4).size(6).rounded(3).bg(ready ? t.ansi2 : t.dim))));
    }
    return h_flex().id(`machine-${m.name ?? "local"}`).h(26).mt(4).px(8).gap(7).flex_none().items_center().rounded(6)
      .text_size(11).text_color(t.dim).cursor_pointer().hover((h) => h.bg(t.hover))
      .on_click((_e, cx) => this.toggle(key, cx))
      .when(Boolean(m.name), menu)
      .child(icon)
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(!ready, (el) => el.child(div().flex_none().child(m.layout === "loading" ? "loading…" : "offline")))
      .when(ready, (el) => el.child(div().id(`machine-add-${m.name ?? "local"}`).flex_none().px(4).rounded(4)
        .hover((h) => h.bg(t.hover).text_color(t.foreground))
        .tooltip(`New space on ${label}`)
        .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m.name ?? "" }); })
        .child("+")))
      .child(div().size(6).rounded(3).flex_none().bg(ready ? t.ansi2 : t.dim))
      .child(svg(`mods/space-tree/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none());
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const sp = spaces();
    const colors = this.colors(sp);
    const all = agents();
    const ps = panes();

    const order = [];
    const rows = [];
    let activeAt = -1;
    const known = machines();
    const names = [...new Set([...known.map((m) => m.name), ...sp.map((s) => s.machine ?? null)].filter(Boolean))].sort();
    const groups = [null, ...names].map((name) => ({ name, layout: known.find((m) => m.name === name)?.layout ?? (name ? "unavailable" : "ready") }));
    const headers = names.length > 0;
    for (const [i, m] of groups.entries()) {
      if (headers && i > 0) rows.push(div().h(1).flex_none().mt(6).mb(2).mx(collapsed ? 6 : 4).bg(t.border));
      if (headers) rows.push(this.machineRow(t, m, collapsed));
      if (headers && this.folded.has(`machine:${m.name ?? ""}`)) continue;
      for (const s of sp.filter((s) => (s.machine ?? null) === m.name)) {
        const mine = all.filter((a) => a.space === s.id);
        if (s.active) activeAt = rows.length;
        if (collapsed) {
          rows.push(this.railRow(t, s, colors[s.id], mine));
          order.push(...mine.map((a) => a.address));
          continue;
        }
        const tabs = this.folded.has(s.id) ? [] : s.tabs;
        rows.push(this.spaceRow(t, s, colors[s.id], tabs.length === 0));
        if (this.folded.has(s.id)) continue;
        for (const [ti, tab] of tabs.entries()) {
          const inTab = mine.filter((a) => a.tab === tab.id);
          const shown = inTab.length > 1 ? inTab : [];
          const lastTab = ti === tabs.length - 1;
          const lead = ps.find((p) => p.tab === tab.id && p.program?.agent) ?? ps.find((p) => p.tab === tab.id);
          rows.push(this.tabRow(t, s, tab, lead, { tabLast: shown.length === 0, last: lastTab && shown.length === 0 }));
          order.push(...inTab.map((a) => a.address));
          rows.push(...shown.map((a, ai) => {
            const end = ai === shown.length - 1;
            return this.agentRow(t, s, a, tab, { tabLast: end, last: lastTab && end });
          }));
        }
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
        .on_mouse_up("left", (_e, cx) => { this.drop(); cx.notify(); })
        .on_hover((hovered, cx) => { if (!hovered && this.drag) { this.drag = this.over = null; cx.notify(); } })
        .children(rows));
  }
}
