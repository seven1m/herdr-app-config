import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, theme, run, layout, shared, setShared } from "herdr";

function foldNode(n, id) { if (n?.id === id) return n; for (const c of n?.children ?? []) { const f = foldNode(c, id); if (f) return f; } return null; }
const isFolded = (id, px) => { const s = foldNode(layout(), id)?.size?.px; return s != null && s <= px + 12; };
function toggleFold(id, px) {
  const size = foldNode(layout(), id)?.size;
  if (size?.px != null && size.px <= px + 12) run("layout.resize", { id, ...(shared(`fold.${id}`) ?? { weight: 1 }) });
  else { setShared(`fold.${id}`, size ?? { weight: 1 }); run("layout.resize", { id, px }); }
}
const arrow = (id, px) => (isFolded(id, px) ? "▸" : "▾");

// Today's events, read-only from the macOS Calendar app's own database (every account the
// Calendar app syncs: iCloud, Google, Exchange). No EventKit, so no permission prompt.
// The schema is Apple's private one; a macOS update can break it and the panel then shows
// the sqlite error.
const DB = () => `${home()}/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb`;
const COCOA = 978307200;
const FOLD = 32;
// Rows are a fixed height so the block can size itself to them (capped, then it scrolls).
const ROW = 20, GAP = 2, MAX = 320;

const query = (day) => `
select ci.summary t, ci.all_day ad, c.external_id cid,
  cast(o.occurrence_date + ${COCOA} as int) st, cast(o.occurrence_end_date + ${COCOA} as int) en,
  coalesce(nullif(ci.conference_url, ''), nullif(ci.conference_url_detected, ''),
    (select url from Conference where owner_id = ci.ROWID and url != '' limit 1)) j,
  coalesce(l.title, '') || ' ' || coalesce(ci.url, '') || ' ' || coalesce(ci.description, '') x
from OccurrenceCache o
join CalendarItem ci on ci.ROWID = o.event_id
join Calendar c on c.ROWID = o.calendar_id
join Store s on s.ROWID = o.store_id
left join Participant p on p.ROWID = ci.self_attendee_id
left join Location l on l.ROWID = ci.location_id
where o.day = ${day - COCOA} and ci.entity_type = 2 and o.next_reminder_date is null
  and s.type = 2 and s.disabled = 0 and s.name != 'Reminders'
  and coalesce(p.status, 0) != 3 and ci.status != 3
order by ci.all_day desc, o.occurrence_date`;

const CALS = `
select c.external_id id, c.title, s.name acct from Calendar c join Store s on s.ROWID = c.store_id
where s.type = 2 and s.disabled = 0 and s.name != 'Reminders' and c.external_id is not null
  and exists (select 1 from CalendarItem where calendar_id = c.ROWID)
order by s.name, c.title`;

// Picks persist in shared state as calendar external ids; none saved = all but holidays and birthdays.
const PICKS = "mac-calendar.include";
const picked = (c) => { const p = shared(PICKS); return Array.isArray(p) ? p.includes(c.id) : !/holiday|birthday/i.test(c.title); };
const OOO = /\bOOO\b|out of (the )?office/i;

const LINK = /https:\/\/[^\s"'<>)]*(zoom\.us\/j|meet\.google\.com|teams\.microsoft\.com\/l\/meetup|whereby\.com|around\.co)[^\s"'<>)]*/i;

function midnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d / 1000); }
function hm(sec) {
  const d = new Date(sec * 1000), h = d.getHours(), m = d.getMinutes();
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}
function until(sec) {
  const m = Math.max(1, Math.round((sec - Date.now() / 1000) / 60));
  return m < 60 ? `in ${m}m` : `in ${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

async function sql(q) {
  const r = await exec("sqlite3", ["-readonly", "-json", DB(), q]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `sqlite3 exited ${r.code}`);
  return JSON.parse(r.stdout.trim() || "[]");
}

async function load() {
  const seen = new Set(), out = [];
  for (const e of await sql(query(midnight()))) {
    if (e.ad === 1 && OOO.test(e.t ?? "")) continue;
    const key = `${e.t}|${e.st}|${e.ad}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ cal: e.cid, title: (e.t ?? "").trim() || "(no title)", allDay: e.ad === 1, start: e.st, end: e.en, join: e.j || (e.x.match(LINK) ?? [])[0] || null });
  }
  return out;
}

