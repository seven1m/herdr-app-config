// The options popup: which folder to diff (the focused pane's, or a typed path), and the base and head refs.
// Saved in shared("minimap.options") as { folder, base, head }; empty means the default.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { shared, setShared, closeOverlay, props, theme, home, focused, panes } from "herdr";

export const OPTIONS_KEY = "minimap.options";
export const OPTIONS_WIDTH = 320, OPTIONS_HEIGHT = 400;

export function options() {
  const o = shared(OPTIONS_KEY) ?? {};
  return { folder: o.folder || null, base: (o.base ?? "").trim(), head: (o.head ?? "").trim() };
}

// The header's cycle button: the two presets it steps between, and "custom" for any other base/head.
const MODES = [
  { id: "branch", letter: "B", label: "Branch vs default branch", base: "", head: "" },
  { id: "commit", letter: "C", label: "Last commit", base: "HEAD~1", head: "HEAD" },
  { id: "uncommitted", letter: "U", label: "Uncommitted changes", base: "HEAD", head: "" },
];

export function mode() {
  const { base, head } = options();
  return MODES.find((m) => m.base === base && m.head === head) ?? { id: "custom", letter: "?", label: "Custom (set in Options)" };
}

export function cycleMode() {
  const i = MODES.findIndex((m) => m.id === mode().id), next = MODES[(i + 1) % MODES.length];
  setShared(OPTIONS_KEY, { ...options(), base: next.base, head: next.head });
}

const tilde = (path) => (path.startsWith(home()) ? `~${path.slice(home().length)}` : path);
const expand = (path) => (path === "~" || path.startsWith("~/") ? home() + path.slice(1) : path);

// The focused pane's live folder, where the minimap looks when no folder is set.
function cwd() {
  const f = focused();
  return (f?.pane ? panes().find((p) => p.pane === f.pane)?.cwd : null) || f?.cwd || null;
}

export class OptionsForm {
  init() {
    const o = options();
    this.folder = InputState.new({ placeholder: "Follows the focused pane" });
    this.folder.set_value(o.folder ? tilde(o.folder) : "");
    this.folder.on("submit", () => this.apply());
    this.base = InputState.new({ placeholder: "Default branch (origin/HEAD)" });
    this.head = InputState.new({ placeholder: "Working tree" });
    this.base.set_value(o.base);
    this.head.set_value(o.head);
    this.base.on("submit", () => this.apply());
    this.head.on("submit", () => this.apply());
  }

  save(patch) {
    setShared(OPTIONS_KEY, { ...options(), ...patch });
  }

  apply() {
    const folder = this.folder.value().trim().replace(/\/+$/, "");
    this.save({ folder: folder ? expand(folder) : null, base: this.base.value().trim(), head: this.head.value().trim() });
    closeOverlay(props().overlay);
  }

  button(id, label, t, onClick, primary = false) {
    return div().id(id).flex_none().h(26).px(10).flex().items_center().rounded(6).cursor_pointer().text_size(12)
      .when(primary, (e) => e.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (e) => e.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click(onClick).child(label);
  }

  // A link that fills Base and Head; Apply still saves them.
  preset(id, label, base, head, t) {
    const on = this.base.value().trim() === base && this.head.value().trim() === head;
    return div().id(id).flex_none().cursor_pointer().text_size(11.5).text_color(on ? t.foreground : t.accent)
      .when(on, (e) => e.font_semibold())
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.base.set_value(base); this.head.set_value(head); cx.notify(); })
      .child(label);
  }

  field(state, t) {
    return div().h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(Input.new(state).h_full().w_full().text_size(12.5).text_color(t.foreground));
  }

  section(title, child, t, hint = null) {
    return v_flex().gap(6).child(div().text_size(11).text_color(t.dim).child(title)).child(child)
      .when(Boolean(hint), (e) => e.child(div().text_size(11).text_color(t.dim).whitespace_normal().child(hint)));
  }

  render() {
    const t = theme();
    return v_flex().size_full().p(12).gap(12).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(this.section("Folder", h_flex().gap(6)
        .child(div().flex_1().min_w(0).child(this.field(this.folder, t)))
        .child(this.button("opt-cwd", "Use CWD", t, (_e, cx) => {
          const here = cwd();
          if (here) this.folder.set_value(tilde(here));
          cx.notify();
        })), t))
      .child(h_flex().gap(12).items_center()
        .child(div().text_size(11).text_color(t.dim).child("Show"))
        .child(this.preset("opt-branch", "Branch", "", "", t))
        .child(this.preset("opt-commit", "Last commit", "HEAD~1", "HEAD", t))
        .child(this.preset("opt-uncommitted", "Uncommitted", "HEAD", "", t)))
      .child(this.section("Base", this.field(this.base, t), t, "Compare against where your branch left this ref, e.g. main."))
      .child(this.section("Head", this.field(this.head, t), t, "Blank: your uncommitted edits too. HEAD: commits only. Or a branch name to see it without checking it out."))
      .child(div().flex_1())
      .child(h_flex().gap(6).justify_end()
        .child(this.button("opt-reset", "Reset", t, () => { setShared(OPTIONS_KEY, null); closeOverlay(props().overlay); }))
        .child(this.button("opt-apply", "Apply", t, () => this.apply(), true)));
  }
}
