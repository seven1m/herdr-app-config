// The whole branch diff (vs the remote's default branch, like branch-changes) drawn as a minimap:
// one thin bar per diff line, indented and as long as the line itself, green for added, red for
// removed, gray for context. The header's Changes button opens or closes the Changes panel.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, run, layout } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Whether the side panel is open on Changes, as the tab bar's Changes button checks it.
function changesShown() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  return Boolean(panel && !panel.hidden && body?.active === "changes");
}

// Reads write nothing under .git, so the folder watch doesn't trigger the next refresh.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// Same base as branch-changes: the merge base of HEAD and origin/HEAD (else origin/main, origin/master, main, master).
async function branchBase(git) {
  const head = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  const refs = [...(head.code === 0 && head.stdout.trim() !== "origin/HEAD" ? [head.stdout.trim()] : []), "origin/main", "origin/master", "main", "master"];
  for (const ref of refs) {
    const found = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (found.code !== 0) continue;
    const base = await git(["merge-base", ref, "HEAD"]);
    if (base.code === 0 && base.stdout.trim()) return { sha: base.stdout.trim(), name: ref.replace(/^origin\//, "") };
  }
  return null;
}

const LINE = 3, BAR = 2, HUNK_GAP = 4, FILE_GAP = 8, HEADER = 15;
const CHAR_PX = 1.6, MAX_COLS = 200, TAB = 4;
const MAX_ROWS = 30000, MAX_FILE_LINES = 3000, MAX_UNTRACKED = 200;

// Leading whitespace and visible length, in columns.
function shape(text) {
  let indent = 0, i = 0;
  for (; i < text.length && (text[i] === " " || text[i] === "\t"); i++) indent += text[i] === "\t" ? TAB : 1;
  const length = text.trimEnd().length - i;
  return { indent: Math.min(indent, MAX_COLS), length: Math.max(0, Math.min(length, MAX_COLS - indent)) };
}

// A unified diff, as files of rows: { kind: "+" | "-" | " " | "gap", indent, length }.
function parseDiff(text) {
  const files = [];
  let file = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.*)$/.exec(line);
      file = { path: m ? m[1] : line, rows: [], add: 0, del: 0 };
      files.push(file);
    } else if (!file) continue;
    else if (line.startsWith("+++ b/")) file.path = line.slice(6);
    else if (line.startsWith("@@")) { if (file.rows.length) file.rows.push({ kind: "gap" }); }
    else if (line.startsWith("Binary files")) file.binary = true;
    else if (file.rows.length < MAX_FILE_LINES && (line[0] === "+" || line[0] === "-" || line[0] === " ") && !line.startsWith("+++ ") && !line.startsWith("--- ")) {
      file.rows.push({ kind: line[0], ...shape(line.slice(1)) });
      if (line[0] === "+") file.add++; else if (line[0] === "-") file.del++;
    }
  }
  return files;
}

