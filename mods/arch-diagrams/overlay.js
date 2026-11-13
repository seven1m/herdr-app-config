// Merges a chart's base and current Mermaid source into one diagram that marks what changed:
// added parts green, removed parts red. Only the current side's structure (boxes, loops,
// subgraphs) is kept, so the merged source stays as balanced as the current file.

export const ADDED = "#2ea043", REMOVED = "#e5534b";

export function lineDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length, key = (s) => s.trim();
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = key(x[i]) === key(y[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (key(x[i]) === key(y[j])) { out.push({ op: " ", text: y[j] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", text: x[i++] });
    else out.push({ op: "+", text: y[j++] });
  }
  while (i < n) out.push({ op: "-", text: x[i++] });
  while (j < m) out.push({ op: "+", text: y[j++] });
  // Blank and comment lines never count as changes.
  return out.filter((l) => l.op === " " || (l.text.trim() && !l.text.trim().startsWith("%%")));
}

export function diagramType(source) {
  let front = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "---") { front = !front; continue; }
    if (front || !line || line.startsWith("%%")) continue;
    return line.split(/\s+/)[0];
  }
  return null;
}

export function overlay(base, current) {
  const diff = lineDiff(base ?? "", current ?? "");
  const added = diff.filter((l) => l.op === "+").length, removed = diff.filter((l) => l.op === "-").length;
  const changes = diff.filter((l) => l.op !== " ").map((l) => ({ op: l.op, text: l.text.trim() }));
  const stats = { added, removed, changed: added + removed > 0, changes };
  if (!stats.changed) return { source: current, supported: true, ...stats };
  const type = diagramType(current || base);
  if (type === "sequenceDiagram") return { source: sequence(diff), supported: true, ...stats };
  if (type === "flowchart" || type === "graph") return { source: flowchart(diff), supported: true, ...stats };
  return { source: current, supported: false, ...stats };
}

const MESSAGE = /^(\s*)([^\s:][^:]*?)\s*(<<-->>|<<->>|--?>>|--?>|--?x|--?\)|-->|->)\s*([+-]?)([^:]+?)\s*:(.*)$/;
const PARTICIPANT = /^(\s*)(participant|actor)\s+(\S+)(?:\s+as\s+(.*))?$/;
const NOTE = /^\s*note\s/i;

function sequence(diff) {
  const ids = (op) => new Set(diff.filter((l) => l.op !== op).map((l) => PARTICIPANT.exec(l.text)?.[3]).filter(Boolean));
  const declared = ids("-"), before = ids("+");
  const out = [];
  let group = null;
  const close = () => { if (group) { out.push(`${group.indent}end`); group = null; } };
  for (const { op, text } of diff) {
    const participant = PARTICIPANT.exec(text);
    if (participant) {
      close();
      const [, indent, kind, id, alias] = participant;
      if (op === " " || (op === "+" && before.has(id))) out.push(text);
      else if (op === "+") out.push(`${indent}${kind} ${id} as ${alias ?? id} (new)`);
      else if (!declared.has(id)) out.push(`${indent}${kind} ${id} as ${alias ?? id} (removed)`);
      continue;
    }
    const isStep = MESSAGE.test(text) || NOTE.test(text);
    if (!isStep || op === " ") {
      close();
      if (op !== "-") out.push(text);
      continue;
    }
    if (group?.op !== op) {
      close();
      const indent = /^\s*/.exec(text)[0];
      group = { op, indent };
      out.push(`${indent}rect ${op === "+" ? "rgba(46,160,67,0.25)" : "rgba(229,83,75,0.25)"}`);
    }
    out.push(op === "-" ? strike(text) : text);
  }
  close();
  return out.join("\n");
}

const strike = (text) => text.replace(/:(.*)$/, (_m, label) => `: ✕ ${label.trim()}`);

// Flowchart link operators: A --> B, A -.-> B, A ==> B, A --- B, A ~~~ B, A <--> B, A --o B.
const LINK = /\s*(?:<|o|x)?(?:-{2,}|={2,}|-\.+-|~{3,})(?:>|o|x)?\s*/g;
const TEXT_LINK = /(?:--|==|-\.)\s+[^\s>|-][^>]*?\s+(?:-{2,}|={2,}|\.-+)(?:>|o|x)?/g;
const STRUCTURAL = /^\s*(subgraph\b|end\b|direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b|flowchart\b|graph\b|%%|---)/;

function stripped(line) {
  return line
    .replace(/"[^"]*"/g, "")
    .replace(/\|[^|]*\|/g, "")
    .replace(TEXT_LINK, " --> ")
    .replace(/([A-Za-z0-9_])>[^\]]*\]/g, "$1")
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, "")
    .replace(/:::\w+/g, "");
}

function parseLine(line) {
  if (STRUCTURAL.test(line)) return { links: 0, ids: [] };
  const segments = stripped(line).split(LINK).map((s) => s.split("&").map((p) => /^\s*([A-Za-z0-9_]+)/.exec(p)?.[1]).filter(Boolean));
  let links = 0;
  for (let i = 0; i + 1 < segments.length; i++) links += segments[i].length * segments[i + 1].length;
  return { links, ids: segments.flat() };
}

function flowchart(diff) {
  const curIds = new Set(), baseIds = new Set();
  for (const { op, text } of diff) for (const id of parseLine(text).ids) {
    if (op !== "-") curIds.add(id);
    if (op !== "+") baseIds.add(id);
  }
  const out = [], addedLinks = [], removedLinks = [], remap = new Map();
  let merged = 0, current = 0;
  for (const { op, text } of diff) {
    if (op === "-" && STRUCTURAL.test(text)) continue;
    const { links } = parseLine(text);
    for (let k = 0; k < links; k++) {
      if (op === "+") addedLinks.push(merged);
      if (op === "-") removedLinks.push(merged);
      if (op !== "-") remap.set(current++, merged);
      merged++;
    }
    out.push(text);
  }
  // A linkStyle in the current file counts links without the removed ones put back.
  const lines = out.map((line) => line.replace(/^(\s*linkStyle\s+)([\d,\s]+?)(\s+\S)/, (_m, head, list, tail) =>
    head + list.split(",").map((n) => remap.get(Number(n.trim())) ?? n.trim()).join(",") + tail));
  const addedIds = [...curIds].filter((id) => !baseIds.has(id)), removedIds = [...baseIds].filter((id) => !curIds.has(id));
  lines.push(`  classDef cadAdded fill:#d6f5dd,stroke:${ADDED},stroke-width:3px,color:#0b2e13`);
  lines.push(`  classDef cadRemoved fill:#fbe0de,stroke:${REMOVED},stroke-width:2px,stroke-dasharray:5 5,color:#4a0f0b`);
  if (addedIds.length) lines.push(`  class ${addedIds.join(",")} cadAdded`);
  if (removedIds.length) lines.push(`  class ${removedIds.join(",")} cadRemoved`);
  if (addedLinks.length) lines.push(`  linkStyle ${addedLinks.join(",")} stroke:${ADDED},stroke-width:3px`);
  if (removedLinks.length) lines.push(`  linkStyle ${removedLinks.join(",")} stroke:${REMOVED},stroke-width:2px,stroke-dasharray:5 5`);
  return lines.join("\n");
}
