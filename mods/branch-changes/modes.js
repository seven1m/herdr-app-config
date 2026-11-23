// The minimap's modes (mods/changes-minimap/options.js), kept in step by hand: a mod can't import
// another mod's files. Both read and write shared("minimap.options"), so a change in either view shows in both.
import { shared, setShared } from "herdr";

export const OPTIONS_KEY = "minimap.options";

export function options() {
  const o = shared(OPTIONS_KEY) ?? {};
  return { folder: o.folder || null, base: (o.base ?? "").trim(), head: (o.head ?? "").trim() };
}

const MODES = [
  { id: "branch", letter: "B", label: "Branch vs default branch", base: "", head: "" },
  { id: "commit", letter: "C", label: "Last commit", base: "HEAD~1", head: "HEAD" },
  { id: "uncommitted", letter: "U", label: "Uncommitted changes", base: "HEAD", head: "" },
];

export function mode() {
  const { base, head } = options();
  return MODES.find((m) => m.base === base && m.head === head) ?? { id: "custom", letter: "?", label: "Custom (set in Minimap options)" };
}

export function cycleMode() {
  const i = MODES.findIndex((m) => m.id === mode().id), next = MODES[(i + 1) % MODES.length];
  setShared(OPTIONS_KEY, { ...options(), base: next.base, head: next.head });
}
