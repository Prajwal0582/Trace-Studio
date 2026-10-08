// Turns a recorded screen layout (src/layout.js) into Figma Plugin-API code
// that rebuilds the screen with the target design system: library component
// instances (Button, Chip, Navigation), library colour + text styles, and
// plain frames for everything else. The code runs through Figma MCP
// `use_figma` (or the Trace Importer plugin). One call per screen.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "libraries");
export const loadLibrary = (id) => JSON.parse(fs.readFileSync(path.join(LIB_DIR, `${id}.json`), "utf8"));

// Compact the layout so a screen fits in one call.
function compact(layout) {
  const r = (v) => (typeof v === "number" ? Math.round(v) : v);
  return {
    w: layout.w,
    h: layout.h,
    bg: layout.bg,
    n: layout.nodes.map((n) => {
      const o = {};
      for (const [k, v] of Object.entries(n)) {
        if (v == null || v === false || v === "") continue;
        o[k] = r(v);
      }
      return o;
    }),
  };
}

// ---------------------------------------------------------------------------
// Shared parts: the left navigation and top header repeat on every screen.
// Instead of redrawing them (or swapping in a library component that may be an
// older design), build each one once as a Figma component from what the
// prototype shows, and place an instance on every screen with per-screen
// overrides (text, colours, pieces hidden on screens that don't have them).
const contains = (b, n) => n.x >= b.x - 1 && n.y >= b.y - 1 && n.x + n.w <= b.x + b.w + 1 && n.y + n.h <= b.y + b.h + 1;
const isSidebar = (L, n) => n.t === "rect" && n.x <= 2 && n.w >= 160 && n.w <= 320 && n.h >= L.h * 0.6 && n.bg && n.bg[0] + n.bg[1] + n.bg[2] < 330;
// Same piece on two screens: same kind, same place (text may change length).
const samePiece = (a, b) =>
  a.t === b.t && Math.abs(a.x - b.x) <= 3 && Math.abs(a.y - b.y) <= 3 && Math.abs(a.h - b.h) <= 4 && (a.t === "text" || Math.abs(a.w - b.w) <= 3);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function regionsOf(L, { libraryNav }) {
  const out = [];
  const sb = libraryNav ? null : L.nodes.find((n) => isSidebar(L, n));
  if (sb) out.push({ kind: "nav", name: "Left navigation", box: sb });
  const left = sb ? sb.x + sb.w : 0;
  const hd = L.nodes.find((n) => n.t === "rect" && n.y <= 2 && n.h >= 40 && n.h <= 120 && n.x >= left - 2 && n.w >= (L.w - left) * 0.8);
  if (hd) out.push({ kind: "header", name: "Top header", box: hd });
  return out;
}

// screens: [{ id, layout }] in build order. Returns, per screen, the layout
// without the shared regions and the instances to place instead.
export function sharedParts(screens, { pageName = "", libraryNav = false } = {}) {
  const groups = new Map();
  const perScreen = {};
  for (const { id, layout: L } of screens) {
    let nodes = L.nodes.slice();
    for (const r of regionsOf(L, { libraryNav })) {
      const b = r.box;
      const inside = nodes.filter((n) => contains(b, n));
      if (!inside.length) continue;
      nodes = nodes.filter((n) => !inside.includes(n));
      const key = `${r.kind}:${Math.round(b.w / 8)}x${Math.round(b.h / 8)}`;
      if (!groups.has(key)) groups.set(key, { key, kind: r.kind, name: r.name, w: b.w, h: b.h, members: [] });
      groups.get(key).members.push({ sid: id, x: b.x, y: b.y, nodes: inside.map((n) => ({ ...n, x: n.x - b.x, y: n.y - b.y })) });
    }
    perScreen[id] = { layout: { ...L, nodes }, parts: [] };
  }
  const named = {};
  for (const g of groups.values()) {
    // The component holds every piece seen on any screen; each screen hides what it lacks.
    const union = [];
    for (const m of g.members) {
      m.hit = new Map();
      for (const n of m.nodes) {
        let i = union.findIndex((u, j) => !m.hit.has(j) && samePiece(u, n));
        if (i < 0) i = union.push(n) - 1;
        m.hit.set(i, n);
      }
    }
    named[g.kind] = (named[g.kind] || 0) + 1;
    const name = named[g.kind] > 1 ? `${g.name} ${named[g.kind]}` : g.name;
    const nodes = compact({ w: g.w, h: g.h, nodes: union }).n;
    const def = {
      id: crypto.createHash("sha1").update(`${pageName}|${g.key}`).digest("hex").slice(0, 12),
      name,
      w: g.w,
      h: g.h,
      nodes,
      hash: crypto.createHash("sha1").update(JSON.stringify(nodes)).digest("hex").slice(0, 12),
    };
    for (const m of g.members) {
      const use = { def, x: m.x, y: m.y, hide: [], text: {}, bg: {}, color: {} };
      union.forEach((u, i) => {
        const n = m.hit.get(i);
        if (!n) return use.hide.push(i);
        if ((n.text || "") !== (u.text || "")) use.text[i] = n.text || "";
        if (!same(n.bg, u.bg)) use.bg[i] = n.bg || null;
        if (!same(n.f?.color, u.f?.color)) use.color[i] = n.f?.color || null;
      });
      perScreen[m.sid].parts.push(use);
    }
  }
  return perScreen;
}

