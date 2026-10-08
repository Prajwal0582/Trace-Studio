// Turns an approved run into Figma build calls: frames laid out like the
// designer's storyboard, shared parts (nav, header, repeated code components)
// built once, dialogs as overlays, and the design system's app shell.
// The builder itself is installed in the Figma file once (installCode); every
// screen after that is a short call carrying only its own data, so the AI tool
// passes a few KB per screen instead of the whole builder each time.
import fs from "node:fs";
import path from "node:path";
import { loadLibrary, screenCall, installScript, linksScript, sharedParts, ENGINE_VERSION } from "./figma-build.js";
import { DESIGN_SYSTEMS } from "./design-systems.js";

const isDefault = (s) => !s.state || s.state === "default";
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const libraryIdFor = (run, override) => override || (/V2/.test(run.data.project?.library || "") ? "v2" : "v1");

// components: false (the default for now) makes no local components: the
// shell is pasted as a copy and repeated parts are drawn on each screen. Only
// the design system's own components, colour and text styles are used.
export function prepareBuild(run, { libId, libraryNav = false, shell = true, components = false } = {}) {
  const d = run.data;
  const dir = run.dir;
  libId = libraryIdFor(run, libId);
  const lib = loadLibrary(libId);
  const shellDef0 = shell ? DESIGN_SYSTEMS.find((x) => x.id === libId)?.shell || null : null;
  const shellDef = shellDef0 && { ...shellDef0, asComponent: components };
  const pageName = `Trace / ${d.project.flowName}`.slice(0, 100);

  // storyboard order (same rules as Trace Studio)
  const seen = [];
  d.screens.forEach((s, i) => {
    s._i = i;
    if (!seen.includes(s.step)) seen.push(s.step);
  });
  const steps = [...(d.stepOrder || []).filter((x) => seen.includes(x)), ...seen.filter((x) => !(d.stepOrder || []).includes(x))];
  const live = d.screens.filter((s) => s.status !== "removed");
  const jobs = [];
  const overlayOf = new Map(); // dialog screen id → the screen it opens over
  let n = 0;
  steps.forEach((step, ci) => {
    const col = live
      .filter((s) => s.step === step)
      .sort((a, b) => (a.order != null || b.order != null ? (a.order ?? 1e6 + a._i) - (b.order ?? 1e6 + b._i) : (isDefault(b) ? 1 : 0) - (isDefault(a) ? 1 : 0) || a._i - b._i));
    let y = 0;
    for (const s of col) {
      if (!s.layout) throw new Error(`${s.id} has no recorded layout`);
      let layout = JSON.parse(fs.readFileSync(path.join(dir, s.layout), "utf8"));
      const x = ci * ((shellDef?.w || layout.w) + 480);
      let frameName = `${String(++n).padStart(2, "0")} ${s.name}${isDefault(s) ? "" : " — " + cap(s.state)}`;
      // A dialog over a screen we already build: build only the dialog, and open it
      // as an overlay in the Figma prototype instead of rebuilding the whole screen.
      const dlg = layout.nodes.find((nd) => nd.dlg);
      const base = dlg && col.find((o) => o !== s && !overlayOf.has(o.id));
      let overlay = false;
      if (dlg && base) {
        // The dialog's own content (drawn inside it in the code), not the page behind it.
        const marked = layout.nodes.some((nd) => nd.dg);
        const inside = (nd) => nd !== dlg && (marked ? nd.dg : nd.x >= dlg.x - 1 && nd.y >= dlg.y - 1 && nd.x + nd.w <= dlg.x + dlg.w + 1 && nd.y + nd.h <= dlg.y + dlg.h + 1);
        layout = { w: dlg.w, h: dlg.h, bg: null, nodes: layout.nodes.filter(inside).map((nd) => ({ ...nd, x: nd.x - dlg.x, y: nd.y - dlg.y })) };
        frameName += " (overlay)";
        overlayOf.set(s.id, base.id);
        overlay = true;
      }
      jobs.push({ s, layout, frameName, x, y, overlay });
      y += (overlay ? layout.h : shellDef?.h || layout.h) + 360;
    }
  });
  const nonOverlay = jobs.filter((j) => !j.overlay);
  const shared = sharedParts(nonOverlay.map((j) => ({ id: j.s.id, layout: j.layout })), { pageName, libraryNav, shell: shellDef, reuse: components });
  const screens = jobs.map(({ s, layout, frameName, x, y, overlay }) => {
    const sp = overlay ? { layout, parts: [], shell: null } : shared[s.id];
    const code = screenCall({ layout: sp.layout, frameName, pageName, x, y, libId: lib.id, screenId: s.id, notes: s.notes, parts: sp.parts, shell: sp.shell });
    return { id: s.id, frameName, code, sharedParts: sp.parts.map((p) => p.def.name), shell: !!sp.shell, overlay };
  });
  const name = (id) => screens.find((p) => p.id === id)?.frameName;
  const links = d.edges
    .filter((e) => name(e.from) && name(e.to))
    .map((e) => ({ from: name(e.from), to: name(e.to), label: e.label, overlay: overlayOf.has(e.to) }));
  return { lib, pageName, screens, links, linksCode: linksScript({ pageName, links }), installCode: installScript(lib), engineVersion: ENGINE_VERSION };
}

// Several screens in one Figma call (one round trip instead of one per screen).
export function batchCode(screens) {
  const body = screens.map((s) => `  out.push(await (async () => { ${s.code.replace(/\n/g, "\n    ")} })());`).join("\n");
  return `const out = [];\n${body}\nreturn out;`;
}
