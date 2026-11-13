import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, props, openOverlay, settings, exec, readTextFile, writeTextFile, watchFolder, theme, appHome, nextCommand } from "herdr";
import { overlay, ADDED, REMOVED } from "./overlay.js";

const FOLDER = "docs/architecture";
const MOD = "mods/arch-diagrams";
const RENDERS = `${MOD}/.renders`;
// Reads write nothing under .git, so the folder watch doesn't see the mod's own git calls.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// As a tab's pane, the mod shows its own space's repo (or `props.folder`), whatever is focused.
// Docked in a layout, it follows focus like the Changes panel.
function location() {
  const p = props() ?? {}, mine = p.target?.pane;
  const tab = mine ? panes().find((x) => x.pane === mine)?.tab : null;
  const own = tab ? spaces().find((s) => s.tabs.some((t) => t.id === tab)) : null;
  if (p.folder || own) {
    const tabs = new Set(own?.tabs.map((t) => t.id) ?? []);
    const live = panes().find((x) => tabs.has(x.tab) && x.terminal && x.cwd)?.cwd;
    return { cwd: p.folder || live || own.folder, on: own?.machine ?? null };
  }
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on: space?.machine ?? null };
}

// What the charts are compared with: `git config arch-diagrams.base <ref>` when set, else the
// merge base of HEAD and the default branch (as the branch-changes mod does), else HEAD.
async function baseline(git) {
  const override = (await git(["config", "--get", "arch-diagrams.base"])).stdout.trim();
  if (override) {
    const sha = await git(["rev-parse", "--verify", "--quiet", `${override}^{commit}`]);
    if (sha.code === 0) return { sha: sha.stdout.trim(), name: override };
  }
  const head = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  const refs = [...(head.code === 0 && head.stdout.trim() !== "origin/HEAD" ? [head.stdout.trim()] : []), "origin/main", "origin/master", "main", "master"];
  for (const ref of refs) {
    if ((await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code !== 0) continue;
    const base = await git(["merge-base", ref, "HEAD"]);
    if (base.code === 0 && base.stdout.trim()) return { sha: base.stdout.trim(), name: ref.replace(/^origin\//, "") };
  }
  const sha = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
  return sha.code === 0 ? { sha: sha.stdout.trim(), name: "HEAD" } : null;
}

// The agent the prompt goes to: one in the shown tab (the session beside the dock), else any
// terminal there, else the focused terminal.
function agentTerminal() {
  const space = spaces().find((s) => s.active), tab = space?.tabs.find((t) => t.active)?.id;
  const here = panes().filter((p) => p.tab === tab && p.terminal);
  return (here.find((p) => p.status) ?? here[0])?.terminal ?? focused()?.terminal ?? null;
}

function hash(text) {
  let a = 0x811c9dc5, b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function isDark(t) {
  const hex = /^#([0-9a-f]{6})/i.exec(t.surface ?? t.background ?? "")?.[1];
  if (!hex) return true;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

export default class ArchDiagrams extends View {
  init(_props, cx) {
    this.charts = []; this.selected = null; this.renders = new Map(); this.queue = [];
    this.fit = true; this.zoom = 1; this.debug = false;
    this.handle = cx.focus_handle();
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        if (command === "next") this.step(1, cx);
        if (command === "prev") this.step(-1, cx);
        if (command === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
  }

  watch(dir, cx) {
    if (this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          await watchFolder(dir);
          if (this.watched === dir) this.refresh(cx);
        }
      } catch { if (this.watched === dir) this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location();
    if (!cwd) { this.error = "No folder"; cx.notify(); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) { this.root = null; this.charts = []; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        if (!on) this.watch(`${root}/${FOLDER}`, cx);
        const base = await baseline(git);
        const inBase = base ? (await git(["ls-tree", "--name-only", base.sha, "--", `${FOLDER}/`])).stdout.split("\n") : [];
        const inTree = (await git(["ls-files", "-co", "--exclude-standard", "--", `${FOLDER}/`])).stdout.split("\n");
        const paths = [...new Set([...inBase, ...inTree])].filter((p) => p.endsWith(".mmd")).sort();
        const dark = isDark(theme());
        const charts = [];
        for (const path of paths) {
          const before = inBase.includes(path) ? (await git(["show", `${base.sha}:${path}`])).stdout : null;
          const after = inTree.includes(path) ? await readTextFile(`${root}/${path}`, { on }) : null;
          const result = overlay(before ?? "", after ?? "");
          const status = before === null ? "A" : after === null ? "D" : result.changed ? "M" : "";
          const sources = [result.source];
          if (result.changed && !result.supported && before !== null && after !== null) sources.push(before);
          charts.push({ path, name: path.slice(FOLDER.length + 1, -4), status, ...result, keys: sources.map((s) => this.enqueue(s, dark, root)) });
        }
        this.root = root; this.base = base; this.charts = charts; this.error = null;
        if (!charts.some((c) => c.path === this.selected)) this.selected = charts[0]?.path ?? null;
        this.drain(cx);
      } catch (e) { this.error = String(e?.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  enqueue(source, dark, root) {
    const key = hash(`${dark}\n${source}`);
    if (!this.renders.has(key)) {
      this.renders.set(key, { state: "queued" });
      this.queue.push({ key, source, dark, root });
    }
    return key;
  }

  drain(cx) {
    if (this.rendering || !this.queue.length) return;
    this.rendering = true;
    cx.spawn(async (cx) => {
      const home = appHome(), dir = `${home}/${RENDERS}`;
      try {
        const node = (await readTextFile(`${home}/${MOD}/.node-path`))?.trim();
        if (!node || (await readTextFile(`${home}/${MOD}/.puppeteer.json`)) === null) {
          for (const job of this.queue.splice(0)) this.renders.set(job.key, { state: "error", message: `Renderer not installed: run ~/.config/herdr-app/${MOD}/setup.sh` });
          return;
        }
        await exec("mkdir", ["-p", dir]);
        while (this.queue.length) {
          const { key, source, dark } = this.queue.shift();
          const png = `${dir}/${key}.png`, json = `${dir}/${key}.json`;
          let map = await this.hits(json);
          if (!map) {
            this.renders.set(key, { state: "rendering" }); cx.notify();
            try { await writeTextFile(`${dir}/${key}.mmd`, source, null); } catch { /* already written */ }
            const r = await exec(node, [`${home}/${MOD}/render.mjs`, `${dir}/${key}.mmd`, png, json, dark ? "dark" : "default"], { cwd: `${home}/${MOD}`, timeout: 60000 });
            map = r.code === 0 ? await this.hits(json) : null;
            if (!map) { this.renders.set(key, { state: "error", message: (r.stderr || r.stdout).split("\n").filter((l) => l.trim() && !/^\s+at /.test(l)).slice(0, 6).join("\n") }); cx.notify(); continue; }
          }
          this.renders.set(key, { state: "ok", w: map.width, h: map.height, items: map.items }); cx.notify();
        }
        await this.prune(dir);
      } catch (e) {
        for (const job of this.queue.splice(0)) this.renders.set(job.key, { state: "error", message: String(e?.message ?? e) });
      } finally { this.rendering = false; cx.notify(); }
    });
  }

  async hits(json) {
    try { const map = JSON.parse((await readTextFile(json)) ?? "null"); return map?.width ? map : null; }
    catch { return null; }
  }

  // Keeps the renders the current charts use; edits leave a trail of old ones behind.
  async prune(dir) {
    const keep = new Set(this.charts.flatMap((c) => c.keys));
    const files = (await exec("ls", [dir])).stdout.split("\n").filter(Boolean);
    const stale = files.filter((f) => !keep.has(f.replace(/\.(png|mmd|json)$/, "")));
    if (stale.length > 20) {
      await exec("rm", ["-f", ...stale.map((f) => `${dir}/${f}`)]);
      for (const f of stale) this.renders.delete(f.replace(/\.(png|mmd|json)$/, ""));
    }
  }

  step(by, cx) {
    const i = this.charts.findIndex((c) => c.path === this.selected), n = this.charts.length;
    if (n) this.selected = this.charts[(i + by + n) % n].path;
    cx.notify();
  }

  key(e, cx) {
    const k = e.keystroke;
    if (k === "]" || k === "right" || k === "tab") this.step(1, cx);
    else if (k === "[" || k === "left" || k === "shift-tab") this.step(-1, cx);
    else if (/^[1-9]$/.test(k) && this.charts[Number(k) - 1]) this.selected = this.charts[Number(k) - 1].path;
    else if (k === "f" || k === "0") { this.fit = !this.fit; this.zoom = 1; }
    else if (k === "=" || k === "+" || k === "shift-=") { this.fit = false; this.zoom = Math.min(4, this.zoom * 1.25); }
    else if (k === "-") { this.fit = false; this.zoom = Math.max(0.25, this.zoom / 1.25); }
    else if (k === "r") this.refresh(cx);
    else if (k === "d") this.debug = !this.debug;
    else return;
    cx.notify();
  }

  tab(c, t) {
    const on = c.path === this.selected;
    const color = c.status === "A" ? ADDED : c.status === "D" ? REMOVED : t.blocked ?? "#d29922";
    return h_flex().id(`arch-tab-${c.path}`).h(26).flex_none().px(10).gap(6).items_center().rounded(6).cursor_pointer().text_size(12)
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.selected = c.path; this.handle.focus(); cx.notify(); })
      .when(Boolean(c.status), (e) => e.child(div().size(7).rounded(4).bg(color)))
      .child(div().text_color(on ? t.foreground : t.muted).child(c.name))
      .when(c.changed && c.status === "M", (e) => e.child(div().text_size(10).text_color(ADDED).child(`+${c.added}`)).child(div().text_size(10).text_color(REMOVED).child(`−${c.removed}`)));
  }

  // Opens the prompt for item (null: the chart as a whole), with whether the diff added or
  // removed it, for the agent in this tab.
  ask(c, item, cx) {
    let target = null, status = null;
    if (item) {
      const label = item.label.replace(/^✕\s*/, "");
      const touched = (op) => c.changes?.some((l) => l.op === op && l.text.includes(label));
      status = item.label.startsWith("✕") || (touched("-") && !touched("+")) ? "removed" : touched("+") ? "added" : null;
      target = { kind: item.kind, label };
    }
    openOverlay({ mod: "arch-ask", kind: "popup", width: 480, height: 156,
      props: { chart: c.path, root: this.root, base: this.base?.name ?? null, item: target, status, terminal: agentTerminal() } });
    cx.stop_propagation();
  }

  // The image at a known size with one click target per hit-map item laid over it, in the same
  // layout units, so a click lands on the item it's drawn over with no coordinate mapping.
  // Smaller items come last so they sit on top of the boxes they're inside.
  targets(key, r, c, w, h, t) {
    const scale = w / r.w;
    const items = [...(r.items ?? [])].sort((a, b) => b.w * b.h - a.w * a.h);
    return div().id(`arch-img-${key}`).relative().w(w).h(h).flex_none().cursor_pointer()
      .on_mouse_down("left", (_e, cx) => this.ask(c, null, cx))
      .child(image(`${RENDERS}/${key}.png`).size_full())
      .children(items.map((i, n) => div().id(`arch-hit-${key}-${n}`).absolute()
        .left(i.x * scale - 3).top(i.y * scale - 3).w(i.w * scale + 6).h(i.h * scale + 6).rounded(4)
        .when(this.debug, (e) => e.border_1().border_color("#ffcc00"))
        .hover((st) => st.bg("#ffffff14").border_1().border_color(t.accent))
        .on_mouse_down("left", (_e, cx) => this.ask(c, i, cx))));
  }

  fitted(r, box) {
    if (!box?.width || !box?.height) return null;
    const scale = Math.min(box.width / r.w, box.height / r.h, 1);
    return { w: r.w * scale, h: r.h * scale };
  }

  // Event bounds are window pixels; layout sizes are those divided by the app's zoom.
  measure(e, cx) {
    const b = e.bounds, z = settings().zoom || 1;
    if (!b?.width) return;
    const box = { width: b.width / z, height: b.height / z };
    if (this.box && Math.abs(this.box.width - box.width) < 1 && Math.abs(this.box.height - box.height) < 1) return;
    this.box = box;
    cx.notify();
  }

  picture(key, t, c) {
    const r = this.renders.get(key);
    if (!r || r.state === "queued" || r.state === "rendering")
      return div().p(16).text_color(t.dim).child(r?.state === "rendering" ? "Rendering…" : "Waiting to render…");
    if (r.state === "error") return div().p(16).text_size(12).text_color(REMOVED).font_family("JetBrains Mono").child(r.message || "Render failed");
    if (!this.fit) return div().p(12).child(this.targets(key, r, c, r.w * this.zoom, r.h * this.zoom, t));
    const sized = this.fitted(r, this.box);
    return div().flex_1().min_h(0).min_w(0).relative().child(h_flex().id(`arch-area-${key}`).absolute().top(12).left(12).right(12).bottom(12).items_start().justify_center()
      .on_mouse_move((e, cx) => this.measure(e, cx))
      .child(sized ? this.targets(key, r, c, sized.w, sized.h, t) : image(`${RENDERS}/${key}.png`).max_w_full().max_h_full()));
  }

  render(cx) {
    const t = theme(), c = this.charts.find((x) => x.path === this.selected);
    const note = !c ? null : c.status === "A" ? "New chart" : c.status === "D" ? "Deleted chart" : c.changed && !c.supported ? "Changed — no overlay for this diagram type; base shown below" : null;
    return v_flex().id("arch-root").size_full().bg(t.surface).text_color(t.foreground).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Architecture"))
        .when(Boolean(this.base), (e) => e.child(div().text_size(11).text_color(t.dim).child(`vs ${this.base.name}`)))
        .child(div().flex_1())
        .when(Boolean(c?.changed), (e) => e
          .child(h_flex().gap(4).items_center().text_size(11).text_color(t.muted).child(div().size(8).rounded(2).bg(ADDED)).child("added"))
          .child(h_flex().gap(4).items_center().text_size(11).text_color(t.muted).child(div().size(8).rounded(2).bg(REMOVED)).child("removed")))
        .child(div().text_size(11).text_color(t.dim).child(this.fit ? "fit · f/+/−" : `${Math.round(this.zoom * 100)}% · f fits`)))
      .child(h_flex().id("arch-tabs").h(38).flex_none().px(8).gap(4).items_center().overflow_x_scroll().border_b(1).border_color(t.border)
        .children(this.charts.map((x) => this.tab(x, t))))
      .when(Boolean(note), (e) => e.child(div().px(14).py(4).text_size(11).text_color(t.muted).child(note)))
      .child(!c
        ? div().p(16).text_color(t.dim).child(this.error || (this.loading && !this.root ? "Loading…" : `No ${FOLDER}/*.mmd in ${this.root ?? "this folder"}`))
        : this.fit
          ? v_flex().flex_1().min_h(0).min_w(0).overflow_hidden().children(c.keys.flatMap((k, i) => [...(i ? [div().h(1).flex_none().bg(t.border)] : []), this.picture(k, t, c)]))
          : div().id("arch-view").flex_1().min_h(0).min_w(0).overflow_scroll().child(v_flex().children(c.keys.map((k) => this.picture(k, t, c)))));
  }
}
