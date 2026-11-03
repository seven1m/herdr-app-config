// The View button's dialog: a PR's diff, file list on the left, the picked file's diff on the right,
// with Approve and Merge in the footer. Opened by the panel as an overlay of this same mod with
// props { dialog: "view", gh, pr: { url, repo, number, title, author, approvals, mergeMethod, draft, mine } }.
// Approve (not on your own PRs) and Merge (once the PR has an approval; the repo's default merge method)
// each ask once more ("Confirm approve") before running gh. The dialog stays open with the result, posts
// a toast and tells the panel to refresh. Up/Down pick files, Esc closes.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, run, props, closeOverlay, notify, theme, settings } from "herdr";
import { parseDiff, safeUrl } from "./prs.js";

export const VIEW_WIDTH = 0.9, VIEW_HEIGHT = 0.88;

const MERGE_FLAGS = { MERGE: "--merge", SQUASH: "--squash", REBASE: "--rebase" };
const firstLine = (r) => (r.stderr || r.stdout || "gh failed").trim().split("\n")[0];

export class PrView {
  init(cx) {
    this.files = []; this.pick = 0; this.loading = true; this.error = null;
    this.confirming = null; this.busy = null; this.status = null; this.done = new Set();
    this.approvals = props()?.pr?.approvals ?? 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const { gh, pr } = props();
    const url = safeUrl(pr?.url);
    cx.spawn(async (cx) => {
      try {
        if (!gh || !url) throw new Error("Missing gh or PR URL");
        const r = await exec(gh, ["pr", "diff", url, "--color", "never"]);
        if (r.code !== 0) throw new Error(firstLine(r));
        this.files = parseDiff(r.stdout);
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
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
    this.pick = Math.max(0, Math.min(this.files.length - 1, i));
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind.trim()))
      .child(div().flex_1().min_w(0).whitespace_nowrap().child(text));
  }

  fileRow(f, i, t) {
    const parts = f.path.split("/"), name = parts.pop();
    return h_flex().id(`file-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
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
    const file = this.files[this.pick];
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
        .child(div().flex_none().text_size(12).text_color(t.dim).child(`by ${pr.author ?? "?"}`))
        .when(this.files.length > 0, (e) => e
          .child(div().flex_none().text_size(12).text_color(t.muted).child(`${this.files.length} files`))
          .child(div().flex_none().text_size(12).text_color(t.ansi2).child(`+${add}`))
          .child(div().flex_none().text_size(12).text_color(t.ansi1).child(`−${del}`))))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .child(v_flex().id("pr-files").w(280).flex_none().min_h(0).overflow_y_scrollbar().p(6).gap(1).border_r(1).border_color(t.border).text_size(12)
          .children(this.files.map((f, i) => this.fileRow(f, i, t)))
          .when(Boolean(message), (e) => e.child(div().p(8).whitespace_normal().text_color(this.error ? t.ansi1 : t.dim).child(message ?? ""))))
        .child(v_flex().flex_1().min_w(0).min_h(0)
          .when(Boolean(file), (e) => e.child(div().flex_none().px(12).py(6).truncate().text_size(12).text_color(t.muted).border_b(1).border_color(t.border).child(file?.path ?? "")))
          .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
            .child(div().id("pr-diff-x").size_full().overflow_x_scrollbar()
              .child(div().w_full().min_w(width).h_full().child(v_virtual_list(`pr-diff-${this.pick}`, rows.length, 20, (i) => String(i),
                (range) => rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
            .child(Scrollbar.vertical(`pr-diff-${this.pick}`).viewport_from_layout().absolute().inset_0()))))
      .child(h_flex().flex_none().px(16).py(10).gap(8).items_center().border_t(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(this.status ? t[this.status.color] : t.dim)
          .child(this.status?.text ?? (this.confirming ? `${this.confirming === "approve" ? "Approve" : `Merge (${(pr.mergeMethod ?? "MERGE").toLowerCase()})`} this PR on GitHub? Esc to go back.` : "↑↓ files · Esc closes")))
        .child(this.button("pr-github", "Open on GitHub", t.raised, t.foreground, t.input, () => {
          const url = safeUrl(pr.url); if (url) exec("open", ["--", url]).catch(() => {});
        }))
        .child(this.button("pr-close", "Close", t.raised, t.foreground, t.input, () => this.close()))
        .when(!pr.mine, (e) => e.child(this.actionButton("approve", "Approve", "Approving…", "Approved", t)))
        .when(this.approvals > 0 && !pr.draft, (e) => e.child(this.actionButton("merge", "Merge", "Merging…", "Merged", t))));
  }
}
