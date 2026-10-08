#!/usr/bin/env node
// Prepares a Figma build for an approved run: positions frames like the
// designer's storyboard, writes one Figma script per screen plus a links
// script, and marks the run as building in Trace Studio.
//   node bin/build-prep.mjs <runDir> [libraryId] [--library-nav]
// The left navigation and top header are built once as components from the
// prototype and reused on every screen. --library-nav swaps the sidebar for
// the library's Navigation component instead (only when it matches).
import fs from "node:fs";
import path from "node:path";
import { Run } from "../src/run.js";
import { loadLibrary, screenCall, installScript, linksScript, sharedParts } from "../src/figma-build.js";

const args = process.argv.slice(2);
const libraryNav = args.includes("--library-nav");
const [dirArg, libArg] = args.filter((a) => !a.startsWith("--"));
const dir = path.resolve(dirArg);
const run = new Run(dir);
const d = run.data;
const libId = libArg || (/V2/.test(d.project.library || "") ? "v2" : "v1");
const lib = loadLibrary(libId);
const pageName = `Trace / ${d.project.flowName}`.slice(0, 100);
const isDefault = (s) => !s.state || s.state === "default";
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// storyboard order (same rules as Trace Studio)
const seen = [];
d.screens.forEach((s, i) => { s._i = i; if (!seen.includes(s.step)) seen.push(s.step); });
const steps = [...(d.stepOrder || []).filter((x) => seen.includes(x)), ...seen.filter((x) => !(d.stepOrder || []).includes(x))];
const live = d.screens.filter((s) => s.status !== "removed");
const out = path.join(dir, "figma");
fs.mkdirSync(out, { recursive: true });
const plan = [];
const jobs = [];
const overlayOf = new Map(); // dialog screen id → the screen it opens over
let n = 0;
steps.forEach((step, ci) => {
  const col = live.filter((s) => s.step === step).sort((a, b) => (a.order != null || b.order != null ? (a.order ?? 1e6 + a._i) - (b.order ?? 1e6 + b._i) : (isDefault(b) ? 1 : 0) - (isDefault(a) ? 1 : 0) || a._i - b._i));
  let y = 0;
  for (const s of col) {
    if (!s.layout) throw new Error(`${s.id} has no recorded layout`);
    let layout = JSON.parse(fs.readFileSync(path.join(dir, s.layout), "utf8"));
    const x = ci * (layout.w + 480);
    let frameName = `${String(++n).padStart(2, "0")} ${s.name}${isDefault(s) ? "" : " — " + cap(s.state)}`;
    // A dialog over a screen we already build: build only the dialog, and open it
    // as an overlay in the Figma prototype instead of rebuilding the whole screen.
    const dlg = layout.nodes.find((nd) => nd.dlg);
    const base = dlg && col.find((o) => o !== s && !overlayOf.has(o.id));
    if (dlg && base) {
      const inside = (nd) => nd !== dlg && nd.x >= dlg.x - 1 && nd.y >= dlg.y - 1 && nd.x + nd.w <= dlg.x + dlg.w + 1 && nd.y + nd.h <= dlg.y + dlg.h + 1;
      layout = { w: dlg.w, h: dlg.h, bg: null, nodes: layout.nodes.filter(inside).map((nd) => ({ ...nd, x: nd.x - dlg.x, y: nd.y - dlg.y })) };
      frameName += " (overlay)";
      overlayOf.set(s.id, base.id);
    }
    jobs.push({ s, layout, frameName, x, y });
    y += layout.h + 360;
  }
});
const shared = sharedParts(jobs.map((j) => ({ id: j.s.id, layout: j.layout })), { pageName, libraryNav });
for (const { s, frameName, x, y } of jobs) {
  const { layout, parts } = shared[s.id];
  const code = screenCall({ layout, frameName, pageName, x, y, libId: lib.id, screenId: s.id, notes: s.notes, parts });
  fs.writeFileSync(path.join(out, `${s.id}.js`), code);
  plan.push({ id: s.id, frameName, file: path.join(out, `${s.id}.js`), bytes: code.length, sharedParts: parts.map((p) => p.def.name) });
}
const name = (id) => plan.find((p) => p.id === id)?.frameName;
const links = d.edges
  .filter((e) => name(e.from) && name(e.to))
  .map((e) => ({ from: name(e.from), to: name(e.to), label: e.label, overlay: overlayOf.has(e.to) }));
fs.writeFileSync(path.join(out, "links.js"), linksScript({ pageName, links }));
fs.writeFileSync(path.join(out, "install.js"), installScript(lib));
run.update({ stage: "building", screens: plan.map((p) => ({ id: p.id, build: { status: "pending" } })), log: `Building ${plan.length} screens with ${lib.name} on page “${pageName}”` });
console.log(JSON.stringify({ pageName, fileKey: d.figma?.fileKey, plan, links: links.length }, null, 1));
