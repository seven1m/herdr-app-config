import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, spaces, focused, home, run } from "herdr";

export default class UrukLauncher extends View {
  render() {
    const t = theme();
    const space = spaces().find((entry) => entry.active);
    const enabled = !space?.machine;
    return h_flex().id("uruk-launcher").size_full().px(6).items_center().justify_center().bg(t.chrome)
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .child(div().id("new-uruk-tab").h(28).px(10).flex().items_center().justify_center().rounded(6)
        .bg(t.raised).text_color(t.foreground).text_size(12).opacity(enabled ? 1 : 0.4).cursor_pointer()
        .tooltip(enabled ? "New Uruk tab" : "Select a local space to use Uruk")
        .hover((style) => style.bg(enabled ? t.hover : t.raised))
        .on_click(() => {
          if (!enabled) return;
          const cwd = focused()?.cwd || space?.folder || home();
          run("tab.new", { name: "Uruk", space: space?.id, mod: "uruk", props: { cwd } });
        })
        .child("Uruk +"));
  }
}
