// The View button's dialog: a PR's description, AI summary, comments and diff. The left list starts with
// Description (shown first), Summary (summary.js; generated only once its entry is opened) and Comments
// (comments, reviews and inline threads, newest first), then the files;
// the right side shows the picked one,
// with Approve and Merge in the footer. Opened by the panel as an overlay of this same mod with
// props { dialog: "view", gh, pr: { url, repo, number, title, author, assignees, approvals, mergeMethod, draft, mine } }.
// Approve (not on your own PRs) and Merge (once the PR has an approval; the repo's default merge method)
// each ask once more ("Confirm approve") before running gh. The dialog stays open with the result, posts
// a toast and tells the panel to refresh. Up/Down pick entries, Esc closes.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, TextView } from "gpui-base";
import { exec, run, props, closeOverlay, notify, theme, settings } from "herdr";
import { parseDiff, safeUrl, ago, COMMENTS_QUERY, parseComments } from "./prs.js";
import { summarize, cachedSummary } from "./summary.js";

export const VIEW_WIDTH = 0.9, VIEW_HEIGHT = 0.88;

const MERGE_FLAGS = { MERGE: "--merge", SQUASH: "--squash", REBASE: "--rebase" };
// pick values for the entries above the files (files are 0 and up).
const DESCRIPTION = -3, SUMMARY = -2, COMMENTS = -1;
const firstLine = (r) => (r.stderr || r.stdout || "gh failed").trim().split("\n")[0];

