// Gmail inbox messages under the calendar, unread ones bold. `fetch.py` talks IMAP (app password from Keychain);
// a row opens the message in a dialog (this mod again, with a `message` prop), ✓ marks it read.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, theme, appHome, run, layout, shared, setShared, props, openOverlay, closeOverlay } from "herdr";
import { shellEnv } from "./env.js";

const SHOWN = 25;
const REFRESH_MS = 120000;
const FOLD = 32;
// The dialog tells the list which uids it read or removed (archived, deleted), so rows update at once.
const CHANGED = "gmail.changed";

// Folding resizes this block in the layout to just its header, like the calendar; the old size is
// kept in shared state so unfolding puts it back.
function node(n, id) { if (n?.id === id) return n; for (const c of n?.children ?? []) { const f = node(c, id); if (f) return f; } return null; }
const isFolded = (id) => { const px = node(layout(), id)?.size?.px; return px != null && px <= FOLD + 12; };
function toggleFold(id) {
  const size = node(layout(), id)?.size;
  if (isFolded(id)) run("layout.resize", { id, ...(shared(`fold.${id}`) ?? { px: 240 }) });
  else { setShared(`fold.${id}`, size ?? { px: 240 }); run("layout.resize", { id, px: FOLD }); }
}

async function helper(args) {
  const r = await exec("/usr/bin/python3", ["-I", `${appHome()}/mods/gmail/fetch.py`, ...args]);
  let out;
  try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { throw new Error((r.stderr || r.stdout || "fetch.py failed").trim().split("\n").pop()); }
  if (out.error) throw new Error(out.error);
  return out;
}