export default class Calendar extends View {
  init(props, cx) {
    // Folding and auto-height act on this block id in the layout.
    this.block = props?.block ?? "mac-calendar";
    this.events = []; this.cals = []; this.picking = false; this.showPast = false; this.error = null; this.loaded = false;
    cx.timer.every(180000, (cx) => this.load(cx));
    cx.timer.every(60000, (cx) => cx.notify());
    this.load(cx);
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try { [this.events, this.cals] = await Promise.all([load(), sql(CALS)]); this.error = null; }
      catch (e) { this.error = String(e.message ?? e); }
      this.loaded = true;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const now = Date.now() / 1000;
    const on = new Set(this.cals.filter(picked).map((c) => c.id));
    const shown = this.events.filter((e) => on.has(e.cal));
    const timed = shown.filter((e) => !e.allDay);
    const allDay = shown.filter((e) => e.allDay);
    const left = timed.filter((e) => e.end > now);
    const current = left.find((e) => e.start <= now);
    const next = left.find((e) => e.start > now);
    const row = (e, i) => {
      const past = !e.allDay && e.end <= now;
      const isNow = e === current, isNext = e === next;
      const badge = isNow ? "now" : isNext ? until(e.start) : null;
      return h_flex().id(`ev-${i}`).h(ROW).flex_none().gap(6).items_center().rounded(4).px(4).mx(-4)
        .when(isNow || isNext, (el) => el.bg(t.hover))
        .child(div().w(52).flex_none().whitespace_nowrap().text_color(isNow || isNext ? t.accent : t.dim).child(e.allDay ? "all day" : hm(e.start)))
        .child(div().flex_1().min_w(0).truncate().text_color(past || e.allDay ? t.dim : t.foreground).child(e.title))
        .when(Boolean(badge), (el) => el.child(div().flex_none().text_color(t.accent).child(badge)))
        .when(Boolean(e.join) && !past, (el) => el.child(div().id(`join-${i}`).flex_none().px(6).rounded(4).text_color(t.accent)
          .hover((s) => s.bg(t.raised ?? t.hover).text_color(t.foreground))
          .on_click((_, cx) => { cx.stop_propagation(); if (/^https:\/\//i.test(e.join)) exec("open", ["--", e.join]); }).child(e.join.startsWith("tel:") ? "Call" : "Join")));
    };
    const toggle = (c) => setShared(PICKS, this.cals.filter((x) => (x === c) !== picked(x)).map((x) => x.id));
    const pick = (c, i) => h_flex().id(`cal-${i}`).h(ROW).flex_none().gap(8).items_center().rounded(4).px(4).mx(-4).hover((s) => s.bg(t.hover))
      .on_click(() => toggle(c))
      .child(div().w(12).h(12).flex_none().rounded(3).border_1().border_color(picked(c) ? t.accent : t.dim).when(picked(c), (el) => el.bg(t.accent)))
      .child(div().flex_1().min_w(0).truncate().text_color(picked(c) ? t.foreground : t.dim).child(c.title));
    const accts = [...new Set(this.cals.map((c) => c.acct))];
    const picker = v_flex().gap(GAP).pb(8).children(accts.flatMap((a) => [
      div().h(ROW).flex_none().flex().items_end().font_semibold().text_color(t.muted).child(a),
      ...this.cals.map((c, i) => [c, i]).filter(([c]) => c.acct === a).map(([c, i]) => pick(c, i)),
    ]));
    // Past timed events fold into one line so what's next leads; a click shows them.
    const past = timed.filter((e) => e.end <= now);
    const earlier = div().id("cal-earlier").h(ROW).flex_none().flex().items_center().text_color(t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click((_, cx) => { this.showPast = !this.showPast; cx.notify(); })
      .child(this.showPast ? `▾  ${past.length} earlier` : `▸  ${past.length} earlier`);
    const list = [
      ...allDay.map(row),
      ...(past.length ? [earlier] : []),
      ...(this.showPast ? past.map((e, i) => row(e, `p${i}`)) : []),
      ...left.map((e, i) => row(e, `l${i}`)),
    ];
    const note = this.error || (this.loaded && shown.length === 0);
    const n = this.picking ? accts.length + this.cals.length : list.length + (note ? 1 : 0);
    this.fit(Math.min(MAX, FOLD + Math.max(1, n) * (ROW + GAP) - GAP + 8 + 2));
    const btn = (id, label, fn) => div().id(id).px(6).rounded(4).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(fn).child(label);
    // The outlined card holds a separate scroll area, so folding never clips the outline.
    return v_flex().size_full().min_h(0).rounded(10).border_1().border_color(t.border).bg(t.background).overflow_hidden()
      .child(v_flex().id("cal-body").flex_1().min_h(0).px(12).text_size(12).overflow_y_scrollbar()
      .child(h_flex().h(FOLD - 2).flex_none().justify_between().items_center().text_color(t.dim)
        .child(div().id("fold-calendar").flex_1().min_w(0).truncate().cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => toggleFold(this.block, FOLD))
          .child(`${arrow(this.block, FOLD)}  Calendar · ${!this.loaded ? "loading…" : `${shown.length || "no"} event${shown.length === 1 ? "" : "s"} today`}`))
        .child(h_flex().gap(2)
          .child(div().id("cal-pick-wrap").tooltip("Choose calendars").child(btn("cal-pick", this.picking ? "Done" : svg("mods/mac-calendar/settings.svg").size(13), (_, cx) => { this.picking = !this.picking; cx.notify(); })))
          .child(div().id("cal-sync-wrap").tooltip("Sync").child(btn("cal-sync", svg("mods/mac-calendar/refresh.svg").size(13), (_, cx) => this.load(cx))))))
      .when(this.picking, (el) => el.child(picker))
      .when(!this.picking, (el) => el.child(v_flex().gap(GAP).pb(8)
        .when(Boolean(this.error), (el) => el.child(div().text_color(t.ansi1).child(this.error)))
        .when(this.loaded && !this.error && shown.length === 0, (el) => el.child(div().h(ROW).text_color(t.dim).child("Nothing on the calendar today")))
        .children(list))));
  }

  // Sizes the block to its rows, unless folded; only when the height changes.
  fit(px) {
    if (!this.loaded || isFolded(this.block, FOLD) || foldNode(layout(), this.block)?.size?.px === px) return;
    run("layout.resize", { id: this.block, px });
  }
}