export class PrView {
  init(cx) {
    this.files = []; this.pick = DESCRIPTION; this.loading = true; this.error = null;
    this.body = null; this.bodyError = null; this.diff = null;
    this.summary = null; this.summaryError = null; this.summarizing = false;
    this.comments = null; this.commentsError = null; this.expanded = new Set();
    this.confirming = null; this.busy = null; this.status = null; this.done = new Set();
    this.approvals = props()?.pr?.approvals ?? 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const { gh, pr } = props();
    const url = safeUrl(pr?.url);
    this.loadComments(cx);
    cx.spawn(async (cx) => {
      try {
        if (!gh || !url) throw new Error("Missing gh or PR URL");
        const [r, b] = await Promise.all([
          exec(gh, ["pr", "diff", url, "--color", "never"]),
          exec(gh, ["pr", "view", url, "--json", "body", "-q", ".body"]),
        ]);
        if (b.code === 0) this.body = b.stdout.trim(); else this.bodyError = firstLine(b);
        if (r.code !== 0) throw new Error(firstLine(r));
        this.diff = r.stdout;
        this.files = parseDiff(r.stdout);
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
      if (this.pick === SUMMARY) this.summarize(cx);
    });
  }

  loadComments(cx) {
    const { gh, pr } = props();
    const [owner, name] = (pr?.repo ?? "").split("/");
    cx.spawn(async (cx) => {
      try {
        if (!gh || !owner || !name || !pr?.number) throw new Error("Missing gh or PR details");
        const r = await exec(gh, ["api", "graphql", "-f", `query=${COMMENTS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr.number}`]);
        if (r.code !== 0) throw new Error(firstLine(r));
        this.comments = parseComments(r.stdout);
      } catch (e) { this.commentsError = String(e.message ?? e); }
      finally { cx.notify(); }
    });
  }

  // On first opening the Summary entry: the last saved summary shows at once (summarize() replaces it if the
  // PR has changed since), and the request waits for the diff if that's still loading.
  openSummary(cx) {
    if (this.summaryOpened) return;
    this.summaryOpened = true;
    cx.spawn(async (cx) => {
      const saved = await cachedSummary(props().pr?.url).catch(() => null);
      if (saved && !this.summary) { this.summary = saved; cx.notify(); }
    });
    this.summarize(cx);
  }

  summarize(cx) {
    if (this.summarizing || this.diff == null) return;
    this.summarizing = true; this.summaryError = null; cx.notify();
    cx.spawn(async (cx) => {
      try { this.summary = await summarize(props().pr ?? {}, this.body ?? "", this.diff); }
      catch (e) { this.summaryError = String(e.message ?? e); }
      finally { this.summarizing = false; cx.notify(); }
    });
  }

  close() { closeOverlay(props().overlay); }

  // Approve and Merge each take two clicks: the first asks ("Confirm approve"), the second runs gh.
  // The dialog stays open afterwards and shows the result; the panel refreshes.
  act(action, cx) {
    if (this.busy || this.done.has(action)) return;
    if (this.confirming !== action) { this.confirming = action; this.status = null; return cx.notify(); }
    const { gh, pr } = props();
    const args = action === "approve" ? ["pr", "review", safeUrl(pr.url), "--approve"]
      : ["pr", "merge", safeUrl(pr.url), MERGE_FLAGS[pr.mergeMethod] ?? "--merge"];
    this.busy = action; this.status = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(gh, args);
        if (r.code !== 0) throw new Error(firstLine(r));
        this.done.add(action);
        if (action === "approve") this.approvals++;
        this.status = { text: action === "approve" ? "Approved" : "Merged", color: "ansi2" };
        notify({ title: `${this.status.text} ${pr.repo.split("/").pop()}#${pr.number}`, body: pr.title, level: "success", timeout: 4000 });
        run("my-prs.refresh");
      } catch (e) { this.status = { text: String(e.message ?? e), color: "ansi1" }; }
      finally { this.busy = null; this.confirming = null; cx.notify(); }
    });
  }

  select(i, cx) {
    this.pick = Math.max(DESCRIPTION, Math.min(this.files.length - 1, i));
    if (this.pick === SUMMARY) this.openSummary(cx);
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind.trim()))
      .child(div().flex_1().min_w(0).whitespace_nowrap().child(text));
  }

  entryRow(id, label, pick, t, count = null) {
    return h_flex().id(id).min_h(28).flex_none().px(8).py(4).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.pick === pick, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.select(pick, cx))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(count !== null, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(String(count))));
  }

  commentBody(id, body, t) {
    const open = (url) => { const safe = safeUrl(url); if (safe) exec("open", ["--", safe]).catch(() => {}); };
    return TextView.markdown(id, body).selectable(true).text_size(13).text_color(t.foreground).on_link_click(open);
  }

  byline(pr) {
    const others = (pr.assignees ?? []).filter((a) => a !== pr.author);
    return `by ${pr.author ?? "?"}${others.length ? ` (${others.join(", ")})` : ""}`;
  }

  commentHeader(author, at, t) {
    return h_flex().gap(6).items_center().text_size(12)
      .child(div().font_semibold().text_color(t.foreground).child(author))
      .child(div().text_color(t.dim).child(`${ago(at)} ago`));
  }

  commentCard(c, i, t) {
    const chip = (label, color) => div().flex_none().px(6).rounded(4).text_size(11).bg(t.hover).text_color(t[color] ?? t.muted).child(label);
    const faded = c.dismissed || (c.kind === "thread" && (c.resolved || c.outdated));
    // Dismissed reviews and their threads fold to the header line; a click on it toggles them.
    const folded = c.dismissed && !this.expanded.has(i);
    const toggle = (_e, cx) => { if (this.expanded.has(i)) this.expanded.delete(i); else this.expanded.add(i); cx.notify(); };
    return v_flex().id(`comment-${i}`).flex_none().gap(6).p(12).rounded(8).border_1().border_color(t.border).bg(t.raised)
      .when(faded, (e) => e.opacity(0.6))
      .child(h_flex().id(`comment-head-${i}`).gap(8).items_center()
        .when(c.dismissed, (e) => e.cursor_pointer().on_click(toggle)
          .child(div().flex_none().text_size(11).text_color(t.dim).child(folded ? "▸" : "▾")))
        .child(div().flex_1().min_w(0).child(this.commentHeader(c.author, c.at, t)))
        .when(Boolean(c.state), (e) => e.child(chip(c.state?.label ?? "", c.state?.color)))
        .when(c.kind === "thread" && c.dismissed, (e) => e.child(chip("Dismissed", "dim")))
        .when(c.kind === "thread" && c.resolved, (e) => e.child(chip("Resolved", "dim")))
        .when(c.kind === "thread" && c.outdated && !c.resolved, (e) => e.child(chip("Outdated", "dim")))
        .child(div().id(`comment-open-${i}`).flex_none().px(6).rounded(4).cursor_pointer().text_size(11).text_color(t.accent)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); const safe = safeUrl(c.url); if (safe) exec("open", ["--", safe]).catch(() => {}); }).child("Open")))
      .when(!folded, (e) => e.children(this.commentDetail(c, i, t)));
  }

  commentDetail(c, i, t) {
    return [
      ...(c.kind === "thread" ? [div().truncate().text_size(11).text_color(t.muted)
        .font_family(settings().font_family ?? "JetBrains Mono").child(`${c.path}${c.line ? `:${c.line}` : ""}`)] : []),
      ...(c.body.trim() ? [this.commentBody(`comment-body-${i}`, c.body, t)] : []),
      ...(c.replies ?? []).map((r, j) => v_flex().gap(4).mt(4).pl(10).border_l(2).border_color(t.border)
        .child(this.commentHeader(r.author, r.at, t))
        .child(this.commentBody(`comment-body-${i}-${j}`, r.body, t))),
    ];
  }

  commentList(t) {
    const message = this.commentsError ?? (this.comments == null ? "Loading comments…" : !this.comments.length ? "No comments yet" : null);
    return v_flex().id("pr-comments").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(10)
      .when(Boolean(message), (e) => e.child(div().whitespace_normal().text_color(this.commentsError ? t.ansi1 : t.dim).child(message ?? "")))
      .children((this.comments ?? []).map((c, i) => this.commentCard(c, i, t)));
  }

  summaryPane(t) {
    const open = (url) => { const safe = safeUrl(url); if (safe) exec("open", ["--", safe]).catch(() => {}); };
    const waiting = this.error ? "No diff to summarize" : "Summarizing…";
    return v_flex().id("pr-summary").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(10)
      .when(!this.summary && !this.summaryError, (e) => e.child(div().text_size(13).text_color(t.dim).child(waiting)))
      .when(Boolean(this.summary), (e) => e.child(TextView.markdown("pr-summary-text", this.summary ?? "").selectable(true).text_size(13).text_color(t.foreground).on_link_click(open)))
      .when(Boolean(this.summaryError), (e) => e.child(h_flex().gap(8).items_center().text_size(12)
        .child(div().flex_1().min_w(0).whitespace_normal().text_color(t.ansi1).child(this.summaryError ?? ""))
        .child(div().id("pr-summary-retry").flex_none().px(6).rounded(4).cursor_pointer().text_color(t.accent)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.summarize(cx)).child("Try again"))));
  }

  description(t) {
    const text = this.bodyError ?? (this.body == null ? (this.loading ? "Loading description…" : "") : this.body || "_No description provided._");
    return div().id("pr-description").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14)
      .child(TextView.markdown("pr-description-text", text).selectable(true).text_size(13).text_color(this.bodyError ? t.ansi1 : t.foreground)
        .on_link_click((url) => { const safe = safeUrl(url); if (safe) exec("open", ["--", safe]).catch(() => {}); }));
  }

  fileRow(f, i, t) {
    const parts = f.path.split("/"), name = parts.pop();
    return h_flex().id(`file-${i}`).min_h(28).flex_none().px(8).py(4).gap(8).items_center().rounded(7).cursor_pointer()
      .when(i === this.pick, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.select(i, cx))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(f.status === "D" ? t.dim : t.foreground).child(name))
        .when(parts.length > 0, (e) => e.child(div().truncate().text_size(10).text_color(t.dim).child(parts.join("/")))))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  button(id, label, bg, fg, border, onClick) {
    return h_flex().id(id).h(32).px(14).flex_none().items_center().rounded(8).border_1().border_color(border).bg(bg).text_color(fg)
      .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
  }

  actionButton(action, label, busyLabel, doneLabel, t) {
    const done = this.done.has(action);
    const text = this.busy === action ? busyLabel : done ? doneLabel : this.confirming === action ? `Confirm ${label.toLowerCase()}` : label;
    const color = action === "merge" ? t.accent : t.ansi2;
    return this.button(`pr-${action}`, text, done ? t.raised : color, done ? t.dim : t.background, done ? t.input : color,
      (_e, cx) => this.act(action, cx));
  }

  render() {
    const t = theme();
    const { pr = {} } = props() ?? {};
    const repo = (pr.repo ?? "").split("/").pop();
    const file = this.pick >= 0 ? this.files[this.pick] : null;
    const rows = file?.rows ?? [];
    const width = Math.max(400, ...rows.map((r) => r.text.length * 7 + 80));
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const message = this.error ?? (this.loading ? "Loading diff…" : !this.files.length ? "No changes" : null);
    return v_flex().id("pr-view").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { if (this.confirming && !this.busy) { this.confirming = null; cx.notify(); } else this.close(); }
        else if (e.key === "down") this.select(this.pick + 1, cx);
        else if (e.key === "up") this.select(this.pick - 1, cx);
        else return;
        cx.stop_propagation();
      })
      .size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().px(16).py(12).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().text_color(t.accent).child(`${repo}#${pr.number}`))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(pr.title ?? ""))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(this.byline(pr)))
        .when(this.files.length > 0, (e) => e
          .child(div().flex_none().text_size(12).text_color(t.muted).child(`${this.files.length} files`))
          .child(div().flex_none().text_size(12).text_color(t.ansi2).child(`+${add}`))
          .child(div().flex_none().text_size(12).text_color(t.ansi1).child(`−${del}`)))
        .child(div().id("pr-close").flex_none().size(26).flex().items_center().justify_center().rounded(7).cursor_pointer()
          .text_size(16).text_color(t.muted).tooltip("Close").hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.close()).child("×")))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .child(v_flex().id("pr-files").w(280).flex_none().min_h(0).overflow_y_scrollbar().p(6).gap(1).border_r(1).border_color(t.border).text_size(12)
          .child(this.entryRow("file-description", "Description", DESCRIPTION, t))
          .child(this.entryRow("file-summary", "Summary", SUMMARY, t))
          .child(this.entryRow("file-comments", "Comments", COMMENTS, t, this.comments ? this.comments.reduce((n, c) => n + 1 + (c.replies?.length ?? 0), 0) : null))
          .child(div().h(1).mx(8).my(4).flex_none().bg(t.border))
          .children(this.files.map((f, i) => this.fileRow(f, i, t)))
          .when(Boolean(message), (e) => e.child(div().p(8).whitespace_normal().text_color(this.error ? t.ansi1 : t.dim).child(message ?? ""))))
        .when(this.pick === DESCRIPTION, (e) => e.child(v_flex().flex_1().min_w(0).min_h(0).child(this.description(t))))
        .when(this.pick === SUMMARY, (e) => e.child(v_flex().flex_1().min_w(0).min_h(0).child(this.summaryPane(t))))
        .when(this.pick === COMMENTS, (e) => e.child(v_flex().flex_1().min_w(0).min_h(0).child(this.commentList(t))))
        .when(this.pick >= 0, (e) => e.child(v_flex().flex_1().min_w(0).min_h(0)
          .when(Boolean(file), (e) => e.child(div().flex_none().px(12).py(6).truncate().text_size(12).text_color(t.muted).border_b(1).border_color(t.border).child(file?.path ?? "")))
          .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
            .child(div().id("pr-diff-x").size_full().overflow_x_scrollbar()
              .child(div().w_full().min_w(width).h_full().child(v_virtual_list(`pr-diff-${this.pick}`, rows.length, 20, (i) => String(i),
                (range) => rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
            .child(Scrollbar.vertical(`pr-diff-${this.pick}`).viewport_from_layout().absolute().inset_0())))))
      .child(h_flex().flex_none().px(16).py(10).gap(8).items_center().border_t(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(this.status ? t[this.status.color] : t.dim)
          .child(this.status?.text ?? (this.confirming ? `${this.confirming === "approve" ? "Approve" : `Merge (${(pr.mergeMethod ?? "MERGE").toLowerCase()})`} this PR on GitHub? Esc to go back.` : "↑↓ description, summary, comments and files · Esc closes")))
        .child(this.button("pr-github", "Open on GitHub", t.raised, t.foreground, t.input, () => {
          const url = safeUrl(pr.url); if (url) exec("open", ["--", url]).catch(() => {});
        }))
        .when(!pr.mine, (e) => e.child(this.actionButton("approve", "Approve", "Approving…", "Approved", t)))
        .when(this.approvals > 0 && !pr.draft, (e) => e.child(this.actionButton("merge", "Merge", "Merging…", "Merged", t))));
  }
}
