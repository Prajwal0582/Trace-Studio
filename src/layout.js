// Runs inside the prototype page (serialized by Playwright; no imports).
// Records what a screen is made of so it can be rebuilt in Figma:
//   rect   – a box with a background / border / shadow (cards, panels, overlays)
//   text   – a run of text with its font
//   button – a clickable control with a label   → library Button
//   input  – text field / textarea / select       → library Text field (or frames)
//   chip   – small rounded label                  → library Chip
//   image  – img / svg / canvas                   → placeholder frame named after it
//   nav    – the app's left sidebar               → one shared component, reused per screen
//   group  – invisible outline of a code component or dialog (`dlg`; not drawn)
// Nodes drawn by a named React component carry its name in `c`.
// Coordinates are relative to the captured area (viewport, or full page).
export function extractLayout({ fullPage }) {
  const vw = window.innerWidth;
  const vh = fullPage ? Math.max(document.documentElement.scrollHeight, window.innerHeight) : window.innerHeight;
  const ox = fullPage ? 0 : window.scrollX;
  const oy = fullPage ? 0 : window.scrollY;
  const nodes = [];
  // Any CSS colour → [r, g, b, a]. rgb() is parsed directly; newer formats
  // (oklch / oklab / color(), used by Tailwind v4) are painted on a 1px canvas.
  const seenColors = {};
  let paint = null;
  const viaCanvas = (c) => {
    if (c in seenColors) return seenColors[c];
    paint ||= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    paint.fillStyle = "#010203";
    paint.fillStyle = c;
    if (paint.fillStyle === "#010203" && !/^#010203$/i.test(c)) return (seenColors[c] = null); // not a colour
    paint.clearRect(0, 0, 1, 1);
    paint.fillRect(0, 0, 1, 1);
    const d = paint.getImageData(0, 0, 1, 1).data;
    const a = d[3] / 255;
    return (seenColors[c] = a < 0.02 ? null : [d[0], d[1], d[2], Math.round(a * 100) / 100]);
  };
  const rgba = (c) => {
    if (!c || c === "transparent") return null;
    const m = String(c).match(/^rgba?\(([^)]+)\)$/);
    if (!m) return viaCanvas(String(c));
    const p = m[1].split(",").map((v) => parseFloat(v));
    const a = p[3] == null ? 1 : p[3];
    if (a < 0.02) return null;
    return [Math.round(p[0]), Math.round(p[1]), Math.round(p[2]), Math.round(a * 100) / 100];
  };
  const boxOf = (r) => ({ x: Math.round(r.left + window.scrollX - ox), y: Math.round(r.top + window.scrollY - oy), w: Math.round(r.width), h: Math.round(r.height) });
  const onCanvas = (b) => b.w >= 1 && b.h >= 1 && b.x + b.w > 0 && b.y + b.h > 0 && b.x < vw && b.y < vh;
  const visible = (el, cs) => cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.02;
  const font = (cs) => ({ size: Math.round(parseFloat(cs.fontSize)), weight: parseInt(cs.fontWeight, 10) || 400, color: rgba(cs.color), align: cs.textAlign, lh: cs.lineHeight === "normal" ? null : Math.round(parseFloat(cs.lineHeight)) });
  const deco = (cs) => {
    const bw = parseFloat(cs.borderTopWidth) || 0;
    return {
      bg: rgba(cs.backgroundColor),
      border: bw > 0 && cs.borderTopStyle !== "none" ? { w: bw, c: rgba(cs.borderTopColor) } : null,
      bottom: !(bw > 0) && parseFloat(cs.borderBottomWidth) > 0 ? { w: parseFloat(cs.borderBottomWidth), c: rgba(cs.borderBottomColor) } : null,
      right: !(bw > 0) && parseFloat(cs.borderRightWidth) > 0 ? { w: parseFloat(cs.borderRightWidth), c: rgba(cs.borderRightColor) } : null,
      r: Math.round(parseFloat(cs.borderTopLeftRadius) || 0),
      shadow: cs.boxShadow && cs.boxShadow !== "none",
      grad: cs.backgroundImage && cs.backgroundImage.includes("gradient"),
    };
  };
  // Which code (React) component drew this element: the outermost named
  // component whose first DOM node is `el`. Lets Trace tell "the same component
  // again" from "something that happens to look similar".
  const fiberOf = (el) => {
    for (const k in el) if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return el[k];
    return null;
  };
  const typeName = (t) => {
    if (!t) return null;
    if (typeof t === "function") return t.displayName || t.name || null;
    if (typeof t === "object") return t.displayName || (t.render && (t.render.displayName || t.render.name)) || (t.type && typeName(t.type)) || null;
    return null;
  };
  const firstHost = (fiber) => {
    const stack = fiber.child ? [fiber.child] : [];
    while (stack.length) {
      const f = stack.pop();
      if (f.stateNode instanceof Element) return f.stateNode;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  };
  // Wrappers and minified names say nothing about what the component is.
  const GENERIC = /^(Styled\(|Mui\w*Root$|Box$|Stack$|Grid2?$|Container$|Fragment$|Insertion$|ForwardRef|Memo|Anonymous|Unstable_|Provider$|Consumer$|Router|Route$|Routes$|Suspense$|StrictMode$)/;
  const codeName = (el) => {
    let f = fiberOf(el);
    if (!f) return null;
    let name = null;
    for (f = f.return; f && !(f.stateNode instanceof Element); f = f.return) {
      const n = typeof f.type === "string" ? null : typeName(f.type);
      if (n && /^[A-Z][A-Za-z0-9_]{2,}$/.test(n) && !GENERIC.test(n) && firstHost(f) === el) name = n;
    }
    return name;
  };
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();

  // Is `el` really what the viewer sees at the middle of box `b`? Content scrolled
  // under a sticky bar, or hidden behind another layer, is not drawn.
  let curClip = null; // visible area of the scroll containers we're inside
  const inClip = (b) => !curClip || (b.x + b.w / 2 >= curClip.x && b.x + b.w / 2 <= curClip.x + curClip.w && b.y + b.h / 2 >= curClip.y && b.y + b.h / 2 <= curClip.y + curClip.h);
  const shown = (el, b) => {
    if (!inClip(b)) return false;
    if (fullPage) return true;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) return false;
    const hit = document.elementFromPoint(cx, cy);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  let scrimOpen = false; // inside a full-screen see-through layer: the next panel is a dialog
  let dialogEl = null; // nodes drawn inside it are the dialog's own (dg)
  const walk = (el, clip) => {
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) return;
    const r = el.getBoundingClientRect();
    const b = boxOf(r);
    const tag = el.tagName.toLowerCase();
    if (b.w < 1 || b.h < 1) {
      if (cs.overflow === "visible") for (const c of el.children) walk(c, clip);
      return;
    }
    if (!onCanvas(b) && cs.position !== "fixed") return;
    curClip = clip;
    const d = deco(cs);
    const c = codeName(el);
    const push = (n) => nodes.push({ ...n, ...(c && n.t !== "text" ? { c } : {}), ...(dialogEl && dialogEl.contains(el) && !n.dlg ? { dg: 1 } : {}) });
    // Dialogs (modals, confirm popups) are built on their own and shown as Figma overlays:
    // marked in code (role=dialog, aria-modal, <dialog>), or a panel sitting on a fixed,
    // see-through layer that covers the screen (the usual hand-made modal).
    const isScrim = cs.position === "fixed" && b.w >= vw * 0.9 && b.h >= vh * 0.9 && d.bg && d.bg[3] < 1;
    if (isScrim) scrimOpen = true;
    const marked = el.getAttribute("role") === "dialog" || el.getAttribute("role") === "alertdialog" || el.getAttribute("aria-modal") === "true" || (tag === "dialog" && el.open);
    if (marked || (scrimOpen && !isScrim && d.bg && d.bg[3] >= 0.9 && b.w < vw * 0.9 && b.h < vh * 0.95)) {
      push({ t: "group", ...b, dlg: true });
      dialogEl = el;
      scrimOpen = false;
    }

    // left app sidebar
    // (its contents are recorded too, so it can be rebuilt as it really looks)
    const isNav = (tag === "aside" || tag === "nav" || el.getAttribute("role") === "navigation") && b.x <= 2 && b.w >= 160 && b.w <= 320 && b.h >= vh * 0.6;
    if (isNav) push({ t: "nav", ...b, ...d });
    const role = el.getAttribute("role");
    // Only button-sized controls; big clickable cards are rebuilt from their parts.
    const isButton = (tag === "button" || role === "button" || (tag === "a" && (d.bg || d.border))) && b.h <= 56 && b.w <= 420;
    if (isButton) {
      const txt = label(el);
      const hasIcon = !!el.querySelector("svg,img");
      if ((txt || hasIcon) && !shown(el, b)) return;
      if (txt || hasIcon) {
        push({ t: "button", ...b, text: txt.slice(0, 60), icon: hasIcon, disabled: el.disabled || el.getAttribute("aria-disabled") === "true", ...d, f: font(cs) });
        return;
      }
    }
    if (tag === "input" && ["checkbox", "radio"].includes(el.type)) {
      if (shown(el, b)) push({ t: "check", ...b, on: el.checked, kind: el.type });
      return;
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const v = tag === "select" ? el.options[el.selectedIndex]?.text || "" : el.value;
      if (shown(el, b)) push({ t: "input", ...b, value: v, placeholder: el.placeholder || "", focused: el === document.activeElement, multiline: tag === "textarea", ...d, f: font(cs) });
      return;
    }
    if (tag === "img" || tag === "svg" || tag === "canvas" || tag === "video") {
      if (shown(el, b)) push({ t: "image", ...b, kind: tag, name: el.getAttribute("alt") || el.getAttribute("aria-label") || (tag === "svg" ? "icon" : tag), fill: tag === "svg" ? rgba(cs.color) : null });
      return;
    }
    // chip: small pill with its own text
    const txtAll = label(el);
    if (d.bg && b.h <= 30 && b.w <= 260 && d.r >= 8 && txtAll && txtAll.length <= 40 && el.children.length <= 3) {
      if (shown(el, b)) push({ t: "chip", ...b, text: txtAll, ...d, f: font(cs) });
      return;
    }
    if (isNav) {
      /* already recorded */
    } else if (d.bg || d.border || d.shadow || d.bottom || d.right || d.grad) {
      if (!(b.w >= vw - 2 && b.h >= vh - 2 && !d.border && d.bg && d.bg[3] === 1 && nodes.length === 0 && false)) {
        let rb = b;
        if (clip && cs.position !== "fixed") {
          const x1 = Math.max(b.x, clip.x), y1 = Math.max(b.y, clip.y), x2 = Math.min(b.x + b.w, clip.x + clip.w), y2 = Math.min(b.y + b.h, clip.y + clip.h);
          rb = x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
        }
        if (rb) push({ t: "rect", ...rb, ...d, fixed: cs.position === "fixed" });
      }
    } else if (c) push({ t: "group", ...b }); // invisible outline of a code component
    // own text runs
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rr = range.getBoundingClientRect();
      const tb = boxOf(rr);
      if (!onCanvas(tb) || !shown(el, tb)) continue;
      push({ t: "text", ...tb, text: n.textContent.replace(/\s+/g, " ").trim(), f: font(cs) });
    }
    // A scroll container (or overflow: hidden) cuts off what's outside it.
    let inner = cs.position === "fixed" ? null : clip; // fixed layers escape their parents' clipping
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
      const x1 = Math.max(b.x, inner ? inner.x : -1e9), y1 = Math.max(b.y, inner ? inner.y : -1e9);
      const x2 = Math.min(b.x + b.w, inner ? inner.x + inner.w : 1e9), y2 = Math.min(b.y + b.h, inner ? inner.y + inner.h : 1e9);
      inner = { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
    }
    for (const c of el.children) {
      curClip = inner;
      walk(c, inner);
    }
    curClip = clip;
  };
  walk(document.body, null);
  return { w: vw, h: vh, bg: rgba(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1], nodes };
}
