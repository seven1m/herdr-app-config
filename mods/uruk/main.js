import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView, ScrollHandle } from "gpui-base";
import { theme, settings, home, appHome, focused, spaces, readTextFile, pickFolder, exec, nextCommand } from "herdr";
import { defaults, parseConfig, discoverLimit, runTurn, formatUsage } from "./agent.js";
import { loadSession, saveSession } from "./session.js";

async function requestJSON(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`oMLX ${response.status}: ${body.slice(0, 1200)}`);
  }
  return response.json();
}

function localFolder(initial) {
  if (initial?.cwd || initial?.folder) return initial.cwd || initial.folder;
  const current = focused(), space = spaces().find((entry) => entry.active);
  if (space?.machine || current?.terminal?.includes("/")) return home();
  return current?.cwd || space?.folder || home();
}

export default class Uruk extends View {
  init(initial, cx) {
    this.config = { ...defaults };
    this.configPath = `${appHome()}/uruk.json`;
    this.cwd = localFolder(initial);
    this.messages = [];
    this.entries = [];
    this.contextTokens = 0;
    this.limit = null;
    this.loading = true;
    this.busy = false;
    this.closed = false;
    this.inputFocused = false;
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new();
    this.input.on("submit", (_event, cx) => this.send(cx));
    this.input.on("change", (_event, cx) => { this.persist(); cx.notify(); });
    this.input.on("focus", (_event, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_event, cx) => { this.inputFocused = false; cx.notify(); });
    try {
      const saved = loadSession(localStorage);
      if (saved) {
        this.config = { ...this.config, ...saved.connection };
        this.cwd = saved.cwd;
        this.messages = saved.messages;
        this.entries = saved.entries;
        this.contextTokens = saved.contextTokens;
        this.usage = saved.usage;
        this.input.set_value(saved.draft || "");
        if (saved.interrupted) this.entries.push({ role: "notice", text: "Reload interrupted the previous turn. No commands were automatically retried." });
        this.scroll.scroll_to_item(Math.max(0, this.entries.length - 1));
      }
    } catch (error) { this.storageError = `Could not restore history: ${error.message || error}`; }
    this.reload(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.input.focus();
        if (command === "clear") this.clear(cx);
      }
    });
  }

  persist() {
    try { saveSession(localStorage, this); this.storageError = null; }
    catch (error) { this.storageError = `Could not save history: ${error.message || error}`; }
  }

  reload(cx) {
    if (this.busy) return;
    this.loading = true;
    this.configError = null;
    this.metadataError = null;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.configPath);
        const config = parseConfig(text || "");
        if (config.model !== this.config.model || config.base_url !== this.config.base_url) this.clear(cx);
        this.config = config;
        this.persist();
        this.limit = null;
        try { this.limit = await discoverLimit(config, requestJSON); }
        catch (error) { this.metadataError = error.message || String(error); }
      } catch (error) {
        this.configError = error.message || String(error);
      } finally {
        this.loading = false;
        if (!this.closed) cx.notify();
      }
    });
    cx.notify();
  }

  clear(cx) {
    if (this.busy) return;
    this.messages = [];
    this.entries = [];
    this.contextTokens = 0;
    this.usage = null;
    this.error = null;
    this.persist();
    cx.notify();
  }

  chooseFolder(cx) {
    if (this.busy || this.loading) return;
    cx.spawn(async (cx) => {
      try {
        const folder = await pickFolder({ prompt: "Use this project" });
        if (folder && !this.closed) { this.cwd = folder; this.clear(cx); }
      } catch (error) { this.error = error.message || String(error); cx.notify(); }
    });
  }

  send(cx) {
    const prompt = this.input.value().trim();
    if (!prompt || this.busy || this.loading || this.configError) return;
    this.busy = true;
    this.stopRequested = false;
    this.error = null;
    this.input.set_value("");
    this.entries.push({ role: "user", text: prompt });
    this.persist();
    const config = { ...this.config }, cwd = this.cwd;
    cx.spawn(async (cx) => {
      try {
        const result = await runTurn(config, { messages: this.messages, contextTokens: this.contextTokens, limit: this.limit }, prompt, {
          request: requestJSON,
          shell: async (command) => {
            const result = await exec("/bin/sh", ["-c", command], { cwd, timeout: config.shell_timeout_seconds * 1000 });
            return result.stdout + result.stderr + (result.code ? `\nExit status: ${result.code}` : "");
          },
          entry: (role, text) => {
            if (this.closed) return;
            this.entries.push({ role, text });
            this.persist();
            this.scroll.scroll_to_item(this.entries.length - 1);
            cx.notify();
          },
          usage: (usage) => { this.usage = usage; if (!this.closed) cx.notify(); },
          checkpoint: (state) => {
            if (this.closed) return;
            this.messages = state.messages.slice();
            this.contextTokens = state.contextTokens;
            this.usage = state.usage;
            this.persist();
          },
          cancelled: () => this.closed || this.stopRequested,
        });
        if (!this.closed) {
          this.messages = result.messages;
          this.contextTokens = result.contextTokens;
          this.usage = result.usage;
          this.error = result.error;
          if (result.stopped) this.entries.push({ role: "notice", text: "Stopped after the current step." });
        }
      } catch (error) { this.error = error.message || String(error); }
      finally {
        this.busy = false;
        if (!this.closed) { this.persist(); this.scroll.scroll_to_item(Math.max(0, this.entries.length - 1)); cx.notify(); }
      }
    });
    this.scroll.scroll_to_item(this.entries.length - 1);
    cx.notify();
  }

  close() { this.closed = true; this.stopRequested = true; }

  button(id, text, action, disabled = false, primary = false) {
    const t = theme();
    return h_flex().id(id).h(28).px(10).items_center().rounded(6).text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .opacity(disabled ? 0.4 : 1).cursor_pointer().hover((s) => s.opacity(disabled ? 0.4 : 0.8))
      .on_click((_event, cx) => { if (!disabled) action(cx); }).child(text);
  }

  render(cx) {
    const t = theme();
    const content = v_flex().id("uruk-history").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).p(12).gap(12);
    this.entries.forEach((entry, index) => {
      const tool = entry.role === "command" || entry.role === "tool";
      if (entry.role === "tool" && this.entries[index - 1]?.role === "command") return;
      if (tool) {
        const result = entry.role === "command" && this.entries[index + 1]?.role === "tool" ? this.entries[index + 1] : null;
        const summary = entry.role === "command" ? `Shell · ${entry.text.split("\n")[0]}` : "Shell result";
        content.child(v_flex().id(`uruk-message-${index}`).gap(8).p(10).rounded(8).bg(t.surface)
          .child(h_flex().id(`uruk-tool-toggle-${index}`).gap(8).items_center().cursor_pointer()
            .text_size(12).text_color(t.muted).hover((style) => style.text_color(t.foreground))
            .on_click((_event, cx) => { entry.expanded = !entry.expanded; this.persist(); cx.notify(); })
            .child(div().flex_none().child(entry.expanded ? "▾" : "▸"))
            .child(div().flex_1().min_w(0).truncate().child(summary)))
          .when(entry.expanded, (el) => el
            .child(div().font_family(settings().font_family ?? "JetBrains Mono").text_size(12).text_color(t.muted).child(entry.text))
            .when(Boolean(result), (body) => body.child(div().font_family(settings().font_family ?? "JetBrains Mono").text_size(12).text_color(t.muted).child(result.text)))));
        return;
      }
      content.child(v_flex().id(`uruk-message-${index}`).gap(5).p(10).rounded(8)
        .bg(entry.role === "user" ? t.raised : t.surface)
        .child(TextView.markdown(`uruk-text-${index}`, entry.text).text_size(13).text_color(t.foreground)));
    });
    const unavailable = this.busy || this.loading;
    return v_flex().id("uruk-root").size_full().min_h(0).bg(t.surface).text_color(t.foreground).track_focus(this.handle)
      .child(h_flex().px(12).py(8).gap(8).items_center().border_b_1().border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child("Project"))
        .child(div().id("uruk-folder").flex_1().truncate().text_size(12).text_color(t.accent).cursor_pointer()
          .on_click((_event, cx) => this.chooseFolder(cx)).child(this.cwd || "Choose a folder"))
        .when(this.busy, (el) => el.child(this.button("uruk-stop", this.stopRequested ? "Stopping…" : "Stop", (cx) => { this.stopRequested = true; cx.notify(); }, this.stopRequested)))
        .child(this.button("uruk-clear", "New chat", (cx) => this.clear(cx), unavailable))
        .child(this.button("uruk-reload", "Reload", (cx) => this.reload(cx), unavailable)))
      .child(content)
      .when(Boolean(this.error || this.configError || this.storageError || this.metadataError), (el) => el.child(div().px(12).py(8).text_size(12).text_color(t.blocked)
        .child(this.error || this.configError || this.storageError || `Context percentage unavailable: ${this.metadataError}`)))
      .child(v_flex().px(12).pb(10).gap(7).border_t_1().border_color(t.border).pt(9)
        .child(div().text_size(11).text_color(t.muted).child(this.loading ? "Connecting to oMLX…" : this.busy ? (this.stopRequested ? "Stopping after the current request…" : "Working…") : this.config.model))
        .when(Boolean(this.usage) && !this.loading, (el) => el.child(div().text_size(11).text_color(t.dim).child(formatUsage({ ...this.usage, limit: this.limit }))))
        .child(h_flex().gap(8).items_center()
          .child(Input.new(this.input).flex_1().h(34).px(9).rounded(6).border_1().border_color(this.inputFocused ? t.accent : t.border).bg(t.input).text_size(13))
          .child(this.button("uruk-send", "Send", (cx) => this.send(cx), unavailable || Boolean(this.configError) || !this.input.value().trim(), true))));
  }
}
