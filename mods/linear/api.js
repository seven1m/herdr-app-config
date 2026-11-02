// Linear API access shared by the panel and the new-issue dialog.
import { home, appHome, readTextFile, exec } from "herdr";
import { API_URL, parseConfig, splitAgents, linearError } from "./linear.js";
import { shellEnv } from "./env.js";

export const NO_KEY = "No Linear API key. Add it to the macOS Keychain (service herdr-linear), ~/.config/herdr-app/linear.json, or set LINEAR_API_KEY.";

export async function loadConfig() {
  const text = await readTextFile(`${appHome()}/linear.json`).catch(() => null);
  const config = parseConfig(text, home());
  if (!config.apiKey && !config.error) config.apiKey = (await keychainKey()) ?? (await shellEnv("LINEAR_API_KEY"));
  const workspace = config.workspace ?? (await fromEnv("HERDR_LINEAR_WORKSPACE"));
  return {
    ...config,
    inboxUrl: workspace ? `https://linear.app/${encodeURIComponent(workspace)}/inbox` : "https://linear.app/",
    team: config.team ?? (await fromEnv("HERDR_LINEAR_TEAM")),
    agents: config.agents ?? splitAgents(await fromEnv("HERDR_LINEAR_AGENTS")) ?? [],
  };
}

// Read once and only when linear.json leaves the setting out: the panel reloads its config every minute, and a login shell is slow to start.
const envCache = {};
const fromEnv = (name) => (envCache[name] ??= shellEnv(name));

let cachedKey = null;
async function keychainKey() {
  if (cachedKey) return cachedKey;
  const r = await exec("security", ["find-generic-password", "-s", "herdr-linear", "-w"]).catch(() => null);
  cachedKey = r?.code === 0 ? r.stdout.trim() || null : null;
  return cachedKey;
}

// One GraphQL request; throws a short message on HTTP or GraphQL errors.
export async function gql(apiKey, query, variables = {}) {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(linearError(r.status, body));
  const json = JSON.parse(body);
  const message = json?.errors?.[0]?.extensions?.userPresentableMessage ?? json?.errors?.[0]?.message;
  if (message) throw new Error(message);
  return json.data;
}