export default class ChangesMinimap extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.sizes = []; this.diffText = null;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.watched = null; this.diffText = null;
      this.setFiles([]); this.error = null; this.baseName = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.setFiles([]); this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const base = head.code === 0 ? await branchBase(git) : null;
        const diff = head.code === 0
          ? await git(["diff", base?.sha ?? "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"])
          : await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"]);
        if (diff.code !== 0) throw new Error(diff.stderr);
        const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const untracked = status.stdout.split("\0").filter((e) => e.startsWith("?? ")).map((e) => e.slice(3)).slice(0, MAX_UNTRACKED);
        // Untracked files are read each time; the rest only re-parse when the diff text changes.
        const texts = await Promise.all(untracked.map((path) => readTextFile(`${root}/${path}`, { on }).catch(() => null)));
        if (key() !== context) return;
        const signature = diff.stdout + "\0" + untracked.map((p, i) => `${p}:${texts[i]?.length ?? -1}`).join("\0");
        this.root = root; this.on = on; this.baseName = base?.name ?? null; this.error = null;
        this.watch(root, cx);
        if (signature === this.diffText) return;
        this.diffText = signature;
        const files = parseDiff(diff.stdout);
        untracked.forEach((path, i) => {
          const text = texts[i];
          if (text === null || text.includes("\0")) { files.push({ path, rows: [], add: 0, del: 0, binary: true }); return; }
          const lines = text.replace(/\n$/, "").split("\n").slice(0, MAX_FILE_LINES);
          files.push({ path, rows: lines.map((l) => ({ kind: "+", ...shape(l) })), add: lines.length, del: 0 });
        });
        files.sort((a, b) => a.path.localeCompare(b.path));
        this.setFiles(files);
      } catch (e) { if (key() === context) this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // One flat row list for the virtual list: a header per file, then its lines, with gaps.
  setFiles(files) {
    const rows = [], sizes = [];
    const push = (row, size) => { rows.push(row); sizes.push(size); };
    files.forEach((file, f) => {
      if (rows.length >= MAX_ROWS) return;
      if (f > 0) push({ kind: "filegap", file: f, key: `fg${f}` }, FILE_GAP);
      push({ kind: "header", file: f, key: `h${f}` }, HEADER);
      file.rows.forEach((r, i) => {
        if (rows.length >= MAX_ROWS) return;
        push({ ...r, file: f, key: `${f}:${i}` }, r.kind === "gap" ? HUNK_GAP : LINE);
      });
    });
    this.files = files; this.rows = rows; this.sizes = sizes;
    this.truncated = rows.length >= MAX_ROWS;
  }

  // Toggles the Changes panel, like the tab bar's button.
  toggleChanges() {
    if (changesShown()) return run("layout.hide", { id: "panel" });
    run("layout.select", { stack: "panel-body", child: "changes" });
    run("layout.show", { id: "panel" });
  }

  row(r, t) {
    if (r.kind === "header") {
      const file = this.files[r.file], name = file.path.split("/").pop();
      return h_flex().w_full().h(HEADER).px(6).gap(6).items_center().text_size(9.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(name))
        .when(file.binary, (e) => e.child(div().child("binary")))
        .when(file.add > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${file.add}`)))
        .when(file.del > 0, (e) => e.child(div().text_color(t.ansi1).child(`−${file.del}`)));
    }
    if (r.kind === "gap" || r.kind === "filegap") return div().w_full().h(r.kind === "gap" ? HUNK_GAP : FILE_GAP);
    const color = r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : `${t.dim}70`;
    return h_flex().w_full().h(LINE).items_start()
      .child(div().w(6 + r.indent * CHAR_PX).h(BAR).flex_none())
      .when(r.length > 0, (e) => e.child(div().w(Math.max(1, r.length * CHAR_PX)).h(BAR).flex_none().rounded(1).bg(color)));
  }

  emptyText() {
    if (this.error) return this.error;
    if (!this.root) return this.loading ? "Loading…" : "No folder";
    return this.baseName ? `No changes vs ${this.baseName}` : "No uncommitted changes";
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const shown = changesShown();
    return v_flex().id("changes-minimap").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Minimap"))
        .when(Boolean(this.baseName), (e) => e.child(div().text_size(11).text_color(t.dim).child(`vs ${this.baseName}`)))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(h_flex().id("open-changes").h(24).px(7).gap(5).flex_none().items_center().rounded(6).cursor_pointer().text_size(11)
          .bg(shown ? t.selected : t.background).text_color(shown ? t.foreground : t.muted).border_1().border_color(t.border)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.toggleChanges()).child(svg("mods/changes-minimap/changes.svg").size(12)).child("Changes")))
      .when(!this.files.length, (e) => e.child(div().p(12).text_size(12).text_color(this.error ? t.ansi1 : t.dim).child(this.emptyText())))
      .when(this.files.length > 0, (e) => e.child(div().flex_1().min_h(0).relative().py(6)
        .child(v_virtual_list("minimap-rows", this.rows.length, this.sizes, (i) => this.rows[i].key,
          (range) => this.rows.slice(range.start, range.end).map((r) => this.row(r, t)))
          .size_full())
        .child(Scrollbar.vertical("minimap-rows").viewport_from_layout().absolute().inset_0())))
      .when(Boolean(this.truncated), (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Diff too large; showing the start")));
  }
}
