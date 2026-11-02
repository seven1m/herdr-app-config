// Status bar: what macOS says is playing (YouTube Music in a browser tab, Spotify, Music…), with
// previous / play-pause / next. Uses `media-control` (~/bin), which reads and drives macOS Now Playing.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, theme, home } from "herdr";

const POLL_MS = 3000;
const tool = () => `${home()}/bin/media-control`;

async function nowPlaying() {
  const r = await exec(tool(), ["get", "--no-artwork"]);
  if (r.code !== 0) throw new Error((r.stderr || "media-control failed").trim().split("\n").pop());
  const info = JSON.parse(r.stdout.trim() || "null");
  if (!info?.title) return null;
  return { title: info.title, artist: info.artist ?? "", playing: Boolean(info.playing) };
}

export default class NowPlaying extends View {
  init(_props, cx) {
    this.info = null;
    this.poll(cx);
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
  }

  poll(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const info = await nowPlaying();
        if (JSON.stringify(info) !== JSON.stringify(this.info) || this.error) { this.info = info; this.error = null; cx.notify(); }
      } catch (e) {
        const error = String(e.message ?? e);
        if (error !== this.error) { this.error = error; cx.notify(); }
      } finally { this.polling = false; }
    });
  }

  send(command, cx) {
    if (command === "toggle-play-pause" && this.info) { this.info = { ...this.info, playing: !this.info.playing }; cx.notify(); }
    cx.spawn(async (cx) => {
      await exec(tool(), [command]).catch(() => null);
      this.poll(cx);
      cx.timer.after(800, (cx) => this.poll(cx));
    });
  }

  button(id, glyph, tip, command, t) {
    return div().id(id).flex_none().w(20).h(20).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_color(t.muted).tooltip(tip).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => this.send(command, cx)).child(glyph);
  }

  render() {
    const t = theme(), info = this.info;
    const bar = h_flex().id("now-playing").size_full().px(10).gap(4).items_center().justify_center()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted);
    if (this.error) return bar.child(div().truncate().text_color(t.dim).tooltip(this.error).child("♪ media-control unavailable"));
    if (!info) return bar;
    const label = info.artist ? `${info.title} — ${info.artist}` : info.title;
    return bar
      .child(this.button("np-prev", "⏮", "Previous", "previous-track", t))
      .child(this.button("np-toggle", info.playing ? "⏸" : "▶", info.playing ? "Pause" : "Play", "toggle-play-pause", t))
      .child(this.button("np-next", "⏭", "Next", "next-track", t))
      .child(div().flex_shrink(1).min_w(0).ml(4).truncate().text_color(info.playing ? t.foreground : t.dim).child(`♪ ${label}`));
  }
}
