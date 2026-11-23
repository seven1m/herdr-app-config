// Right-click menu for a machine header in space-tree. Opened as a popup with
// props { name }; choosing "Remove machine…" reopens this mod as a dialog with
// props { name, confirm: true }, which runs `hc machine rm` on Enter or Remove.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { hc, notify, props, openOverlay, closeOverlay, theme } from "herdr";

export default class MachineMenu extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  ask() {
    const p = props();
    closeOverlay(p.overlay);
    openOverlay({ mod: "machine-menu", kind: "dialog", width: 420, height: 170, props: { name: p.name, confirm: true } });
  }

  remove() {
    const p = props();
    closeOverlay(p.overlay);
    hc(["machine", "rm", p.name]).then((r) => {
      if (r.code !== 0) notify({ title: `Couldn't remove ${p.name}`, body: (r.stderr || r.stdout).trim(), level: "error" });
    });
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const keys = (yes) => (e, cx) => {
      if (e.key === "enter") yes();
      else if (e.key === "escape") closeOverlay(p.overlay);
      else return;
      cx.stop_propagation();
    };

    if (!p.confirm) {
      return v_flex().id("machine-menu").track_focus(this.handle).on_key_down(keys(() => this.ask()))
        .w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
        .child(h_flex().id("mi-remove").h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .bg(t.selected).hover((s) => s.bg(t.hover))
          .on_click(() => this.ask())
          .child(svg("mods/workspace-chrome/x.svg").size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().child("Remove machine…")));
    }

    const button = (id, label, bg, fg, onClick) =>
      h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(id === "no" ? t.input : bg).bg(bg).text_color(fg)
        .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
    return v_flex().id("machine-confirm").track_focus(this.handle).on_key_down(keys(() => this.remove()))
      .size_full().min_h(0).p(18).gap(12).rounded(8).bg(t.popover).text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(`Remove ${p.name}?`))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex_1().min_h(0).text_color(t.muted).child("Its terminals keep running there. Add the machine again to get its spaces back."))
      .child(h_flex().justify_end().gap(8).text_size(12)
        .child(button("no", "Cancel", t.raised, t.foreground, () => closeOverlay(p.overlay)))
        .child(button("yes", "Remove", t.solid, t.solid_foreground, () => this.remove())));
  }
}
