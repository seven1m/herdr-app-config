// Status bar item: how long until the AWS SSO session expires. Click to run $HERDR_AWS_LOGIN, or `pco aws-login`.
// Reads only expiry timestamps from ~/.aws/sso/cache/*.json; tokens are never shown or sent anywhere.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, readTextFile, run, theme, home } from "herdr";
import { shellEnv } from "./env.js";

const CHECK_MS = 60000;
const HOUR_MS = 60 * 60 * 1000;
const WARN_MS = HOUR_MS;
// IAM Identity Center client registrations last 90 days. `pco aws-login` registers a new client on every
// browser login and refreshes keep the registration, so registrationExpiresAt - 90d is the login time.
const REGISTRATION_MS = 90 * 24 * HOUR_MS;
const DEFAULT_SESSION_HOURS = 16;
// Access tokens last 1h; Identity Center shortens the last one to end with the session.
const CAPPED_TOKEN_MS = 55 * 60 * 1000;

// The 1h access token doesn't mark the end of the session when a refresh token is cached: the CLI renews it
// until the Identity Center session (set by an admin, not stored locally) ends, so that end is estimated.
// writtenAt is the cache file's mtime: a token written with less than CAPPED_TOKEN_MS of life is the last one.
function sessionEnd(json, sessionMs, writtenAt) {
  const at = Date.parse(json.expiresAt);
  if (Number.isNaN(at)) return null;
  const reg = Date.parse(json.registrationExpiresAt);
  if (!json.refreshToken || Number.isNaN(reg) || reg <= Date.now()) return at;
  if (writtenAt !== null && at - writtenAt < CAPPED_TOKEN_MS) return at;
  return Math.max(at, reg - REGISTRATION_MS + sessionMs);
}

// Full path: Nix's GNU stat can come first on PATH and takes different flags.
async function modifiedAt(path) {
  const r = await exec("/usr/bin/stat", ["-f", "%m", path]).catch(() => null);
  const secs = r?.code === 0 ? Number(r.stdout.trim()) : NaN;
  return Number.isNaN(secs) ? null : secs * 1000;
}

// Read once: shellEnv can spawn a login shell, which is too slow to repeat every check.
let sessionMsPromise;
function sessionLength() {
  sessionMsPromise ??= shellEnv("HERDR_AWS_SESSION_HOURS").then((v) => {
    const hours = Number(v);
    return (hours > 0 ? hours : DEFAULT_SESSION_HOURS) * HOUR_MS;
  });
  return sessionMsPromise;
}

// The latest session end among cached SSO access tokens (not client registrations), or null.
async function readExpiry() {
  const sessionMs = await sessionLength();
  const dir = `${home()}/.aws/sso/cache`;
  const r = await exec("ls", [dir]).catch(() => null);
  if (r?.code !== 0) return null;
  let latest = null;
  for (const name of r.stdout.split("\n").filter((n) => n.endsWith(".json"))) {
    const text = await readTextFile(`${dir}/${name}`).catch(() => null);
    let json;
    try { json = JSON.parse(text); } catch { continue; }
    if (!json?.accessToken || !json?.startUrl || !json?.expiresAt) continue;
    const at = sessionEnd(json, sessionMs, await modifiedAt(`${dir}/${name}`));
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

function remaining(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default class AwsSso extends View {
  init(_props, cx) {
    this.expiresAt = undefined;
    this.check(cx);
    cx.timer.every(CHECK_MS, (cx) => this.check(cx));
  }

  check(cx) {
    cx.spawn(async (cx) => {
      this.expiresAt = await readExpiry().catch(() => null);
      cx.notify();
    });
  }

  login(cx) {
    cx.spawn(async () => {
      const argv = (await shellEnv("HERDR_AWS_LOGIN") ?? "pco aws-login").split(/\s+/);
      run("tab.new", { name: "AWS login", argv });
    });
    for (const ms of [20000, 60000, 180000]) cx.timer.after(ms, (cx) => this.check(cx));
  }

  render() {
    const t = theme();
    const left = this.expiresAt ? this.expiresAt - Date.now() : null;
    let dot = t.dim, text = "AWS …";
    if (this.expiresAt === null || (left !== null && left <= 0)) { dot = t.ansi1; text = "AWS expired · log in"; }
    else if (left !== null) { dot = left < WARN_MS ? t.ansi3 : t.ansi2; text = `AWS ${remaining(left)}`; }
    return h_flex().id("aws-sso").size_full().px(14).gap(6).items_center().justify_end().cursor_pointer()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.login(cx))
      .child(div().size(6).rounded(3).bg(dot))
      .child(text);
  }
}
