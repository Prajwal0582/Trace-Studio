#!/usr/bin/env node
// Prepares a Figma build for an approved run: positions frames like the
// designer's storyboard, writes one Figma script per screen plus a links
// script, and marks the run as building in Trace Studio.
//   node bin/build-prep.mjs <runDir> [libraryId]
import fs from "node:fs";
import path from "node:path";
import { Run } from "../src/run.js";
import { loadLibrary, screenCall, installScript, linksScript } from "../src/figma-build.js";

const dir = path.resolve(process.argv[2]);
const run = new Run(dir);
const d = run.data;
const libId = process.argv[3] || (/V2/.test(d.project.library || "") ? "v2" : "v1");
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
let n = 0;
steps.forEach((step, ci) => {
  const col = live.filter((s) => s.step === step).sort((a, b) => (a.order != null || b.order != null ? (a.order ?? 1e6 + a._i) - (b.order ?? 1e6 + b._i) : (isDefault(b) ? 1 : 0) - (isDefault(a) ? 1 : 0) || a._i - b._i));
  let y = 0;
  for (const s of col) {
    if (!s.layout) throw new Error(`${s.id} has no recorded layout`);
    const layout = JSON.parse(fs.readFileSync(path.join(dir, s.layout), "utf8"));
    const frameName = `${String(++n).padStart(2, "0")} ${s.name}${isDefault(s) ? "" : " — " + cap(s.state)}`;
    const code = screenCall({ layout, frameName, pageName, x: ci * (layout.w + 480), y, libId: lib.id, screenId: s.id, notes: s.notes });
    fs.writeFileSync(path.join(out, `${s.id}.js`), code);
    plan.push({ id: s.id, frameName, file: path.join(out, `${s.id}.js`), bytes: code.length });
    y += layout.h + 360;
  }
});
const name = (id) => plan.find((p) => p.id === id)?.frameName;
const links = d.edges.filter((e) => name(e.from) && name(e.to)).map((e) => ({ from: name(e.from), to: name(e.to), label: e.label }));
fs.writeFileSync(path.join(out, "links.js"), linksScript({ pageName, links }));
fs.writeFileSync(path.join(out, "install.js"), installScript(lib));
run.update({ stage: "building", screens: plan.map((p) => ({ id: p.id, build: { status: "pending" } })), log: `Building ${plan.length} screens with ${lib.name} on page “${pageName}”` });
console.log(JSON.stringify({ pageName, fileKey: d.figma?.fileKey, plan, links: links.length }, null, 1));