export function screenScript({ layout, frameName, pageName, x, y, lib, screenId, notes }) {
  const data = { layout: compact(layout), frameName, pageName, x, y, screenId, notes: notes || "", lib: { components: lib.components, fills: lib.fills, texts: lib.texts } };
  return `${BUILDER}\nreturn await buildScreen(${JSON.stringify(data)});`;
}

// Install the builder + library profile into the Figma file once (hidden
// shared plugin data). Each screen then needs only a short call.
export const ENGINE_VERSION = "1";
export function installScript(lib) {
  return `figma.root.setSharedPluginData("trace", "builder", ${JSON.stringify(BUILDER)});
figma.root.setSharedPluginData("trace", "builder_v", ${JSON.stringify(ENGINE_VERSION)});
figma.root.setSharedPluginData("trace", "lib_${lib.id}", ${JSON.stringify(JSON.stringify({ components: lib.components, fills: lib.fills, texts: lib.texts }))});
return { installed: true, bytes: ${BUILDER.length} };`;
}
export function screenCall({ layout, frameName, pageName, x, y, libId, screenId, notes, parts = [] }) {
  const data = { layout: compact(layout), frameName, pageName, x, y, libId, screenId, notes: notes || "", parts };
  return `const src = figma.root.getSharedPluginData("trace", "builder");
if (!src) throw new Error("Trace builder not installed in this file");
const AF = Object.getPrototypeOf(async function () {}).constructor;
return await new AF("D", src + ";return await buildScreen(D);")(${JSON.stringify(data)});`;
}

export function linksScript({ pageName, links }) {
  return `${LINKER}\nreturn await linkFrames(${JSON.stringify({ pageName, links })});`;
}

