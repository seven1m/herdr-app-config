// AI overview of a PR for the View dialog, from the Claude Messages API.
// Mods can't install packages, so this uses fetch instead of the Anthropic SDK.
// Config: ~/.config/herdr-app/my-prs.json { "apiKey", "antProfile", "model" }. Auth is apiKey, else
// $ANTHROPIC_API_KEY, else a token from the `ant` CLI's login (antProfile, or its active profile).
// Prompt: ~/.config/herdr-app/my-prs-prompt.md, else summary-prompt.md in this folder.
// Summaries are saved in ~/.config/herdr-app/data/my-prs/summaries.json, keyed by PR URL plus a hash of
// the model, prompt and diff, so reopening a PR (even after a restart) skips the API call.
import { appHome, home, exec, readTextFile, writeTextFile } from "herdr";
import { shellEnv } from "./env.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-5-5";
// About 250k tokens; a bigger diff gets an error rather than a silently truncated summary.
const MAX_DIFF_CHARS = 1_000_000;

export const NO_KEY = "Claude login unavailable. Run ~/bin/ant auth login, or add \"apiKey\" to ~/.config/herdr-app/my-prs.json.";

// readTextFile reads at most 1 MiB, so keep the newest entries only.
const MAX_CACHED = 200;
const cachePath = () => `${appHome()}/data/my-prs/summaries.json`;

async function readCache() {
  const text = await readTextFile(cachePath()).catch(() => null);
  try { return { text, entries: text ? JSON.parse(text) : {} }; } catch { return { text, entries: {} }; }
}

async function saveCache(url, hash, summary) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, entries } = await readCache();
    entries[url] = { hash, summary, at: Date.now() };
    const kept = Object.fromEntries(Object.entries(entries).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CACHED));
    try { return await writeTextFile(cachePath(), JSON.stringify(kept), text); } catch {}
  }
}

// The last summary saved for a PR, whatever its diff, to show while the current diff loads.
export async function cachedSummary(url) {
  return (await readCache()).entries[url]?.summary ?? null;
}

// Two FNV-1a passes with different seeds: a 64-bit fingerprint, enough to tell diffs apart.
function fingerprint(text) {
  let a = 0x811c9dc5, b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

async function loadConfig() {
  const home = appHome();
  const text = await readTextFile(`${home}/my-prs.json`).catch(() => null);
  let config = {};
  if (text) { try { config = JSON.parse(text); } catch { throw new Error("~/.config/herdr-app/my-prs.json isn't valid JSON"); } }
  const prompt = await readTextFile(`${home}/my-prs-prompt.md`).catch(() => null)
    ?? await readTextFile(`${home}/mods/my-prs/summary-prompt.md`);
  return { config, model: config.model || DEFAULT_MODEL, prompt: prompt.trim() };
}

// Only on a cache miss: shellEnv can start a login shell and `ant` a token refresh, both slow.
async function loadAuth(config) {
  const apiKey = config.apiKey || await shellEnv("ANTHROPIC_API_KEY");
  return apiKey ? { "x-api-key": apiKey } : { Authorization: `Bearer ${await antToken(config.antProfile)}` };
}

// Fetched per request: OAuth access tokens are short-lived and `ant` refreshes them.
async function antToken(profile) {
  const args = ["auth", "print-credentials", "--access-token", ...(profile ? ["--profile", profile] : [])];
  const r = await exec(`${home()}/bin/ant`, args, { timeout: 30000 }).catch(() => null);
  const token = r?.code === 0 ? r.stdout.trim() : "";
  if (!token) throw new Error(NO_KEY);
  return token;
}

export async function summarize(pr, body, diff) {
  if (diff.length > MAX_DIFF_CHARS) throw new Error(`Diff is too large to summarize (${Math.round(diff.length / 1000)}k characters)`);
  const { config, model, prompt } = await loadConfig();
  const hash = fingerprint(`${model}\n${prompt}\n${body}\n${diff}`);
  const hit = (await readCache()).entries[pr.url];
  if (hit?.hash === hash) return hit.summary;
  const auth = await loadAuth(config);
  const content = [
    `<title>${pr.title ?? ""}</title>`,
    `<author>${pr.author ?? ""}</author>`,
    `<repository>${pr.repo ?? ""}</repository>`,
    `<description>\n${body || "(none)"}\n</description>`,
    `<diff>\n${diff}\n</diff>`,
  ].join("\n");
  const r = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...auth,
      "anthropic-version": "2026-10-21",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({
      model, max_tokens: 16000, system: prompt,
      output_config: { effort: "medium" },
      fallbacks: "default",
      messages: [{ role: "user", content }],
    }),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(json?.error?.message ?? `Claude API returned ${r.status}`);
  if (json.stop_reason === "refusal") throw new Error("Claude declined to summarize this PR");
  const summary = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!summary) throw new Error("Claude returned an empty summary");
  await saveCache(pr.url, hash, summary);
  return summary;
}
