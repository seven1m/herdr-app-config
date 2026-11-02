// Open GitHub pull requests: ones waiting on your review, and your own, with CI and review state.
// Data comes from the `gh` CLI, so it uses your existing `gh auth login`; no token is stored here.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, home } from "herdr";
import { QUERY, MINE, REVIEW, parseResponse, safeUrl, ago } from "./prs.js";

const REFRESH_MS = 120000;

// Apps launched from the Dock don't get your shell's PATH, so look in the usual places,
// then ask a login shell as a last resort.
async function findGh() {
  const candidates = [
    "gh",
    `${home()}/.local/share/devbox/global/default/.devbox/nix/profile/default/bin/gh`,
    `${home()}/.nix-profile/bin/gh`,
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
  ];
  for (const c of candidates) {
    const r = await exec(c, ["--version"]).catch(() => null);
    if (r?.code === 0) return c;
  }
  const r = await exec("sh", ["-c", '"${SHELL:-sh}" -lic "command -v gh" 2>/dev/null']).catch(() => null);
  const path = (r?.stdout ?? "").split("\n").map((l) => l.trim()).reverse().find((l) => l.startsWith("/"));
  return path ?? null;
}

async function fetchPrs(gh) {
  const r = await exec(gh, ["api", "graphql", "-f", `query=${QUERY}`, "-f", `mine=${MINE}`, "-f", `review=${REVIEW}`]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "gh failed").trim().split("\n")[0]);
  return parseResponse(r.stdout);
}

function openUrl(url) {
  const safe = safeUrl(url);
  if (safe) exec("open", ["--", safe]).catch(() => {});
}

export default class MyPrs extends View {
  init(_props, cx) {
    this.mine = []; this.review = []; this.loading = false; this.generation = 0;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  // Background refreshes stay quiet: no redraw until results arrive, and the icon only spins for a
  // click. "Loading…" only shows before the first load finishes.
  refresh(cx, manual = false) {
    const generation = ++this.generation;
    this.loading = true; this.manual = manual;
    cx.spawn(async (cx) => {
      try {
        this.gh = this.gh ?? (await findGh());
        if (!this.gh) throw new Error("gh not found. Install the GitHub CLI and run `gh auth login`.");
        const { mine, review } = await fetchPrs(this.gh);
        if (generation === this.generation) { this.mine = mine; this.review = review; this.error = null; }
      } catch (e) { if (generation === this.generation) this.error = String(e.message ?? e); }
      finally { if (generation === this.generation) { this.loading = false; this.loaded = true; } cx.notify(); }
    });
    if (manual) cx.notify();
  }

  tag(text, color, t) {
    return div().flex_none().text_color(t[color] ?? t.dim).child(text);
  }

  row(pr, t, showAuthor) {
    const repo = pr.repo.split("/").pop();
    return v_flex().id(`pr-${pr.id}`).flex_none().px(10).py(7).gap(3).rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => openUrl(pr.url))
      .child(div().whitespace_normal().text_color(t.foreground).child(pr.title))
      .child(h_flex().gap(8).items_start().text_size(11).text_color(t.dim)
        .child(h_flex().flex_1().min_w(0).flex_wrap().gap_x(8).gap_y(2).items_center()
          .child(div().flex_none().text_color(t.accent).child(`${repo}#${pr.number}`))
          .when(Boolean(pr.ci), (e) => e.child(div().id(`ci-${pr.id}`).flex_none().size(8).rounded_full()
            .bg(t[pr.ci?.color] ?? t.dim).tooltip(pr.ci?.label ?? "CI")))
          .when(pr.draft, (e) => e.child(this.tag("Draft", "dim", t)))
          .when(!pr.draft && Boolean(pr.review), (e) => e.child(this.tag(pr.review?.label ?? "", pr.review?.color, t)))
          .when(showAuthor, (e) => e.child(this.tag(pr.author, "dim", t))))
        .child(div().flex_none().child(ago(pr.updatedAt))));
  }

  section(id, title, prs, empty, t, showAuthor) {
    return v_flex().flex_none().gap(2)
      .child(h_flex().px(10).pt(6).pb(2).gap(6).items_center().text_size(11)
        .child(div().text_color(t.muted).font_semibold().child(title))
        .child(div().text_color(t.dim).child(String(prs.length))))
      .children(prs.map((pr) => this.row(pr, t, showAuthor)))
      .when(!prs.length, (e) => e.child(div().id(`${id}-empty`).px(10).py(4).text_size(11).text_color(t.dim)
        .child(!this.loaded && !this.error ? "Loading…" : empty)));
  }

  render() {
    const t = theme();
    return v_flex().id("my-prs").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Pull requests"))
        .child(div().flex_1())
        .child(div().id("prs-refresh").size(26).flex().items_center().justify_center().rounded(7).cursor_pointer().text_color(t.muted)
          .tooltip("Refresh").hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx, true))
          .child(svg("mods/my-prs/refresh.svg").size(13).when(this.loading && this.manual, (e) => e.spin(900)))))
      .child(v_flex().id("prs-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(6)
        .when(Boolean(this.error), (e) => e.child(div().p(8).text_size(12).text_color(t.ansi1).child(this.error ?? "")))
        .child(this.section("review", "Review requested", this.review, "Nothing waiting on you", t, true))
        .child(this.section("mine", "Mine", this.mine, "No open PRs", t, false)));
  }
}