// ---------------------------------------------------------------------------
// Runs inside Figma.
const BUILDER = String.raw`
async function buildScreen(D) {
  const L = D.layout, lib = D.lib || JSON.parse(figma.root.getSharedPluginData("trace", "lib_" + D.libId));
  const report = { frame: null, instances: {}, styled: 0, raw: 0, frames: 0, failures: [] };
  const count = (k) => (report.instances[k] = (report.instances[k] || 0) + 1);

  let page = figma.root.children.find((p) => p.name === D.pageName);
  if (!page) { page = figma.createPage(); page.name = D.pageName; }
  await figma.setCurrentPageAsync(page);
  for (const old of page.children.filter((c) => c.name === D.frameName || c.name === "Notes — " + D.frameName)) old.remove();

  // ---- tokens
  const fillList = Object.entries(lib.fills).map(([name, [key, hex]]) => ({ name, key, rgb: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) }));
  const styleCache = {};
  const styleId = async (key) => (styleCache[key] ||= (await figma.importStyleByKeyAsync(key)).id);
  const nearestFill = (c) => {
    let best = null, bd = 1e9;
    for (const f of fillList) { const d = Math.hypot(f.rgb[0] - c[0], f.rgb[1] - c[1], f.rgb[2] - c[2]); if (d < bd) { bd = d; best = f; } }
    return bd <= 8 ? best : null;
  };
  const paint = (c) => ({ type: "SOLID", color: { r: c[0] / 255, g: c[1] / 255, b: c[2] / 255 }, opacity: c[3] == null ? 1 : c[3] });
  async function fill(node, c, prop) {
    if (!c) { node[prop || "fills"] = []; return; }
    const f = c[3] === 1 || c[3] == null ? nearestFill(c) : null;
    if (f) {
      try {
        const id = await styleId(f.key);
        if (prop === "strokes") await node.setStrokeStyleIdAsync(id); else await node.setFillStyleIdAsync(id);
        report.styled++;
        return;
      } catch (e) { /* fall back to raw colour */ }
    }
    node[prop || "fills"] = [paint(c)];
    report.raw++;
  }
  const textStyles = Object.entries(lib.texts).map(([name, [key, size, weight]]) => ({ name, key, size, weight }));
  const W = (w) => (w >= 650 ? 600 : w >= 550 ? 600 : w >= 450 ? 500 : 400);
  const styleName = (w) => (w >= 700 ? "Bold" : w >= 600 ? "Semi Bold" : w >= 500 ? "Medium" : "Regular");
  const loaded = new Set();
  const font = async (style) => { const f = { family: "Inter", style }; const k = style; if (!loaded.has(k)) { await figma.loadFontAsync(f); loaded.add(k); } return f; };
  async function text(parent, n, x, y, w, h) {
    const t = figma.createText();
    const f = n.f || { size: 14, weight: 400 };
    const ts = textStyles.find((s) => s.size === f.size && s.weight === W(f.weight));
    t.fontName = await font(styleName(ts ? ts.weight : f.weight));
    t.characters = n.text || " ";
    if (ts) { try { await t.setTextStyleIdAsync(await styleId(ts.key)); report.styled++; } catch (e) { t.fontSize = f.size; } }
    else { t.fontSize = Math.max(1, f.size || 14); if (f.lh) t.lineHeight = { unit: "PIXELS", value: f.lh }; report.raw++; }
    await fill(t, f.color || [0, 0, 0, 1]);
    parent.appendChild(t);
    const single = h <= (f.lh || f.size * 1.5) * 1.6;
    if (single) t.textAutoResize = "WIDTH_AND_HEIGHT";
    else { t.textAutoResize = "HEIGHT"; t.resize(Math.max(1, w + 2), t.height); }
    if (f.align === "center" && single) t.x = x + (w - t.width) / 2; else if ((f.align === "right" || f.align === "end") && single) t.x = x + w - t.width; else t.x = x;
    t.y = y + Math.max(0, (h - t.height) / 2);
    t.name = (n.text || "Text").slice(0, 40);
    return t;
  }
  async function box(parent, n, name) {
    const r = figma.createFrame();
    r.name = name;
    r.resize(Math.max(1, n.w), Math.max(1, n.h));
    r.x = n.x; r.y = n.y;
    r.clipsContent = false;
    await fill(r, n.bg);
    if (n.border && n.border.c) { await fill(r, n.border.c, "strokes"); r.strokeWeight = n.border.w; r.strokeAlign = "INSIDE"; }
    else if (n.bottom && n.bottom.c) { await fill(r, n.bottom.c, "strokes"); r.strokeAlign = "INSIDE"; r.strokeTopWeight = 0; r.strokeLeftWeight = 0; r.strokeRightWeight = 0; r.strokeBottomWeight = n.bottom.w; }
    else if (n.right && n.right.c) { await fill(r, n.right.c, "strokes"); r.strokeAlign = "INSIDE"; r.strokeTopWeight = 0; r.strokeLeftWeight = 0; r.strokeBottomWeight = 0; r.strokeRightWeight = n.right.w; }
    if (n.r) r.cornerRadius = Math.min(n.r, n.w / 2, n.h / 2);
    if (n.shadow) r.effects = [{ type: "DROP_SHADOW", color: { r: 0.06, g: 0.09, b: 0.16, a: 0.08 }, offset: { x: 0, y: 4 }, radius: 12, spread: -2, visible: true, blendMode: "NORMAL" }];
    parent.appendChild(r);
    report.frames++;
    return r;
  }

  // ---- library components
  const sets = {};
  async function variant(name, want) {
    const c = lib.components[name];
    if (!c) return null;
    const set = (sets[name] ||= await figma.importComponentSetByKeyAsync(c.set));
    const score = (v) => Object.entries(want).reduce((s, [k, val]) => s + (v.variantProperties && v.variantProperties[k] === val ? 1 : 0), 0);
    let best = set.defaultVariant, bs = 0; // nothing matches → the set's default variant
    for (const v of set.children) { const s = score(v); if (s > bs) { bs = s; best = v; } }
    return best;
  }
  // Prefer the label layer: bound to a TEXT property, or named Text/Label.
  // (V1 draws icons with an icon font, so the first text layer can be the icon.)
  async function setLabel(inst, label) {
    if (!label) return;
    const defs = inst.componentProperties || {};
    const tp = Object.keys(defs).find((k) => defs[k].type === "TEXT");
    if (tp) { inst.setProperties({ [tp]: label }); return; }
    const ts = inst.findAll((x) => x.type === "TEXT" && x.visible);
    if (!ts.length) return;
    const t = ts.find((x) => /^(text|label|button text)$/i.test(x.name)) || ts.find((x) => x.name !== "image" && !/icon/i.test(x.name)) || ts[ts.length - 1];
    for (const f of t.getRangeAllFontNames(0, t.characters.length)) await figma.loadFontAsync(f);
    t.characters = label;
  }
  const hue = (c) => {
    if (!c) return "Gray";
    const [r, g, b] = c; const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 18) return "Gray";
    if (b >= r && b >= g) return "Blue";
    if (g >= r && g >= b) return "Green";
    return r > 200 && g > 120 ? "Orange" : "Red";
  };

  // ---- frame
  const frame = figma.createFrame();
  frame.name = D.frameName;
  frame.resize(L.w, L.h);
  frame.x = D.x; frame.y = D.y;
  frame.clipsContent = true;
  await fill(frame, L.bg);
  page.appendChild(frame);

  // Sidebar drawn as a plain dark panel → library Navigation; drop what's inside it.
  let list = L.n.slice();
  const sb = list.find((n) => n.t === "rect" && n.x <= 2 && n.w >= 160 && n.w <= 320 && n.h >= L.h * 0.6 && n.bg && n.bg[0] + n.bg[1] + n.bg[2] < 330);
  if (sb && !list.some((n) => n.t === "nav")) {
    list = list.filter((n) => n === sb || !(n.x >= sb.x && n.y >= sb.y && n.x + n.w <= sb.x + sb.w + 1 && n.y + n.h <= sb.y + sb.h + 1));
    sb.t = "nav";
  }
  // Pill-shaped buttons are chips in the design system.
  for (const n of list) if (n.t === "button" && n.text && n.h <= 32 && n.r >= n.h / 2 - 1 && n.bg) n.t = "chip";

  async function draw(parent, n) {
    if (n.t === "nav") {
      const v = await variant("Navigation", { Type: "Default", Size: "Desktop" });
      const inst = v.createInstance(); parent.appendChild(inst);
      inst.x = n.x; inst.y = n.y;
      try { inst.resize(n.w, Math.max(inst.height, n.h)); } catch (e) {}
      inst.name = "Navigation";
      count("Navigation");
    } else if (n.t === "button" && n.text && n.text.length <= 3 && n.w <= 48) {
      // initials → avatar
      const a = figma.createFrame(); a.name = "Avatar / " + n.text;
      const d = Math.min(n.w, n.h, 32); a.resize(d, d); a.cornerRadius = d / 2;
      a.x = n.x + (n.w - d) / 2; a.y = n.y + (n.h - d) / 2;
      await fill(a, [234, 236, 240, 1]); parent.appendChild(a);
      await text(a, { text: n.text, f: { size: 12, weight: 600, color: [52, 64, 84, 1], align: "center" } }, 0, 0, d, d);
    } else if (n.t === "button" && n.h <= 56 && n.w <= 420) {
      const filled = n.bg && n.bg[3] >= 0.9 && hue(n.bg) === "Blue";
      const hierarchy = filled ? "Primary" : n.bg && n.bg[3] >= 0.9 || n.border ? "Secondary" : n.f && n.f.color && hue(n.f.color) === "Blue" ? "Subtle link" : "Tertiary gray";
      const size = n.h <= 36 ? "sm" : n.h <= 40 ? "md" : n.h <= 44 ? "lg" : "xl";
      const icon = n.icon && n.text ? "Leading" : n.icon ? "Only" : "False";
      const v = await variant("Button", { Hierarchy: hierarchy, Size: size, Icon: icon, State: n.disabled ? "Disabled" : "Default", Destructive: "False" });
      const inst = v.createInstance(); parent.appendChild(inst);
      if (n.text) await setLabel(inst, n.text);
      try { inst.resize(Math.max(inst.width, n.w), inst.height); } catch (e) {}
      inst.x = n.x; inst.y = n.y + (n.h - inst.height) / 2;
      inst.name = "Button / " + (n.text || "icon").slice(0, 30);
      count("Button");
    } else if (n.t === "chip") {
      const v = await variant("Chip", { Size: n.h <= 22 ? "sm" : n.h <= 26 ? "md" : "lg", Type: "Pill", Icon: "None", Color: hue(n.bg), State: "Default" });
      const inst = v.createInstance(); parent.appendChild(inst);
      await setLabel(inst, n.text);
      if (inst.width > n.w + 4) { try { inst.resize(n.w, inst.height); } catch (e) {} }
      inst.x = n.x; inst.y = n.y + (n.h - inst.height) / 2;
      inst.name = "Chip / " + n.text.slice(0, 30);
      count("Chip");
    } else if (n.t === "input" && !n.multiline && lib.components["Text field"]) {
      // Library first: small differences from the prototype's styling are accepted.
      const v = await variant("Text field", {});
      const inst = v.createInstance(); parent.appendChild(inst);
      try { inst.resize(Math.max(1, n.w), inst.height); } catch (e) {}
      inst.x = n.x; inst.y = n.y + (n.h - inst.height) / 2;
      const label = n.value || n.placeholder;
      if (label) await setLabel(inst, label);
      inst.name = "Text field" + (label ? " / " + label.slice(0, 30) : "");
      count("Text field");
    } else if (n.t === "input") {
      const r = await box(parent, n, n.multiline ? "Text area" : "Input");
      const label = n.value || n.placeholder;
      if (label) {
        const t = await text(r, { text: label, f: { ...(n.f || {}), color: n.value ? n.f && n.f.color : [102, 112, 133, 1] } }, 12, n.multiline ? 10 : 0, n.w - 24, n.multiline ? 20 : n.h);
      }
      if (n.focused) r.effects = [{ type: "DROP_SHADOW", color: { r: 0, g: 0.45, b: 0.62, a: 0.25 }, offset: { x: 0, y: 0 }, radius: 0, spread: 3, visible: true, blendMode: "NORMAL" }];
    } else if (n.t === "image") {
      const r = figma.createFrame();
      r.resize(Math.max(1, n.w), Math.max(1, n.h)); r.x = n.x; r.y = n.y;
      if (n.kind === "svg" && n.w <= 40) { r.name = "Icon"; r.cornerRadius = 3; r.fills = [paint([...(n.fill || [102, 112, 133]).slice(0, 3), 0.35])]; }
      else { r.name = "Image: " + (n.name || "image"); r.cornerRadius = 4; await fill(r, [234, 236, 240, 1]); }
      parent.appendChild(r);
    } else if (n.t === "check") {
      const r = await box(parent, { ...n, bg: n.on ? [0, 114, 159, 1] : [255, 255, 255, 1], border: { w: 1, c: n.on ? [0, 114, 159, 1] : [208, 213, 221, 1] }, r: n.kind === "radio" ? 99 : 4 }, n.kind === "radio" ? "Radio" : "Checkbox");
    } else if (n.t === "button") {
      // big clickable card → plain frame + label
      const r = await box(parent, n, "Card");
      if (n.text) await text(r, { text: n.text, f: n.f }, 16, 0, n.w - 32, n.h);
    } else if (n.t === "rect") {
      await box(parent, n, n.fixed ? "Overlay" : "Container");
    } else if (n.t === "text") {
      await text(parent, n, n.x, n.y, n.w, n.h);
    }
  }

  // ---- shared parts (built once as components, placed as instances)
  async function partsPage() {
    let pg = figma.root.children.find((p) => p.name === "Trace · Shared parts");
    if (!pg) { pg = figma.createPage(); pg.name = "Trace · Shared parts"; }
    return pg;
  }
  async function master(def) {
    const key = "part_" + def.id;
    let comp = null;
    const id = figma.root.getSharedPluginData("trace", key);
    if (id) { comp = await figma.getNodeByIdAsync(id); if (comp && comp.type !== "COMPONENT") comp = null; }
    if (comp && comp.getSharedPluginData("trace", "hash") === def.hash) return comp;
    if (!comp) {
      const pg = await partsPage();
      comp = figma.createComponent();
      comp.y = pg.children.reduce((m, c) => Math.max(m, c.y + c.height + 120), 0);
      pg.appendChild(comp);
      figma.root.setSharedPluginData("trace", key, comp.id);
    } else for (const c of [...comp.children]) c.remove(); // design changed: redraw in place, instances follow
    comp.name = def.name;
    comp.resize(Math.max(1, def.w), Math.max(1, def.h));
    comp.clipsContent = true;
    comp.fills = [];
    const map = [];
    for (const n of def.nodes) {
      const before = comp.children.length;
      try { await draw(comp, n); } catch (e) { report.failures.push(def.name + " / " + (n.t || "?") + ": " + e.message); }
      map.push(comp.children.length > before ? comp.children.length - 1 : -1);
    }
    comp.setSharedPluginData("trace", "hash", def.hash);
    comp.setSharedPluginData("trace", "map", JSON.stringify(map));
    return comp;
  }
  async function setText(k, value) {
    if (k.type === "INSTANCE") return setLabel(k, value);
    const t = k.type === "TEXT" ? k : k.findOne && k.findOne((x) => x.type === "TEXT");
    if (!t) return;
    for (const f of t.getRangeAllFontNames(0, t.characters.length)) await figma.loadFontAsync(f);
    t.characters = value || " ";
  }
  report.parts = [];
  for (const use of D.parts || []) {
    try {
      const comp = await master(use.def);
      const map = JSON.parse(comp.getSharedPluginData("trace", "map") || "[]");
      const inst = comp.createInstance();
      frame.appendChild(inst);
      inst.x = use.x; inst.y = use.y;
      const kid = (i) => inst.children[map[i]];
      for (const i of use.hide) { const k = kid(i); if (k) k.visible = false; }
      for (const [i, v] of Object.entries(use.text)) { const k = kid(i); if (k) await setText(k, v); }
      for (const [i, c] of Object.entries(use.bg)) { const k = kid(i); if (k && k.type !== "TEXT" && k.type !== "INSTANCE") await fill(k, c); }
      for (const [i, c] of Object.entries(use.color)) {
        const k = kid(i);
        const t = k && (k.type === "TEXT" ? k : k.type !== "INSTANCE" && k.findOne && k.findOne((x) => x.type === "TEXT"));
        if (t) await fill(t, c || [0, 0, 0, 1]);
      }
      report.parts.push(comp.name);
      count(comp.name);
    } catch (e) {
      report.failures.push((use.def.name || "Shared part") + ": " + e.message);
    }
  }

  for (const n of list) {
    try {
      await draw(frame, n);
    } catch (e) {
      report.failures.push((n.t || "?") + ": " + e.message);
    }
  }
  if (D.notes) {
    const panel = figma.createAutoLayout("VERTICAL", { name: "Notes — " + D.frameName, itemSpacing: 6 });
    panel.paddingTop = panel.paddingBottom = panel.paddingLeft = panel.paddingRight = 16;
    panel.cornerRadius = 8;
    panel.fills = [{ type: "SOLID", color: { r: 1, g: 0.97, b: 0.84 } }];
    page.appendChild(panel);
    panel.x = D.x; panel.y = D.y - 120;
    const t = figma.createText(); t.fontName = await font("Regular"); t.fontSize = 13; t.characters = "Handoff note: " + D.notes; panel.appendChild(t);
  }
  frame.setSharedPluginData && (() => { try { frame.setSharedPluginData("trace", "screenId", D.screenId); } catch (e) {} })();
  report.frame = frame.id;
  return report;
}
`;