function openUrl(url) {
  if (/^(https:\/\/|mailto:)/.test(url)) exec("open", ["--", url]).catch(() => {});
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const textToHtml = (s) => escapeHtml(s).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>");

function announce(kind, uid) {
  const prior = shared(CHANGED) ?? {};
  const list = (k) => (Array.isArray(prior[k]) ? prior[k].slice(-50) : []);
  setShared(CHANGED, { at: Date.now(), read: list("read"), removed: list("removed"), [kind]: [...list(kind), uid] });
}

function ago(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export default class Gmail extends View {
  init(initial, cx) {
    const overlay = props();
    if (overlay?.message) return this.initMessage(overlay, cx);
    this.block = initial?.block ?? "gmail";
    this.messages = []; this.unread = null; this.total = null; this.loading = false; this.generation = 0;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  get gmail() { return `https://mail.google.com/mail/u/${encodeURIComponent(this.account ?? "0")}/`; }

  // Background refreshes stay quiet: no redraw until results arrive, and the icon only spins for a
  // click. "Loading…" only shows before the first load finishes.
  refresh(cx, manual = false) {
    const generation = ++this.generation;
    this.loading = true; this.manual = manual;
    cx.spawn(async (cx) => {
      try {
        this.account ??= await shellEnv("HERDR_GMAIL_ACCOUNT");
        if (!this.account) throw new Error("Set HERDR_GMAIL_ACCOUNT in your shell to your Gmail address.");
        const out = await helper(["list", this.account, String(SHOWN)]);
        if (generation === this.generation) { this.messages = out.messages; this.unread = out.unread; this.total = out.total; this.error = null; }
      } catch (e) { if (generation === this.generation) this.error = String(e.message ?? e); }
      finally { if (generation === this.generation) { this.loading = false; this.loaded = true; } cx.notify(); }
    });
    if (manual) cx.notify();
  }

  initMessage(p, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try { this.full = await helper(["show", p.account, p.message.uid]); announce("read", p.message.uid); }
      catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  messageAct(command, cx) {
    const p = props();
    this.busy = command;
    cx.spawn(async (cx) => {
      try { await helper([command, p.account, p.message.uid]); announce("removed", p.message.uid); closeOverlay(p.overlay); }
      catch (e) { this.busy = null; this.error = String(e.message ?? e); cx.notify(); }
    });
    cx.notify();
  }

  open(m) {
    openOverlay({ mod: "gmail", kind: "dialog", width: 0.6, height: 0.75, props: { message: m, account: this.account } });
  }

  applyChanges() {
    const c = shared(CHANGED);
    if (!c?.at || c.at === this.changedAt) return;
    this.changedAt = c.at;
    this.markSeen(this.messages.filter((m) => c.read?.includes(m.uid)));
    this.drop(this.messages.filter((m) => c.removed?.includes(m.uid)));
  }

  markSeen(list) {
    const fresh = list.filter((m) => !m.seen);
    if (!fresh.length) return;
    this.messages = this.messages.map((m) => (fresh.includes(m) ? { ...m, seen: true } : m));
    this.unread = Math.max(0, (this.unread ?? 0) - fresh.length);
  }

  drop(list) {
    if (!list.length) return;
    this.messages = this.messages.filter((m) => !list.includes(m));
    this.unread = Math.max(0, (this.unread ?? 0) - list.filter((m) => !m.seen).length);
    this.total = Math.max(0, (this.total ?? 0) - list.length);
  }

  renderMessage(t) {
    const p = props() ?? {};
    const m = { ...p.message, ...this.full };
    const close = () => closeOverlay(p.overlay);
    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(30).px(14).items_center().rounded(8).border_1().border_color(bg).bg(bg).text_color(fg)
        .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(this.busy === id ? "…" : label);
    const body = this.full
      ? TextView.html("mail-body", this.full.html ?? textToHtml(this.full.text ?? "")).selectable(true).scrollable(true)
          .on_link_click((url) => openUrl(url)).flex_1().min_h(0).text_color(t.foreground)
      : div().flex_1().text_color(t.dim).child(this.error ? "" : "Loading…");
    return v_flex().id("mail-message").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => { if (e.key !== "escape") return; close(); cx.stop_propagation(); })
      .child(h_flex().items_start().gap(10)
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(15).font_semibold().text_color(t.foreground).whitespace_normal().child(m.subject ?? ""))
          .child(h_flex().gap(8).text_size(12).text_color(t.muted)
            .child(div().flex_1().min_w(0).truncate().child(m.from ?? ""))
            .child(div().flex_none().text_color(t.dim).child(m.date ? new Date(m.date).toLocaleString() : "")))
          .when(Boolean(m.to), (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(`to ${m.to}`))))
        .child(div().id("mail-close").flex_none().size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.muted).tooltip("Close (Esc)").hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(close).child("✕")))
      .child(div().h(1).flex_none().bg(t.border))
      .when(Boolean(this.error), (e) => e.child(div().whitespace_normal().text_color(t.ansi1).child(this.error ?? "")))
      .child(body)
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("archive", "Archive", t.raised, t.foreground, (_e, cx) => this.messageAct("archive", cx)))
        .child(button("delete", "Delete", t.ansi1, t.background, (_e, cx) => this.messageAct("delete", cx))));
  }

  // Drops the rows at once; a failure brings them back with the error.
  markRead(list, cx) { this.act("read", list.filter((m) => !m.seen), cx); }

  act(command, list, cx) {
    const uids = list.map((m) => m.uid).filter(Boolean);
    if (!uids.length) return;
    const before = { messages: this.messages, unread: this.unread, total: this.total };
    const picked = this.messages.filter((m) => uids.includes(m.uid));
    if (command === "read") this.markSeen(picked); else this.drop(picked);
    this.generation++;
    cx.spawn(async (cx) => {
      try { await helper([command, this.account, ...uids]); this.refresh(cx); }
      catch (e) { Object.assign(this, before); this.error = String(e.message ?? e); cx.notify(); }
    });
    cx.notify();
  }

  button(id, label, onClick, t) {
    return div().id(id).flex_none().px(6).rounded(4).cursor_pointer().text_size(11).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);
  }

  action(id, glyph, tip, color, run, t) {
    return div().id(id).flex_none().size(18).flex().items_center().justify_center().rounded(4)
      .text_size(11).text_color(color).border_1().border_color(t.border).tooltip(tip)
      .hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); run(cx); }).child(glyph);
  }

  row(m, t) {
    return v_flex().id(`mail-${m.uid}`).flex_none().px(4).mx(-4).py(4).gap(1).rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => this.open(m))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().size(6).rounded(3).when(!m.seen, (e) => e.bg(t.accent)))
        .child(div().flex_1().min_w(0).truncate().when(!m.seen, (e) => e.font_semibold()).text_color(m.seen ? t.muted : t.foreground).child(m.from))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(m.date ? ago(m.date) : ""))
        .when(!m.seen, (e) => e.child(this.action(`mail-read-${m.uid}`, "✓", "Mark read", t.muted, (cx) => this.act("read", [m], cx), t)))
        .child(this.action(`mail-archive-${m.uid}`, "⤓", "Archive", t.muted, (cx) => this.act("archive", [m], cx), t))
        .child(this.action(`mail-delete-${m.uid}`, "✕", "Delete", t.ansi1, (cx) => this.act("delete", [m], cx), t)))
      .child(div().pl(12).truncate().text_color(m.seen ? t.dim : t.muted).child(m.subject));
  }

  render() {
    const t = theme();
    if (props()?.message) return this.renderMessage(t);
    this.applyChanges();
    const count = this.unread === null ? (this.loading ? "loading…" : "") : `${this.unread} unread`;
    return v_flex().id("gmail").size_full().min_h(0).px(12).text_size(12).rounded(10).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().h(FOLD - 2).flex_none().gap(4).items_center().text_color(t.dim)
        .child(div().id("fold-mail").flex_1().min_w(0).truncate().cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click(() => toggleFold(this.block)).child(`${isFolded(this.block) ? "▸" : "▾"}  Mail · ${count}`))
        .when(this.unread > 0, (e) => e.child(this.button("mail-read-all", "Mark all read", (_e, cx) => this.markRead(this.messages, cx), t)))
        .child(this.button("mail-open", "Gmail", () => openUrl(`${this.gmail}#inbox`), t))
        .child(div().id("mail-refresh").px(6).rounded(4).cursor_pointer().text_color(t.muted).tooltip("Refresh")
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx, true))
          .child(svg("mods/gmail/refresh.svg").size(13).when(this.loading && this.manual, (e) => e.spin(900)))))
      .child(v_flex().id("gmail-list").flex_1().min_h(0).overflow_y_scrollbar().gap(1).pb(6)
        .when(Boolean(this.error), (e) => e.child(div().whitespace_normal().text_color(t.ansi1).child(this.error ?? "")))
        .when(!this.error && this.total === 0, (e) => e.child(div().text_color(t.dim).child("Inbox zero")))
        .children(this.messages.map((m) => this.row(m, t)))
        .when(this.total > this.messages.length && this.messages.length > 0, (e) => e.child(
          this.button("mail-more", `${this.total - this.messages.length} more in Gmail`, () => openUrl(`${this.gmail}#inbox`), t))));
  }
}
