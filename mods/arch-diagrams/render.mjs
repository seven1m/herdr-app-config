// Renders a Mermaid file to a PNG and, from the same page, a hit map: the label and box of each
// node, message, participant and edge label, in the PNG's own coordinates (CSS pixels, before
// the device scale), so the mod can tell what a click landed on.
//   node render.mjs <in.mmd> <out.png> <out.json> <dark|default>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const [input, png, json, theme] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const launch = JSON.parse(fs.readFileSync(path.join(here, ".puppeteer.json"), "utf8"));
const browser = await puppeteer.launch(launch);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent"><div id="c"></div></body>`);
  await page.addScriptTag({ path: path.join(here, "node_modules/mermaid/dist/mermaid.min.js") });
  const result = await page.evaluate(async (source, theme) => {
    mermaid.initialize({ startOnLoad: false, theme, securityLevel: "loose" });
    try {
      const { svg } = await mermaid.render("chart", source);
      document.getElementById("c").innerHTML = svg;
    } catch (e) { return { error: String(e?.message ?? e) }; }
    const el = document.querySelector("#c svg");
    el.style.maxWidth = "none";
    const vb = el.viewBox.baseVal;
    el.setAttribute("width", vb.width);
    el.setAttribute("height", vb.height);
    const root = el.getBoundingClientRect();
    const box = (n) => { const r = n.getBoundingClientRect(); return { x: r.x - root.x, y: r.y - root.y, w: r.width, h: r.height }; };
    const text = (n) => (n.textContent || "").replace(/\s+/g, " ").trim();
    const items = [];
    const add = (kind, n, label) => { const b = box(n); if (label && b.w > 0 && b.h > 0) items.push({ kind, label, ...b }); };
    for (const n of el.querySelectorAll("g.node")) add("node", n, text(n));
    for (const n of el.querySelectorAll("g.edgeLabel")) add("edge", n, text(n));
    for (const n of el.querySelectorAll("text.messageText")) {
      // A message's hit area runs from its label down to its arrow line.
      const line = n.nextElementSibling?.matches("line, path") ? n.nextElementSibling : null;
      const t = box(n), l = line ? box(line) : t;
      const x = Math.min(t.x, l.x), y = t.y, r = Math.max(t.x + t.w, l.x + l.w), b = Math.max(t.y + t.h, l.y + l.h + 6);
      items.push({ kind: "message", label: text(n), x, y, w: r - x, h: b - y });
    }
    for (const n of el.querySelectorAll("text.actor")) {
      const rect = n.parentElement?.querySelector("rect") ?? n;
      add("participant", rect, text(n));
    }
    for (const n of el.querySelectorAll("text.noteText")) add("note", n.parentElement ?? n, text(n));
    return { width: root.width, height: root.height, items };
  }, fs.readFileSync(input, "utf8"), theme === "dark" ? "dark" : "default");
  if (result.error) { console.error(result.error); process.exitCode = 1; }
  else {
    await (await page.$("#c svg")).screenshot({ path: png, omitBackground: true });
    fs.writeFileSync(json, JSON.stringify(result));
  }
} finally { await browser.close(); }
