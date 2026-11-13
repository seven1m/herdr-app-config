// AI overview of a PR for the View dialog, from the Claude Messages API.
// Mods can't install packages, so this uses fetch instead of the Anthropic SDK.
// Config: ~/.config/herdr-app/my-prs.json { "apiKey", "antProfile", "model" }. Auth is apiKey, else
// $ANTHROPIC_API_KEY, else a token from the `ant` CLI's login (antProfile, or its active profile).
// Prompt: ~/.config/herdr-app/my-prs-prompt.md, else summary-prompt.md in this folder.
import { appHome, home, exec, readTextFile } from "herdr";
import { shellEnv } from "./env.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-5-5";
// About 250k tokens; a bigger diff gets an error rather than a silently truncated summary.
const MAX_DIFF_CHARS = 1_000_000;

export const NO_KEY = "Claude login unavailable. Run ~/bin/ant auth login, or add \"apiKey\" to ~/.config/herdr-app/my-prs.json.";

// Overlays are separate instances, so keep summaries for the app's lifetime, keyed by URL + diff.
const cache = new Map();

async function loadConfig() {
  const home = appHome();
  const text = await readTextFile(`${home}/my-prs.json`).catch(() => null);
  let config = {};
  if (text) { try { config = JSON.parse(text); } catch { throw new Error("~/.config/herdr-app/my-prs.json isn't valid JSON"); } }
  const apiKey = config.apiKey || await shellEnv("ANTHROPIC_API_KEY");
  const auth = apiKey ? { "x-api-key": apiKey } : { Authorization: `Bearer ${await antToken(config.antProfile)}` };
  const prompt = await readTextFile(`${home}/my-prs-prompt.md`).catch(() => null)
    ?? await readTextFile(`${home}/mods/my-prs/summary-prompt.md`);
  return { auth, model: config.model || DEFAULT_MODEL, prompt: prompt.trim() };
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
  const { auth, model, prompt } = await loadConfig();
  const key = `${pr.url}\n${model}\n${prompt}\n${diff.length}\n${diff.slice(0, 2000)}`;
  if (cache.has(key)) return cache.get(key);
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
  cache.set(key, summary);
  return summary;
}