const LINKER = String.raw`
async function linkFrames(D) {
  const page = figma.root.children.find((p) => p.name === D.pageName);
  await figma.setCurrentPageAsync(page);
  await figma.loadFontAsync({ family: "Inter", style: "Medium" });
  for (const old of page.children.filter((c) => c.name.startsWith("Flow arrow"))) old.remove();
  const byName = (n) => page.children.find((c) => c.type === "FRAME" && c.name === n);
  const made = [], failures = [];
  for (const l of D.links) {
    const from = byName(l.from), to = byName(l.to);
    if (!from || !to) { failures.push("missing frame for " + l.label); continue; }
    // prototype link from the clicked control when it can be found
    const want = (l.label.match(/"(.+)"/) || [])[1];
    const src = (want && from.findOne((n) => n.type === "INSTANCE" && n.name.toLowerCase().includes(want.toLowerCase()))) || from;
    try {
      const keep = (src.reactions || []).filter((r) => !(r.actions || []).some((a) => a.destinationId === to.id));
      await src.setReactionsAsync([...keep, { trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: to.id, navigation: "NAVIGATE", transition: { type: "DISSOLVE", easing: { type: "EASE_OUT" }, duration: 0.25 }, preserveScrollPosition: false }] }]);
    } catch (e) { failures.push(l.label + ": " + e.message); }
    // labelled arrow on the canvas
    const sameCol = Math.abs(from.x - to.x) < 10;
    const x1 = sameCol ? from.x - 24 : from.x + from.width + 20, y1 = sameCol ? from.y + 60 : from.y + 200;
    const x2 = sameCol ? to.x - 24 : to.x - 20, y2 = sameCol ? to.y + 60 : to.y + 200;
    const v = figma.createVector();
    v.vectorPaths = [{ windingRule: "NONE", data: sameCol ? "M 0 0 L -40 0 L -40 " + (y2 - y1) + " L 0 " + (y2 - y1) : "M 0 0 L " + (x2 - x1) + " " + (y2 - y1) }];
    v.strokes = [{ type: "SOLID", color: { r: 0.36, g: 0.3, b: 0.94 } }];
    v.strokeWeight = 3;
    v.strokeCap = "ARROW_LINES";
    v.x = Math.min(x1, x2) - (sameCol ? 40 : 0); v.y = Math.min(y1, y2);
    page.appendChild(v);
    const tag = figma.createAutoLayout("HORIZONTAL", { name: "Flow arrow label" });
    tag.paddingLeft = tag.paddingRight = 12; tag.paddingTop = tag.paddingBottom = 6; tag.cornerRadius = 999;
    tag.fills = [{ type: "SOLID", color: { r: 0.36, g: 0.3, b: 0.94 } }];
    const t = figma.createText(); t.fontName = { family: "Inter", style: "Medium" }; t.fontSize = 18; t.characters = l.label; t.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    tag.appendChild(t); page.appendChild(tag);
    tag.x = sameCol ? x1 - 60 - tag.width : (x1 + x2) / 2 - tag.width / 2; tag.y = sameCol ? (y1 + y2) / 2 - tag.height / 2 : (y1 + y2) / 2 - 40;
    const g = figma.group([v, tag], page); g.name = "Flow arrow — " + l.label;
    made.push(g.id);
  }
  const first = D.links[0] && byName(D.links[0].from);
  if (first) page.flowStartingPoints = [{ nodeId: first.id, name: D.pageName.replace("Trace / ", "") }];
  return { arrows: made.length, failures };
}
`;
