#!/usr/bin/env node
// Prepares a Figma build for an approved run: one Figma script per screen plus
// links and the one-time builder install, and marks the run as building.
//   node bin/build-prep.mjs <runDir> [libraryId] [--library-nav] [--no-shell] [--components]
// By default no local components are made: the shell is pasted as a copy and
// only the design system's components, colour and text styles are used.
// --components builds the shell and repeated parts as reusable components.
// Screens sit in the design system's app shell (V1: navigation + header) and
// only their content is rebuilt; --no-shell rebuilds the prototype's own nav
// and header instead (as shared components), and --library-nav swaps the
// sidebar for the library's Navigation component.
import fs from "node:fs";
import path from "node:path";
import { Run } from "../src/run.js";
import { prepareBuild } from "../src/build-run.js";

const args = process.argv.slice(2);
const [dirArg, libArg] = args.filter((a) => !a.startsWith("--"));
const dir = path.resolve(dirArg);
const run = new Run(dir);
const b = prepareBuild(run, { libId: libArg, libraryNav: args.includes("--library-nav"), shell: !args.includes("--no-shell"), components: args.includes("--components") });
const out = path.join(dir, "figma");
fs.mkdirSync(out, { recursive: true });
for (const s of b.screens) fs.writeFileSync(path.join(out, `${s.id}.js`), s.code);
fs.writeFileSync(path.join(out, "links.js"), b.linksCode);
fs.writeFileSync(path.join(out, "install.js"), b.installCode);
run.update({ stage: "building", screens: b.screens.map((p) => ({ id: p.id, build: { status: "pending" } })), log: `Building ${b.screens.length} screens with ${b.lib.name} on page “${b.pageName}”` });
const plan = b.screens.map((s) => ({ id: s.id, frameName: s.frameName, file: path.join(out, `${s.id}.js`), bytes: s.code.length, sharedParts: s.sharedParts, shell: s.shell }));
console.log(JSON.stringify({ pageName: b.pageName, fileKey: run.data.figma?.fileKey, plan, links: b.links.length }, null, 1));
