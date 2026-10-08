// Runs inside the prototype page (serialized by Playwright; no imports).
// Records what a screen is made of so it can be rebuilt in Figma:
//   rect   – a box with a background / border / shadow (cards, panels, overlays)
//   text   – a run of text with its font
//   button – a clickable control with a label   → library Button
//   input  – text field / textarea / select       → library Text field (or frames)
//   chip   – small rounded label                  → library Chip
//   image  – img / svg / canvas                   → placeholder frame named after it
//   nav    – the app's left sidebar               → library Navigation
// Coordinates are relative to the captured area (viewport, or full page).
export function extractLayout({ fullPage }) {
  const vw = window.innerWidth;
  const vh = fullPage ? Math.max(document.documentElement.scrollHeight, window.innerHeight) : window.innerHeight;
  const ox = fullPage ? 0 : window.scrollX;
  const oy = fullPage ? 0 : window.scrollY;
  const nodes = [];
  const rgba = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
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
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();

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
    const d = deco(cs);

    // left app sidebar
    if ((tag === "aside" || tag === "nav" || el.getAttribute("role") === "navigation") && b.x <= 2 && b.w >= 160 && b.w <= 320 && b.h >= vh * 0.6) {
      nodes.push({ t: "nav", ...b, bg: d.bg });
      return;
    }
    const role = el.getAttribute("role");
    // Only button-sized controls; big clickable cards are rebuilt from their parts.
    const isButton = (tag === "button" || role === "button" || (tag === "a" && (d.bg || d.border))) && b.h <= 56 && b.w <= 420;
    if (isButton) {
      const txt = label(el);
      const hasIcon = !!el.querySelector("svg,img");
      if (txt || hasIcon) {
        nodes.push({ t: "button", ...b, text: txt.slice(0, 60), icon: hasIcon, disabled: el.disabled || el.getAttribute("aria-disabled") === "true", ...d, f: font(cs) });
        return;
      }
    }
    if (tag === "input" && ["checkbox", "radio"].includes(el.type)) {
      nodes.push({ t: "check", ...b, on: el.checked, kind: el.type });
      return;
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const v = tag === "select" ? el.options[el.selectedIndex]?.text || "" : el.value;
      nodes.push({ t: "input", ...b, value: v, placeholder: el.placeholder || "", focused: el === document.activeElement, multiline: tag === "textarea", ...d, f: font(cs) });
      return;
    }
    if (tag === "img" || tag === "svg" || tag === "canvas" || tag === "video") {
      nodes.push({ t: "image", ...b, kind: tag, name: el.getAttribute("alt") || el.getAttribute("aria-label") || (tag === "svg" ? "icon" : tag), fill: tag === "svg" ? rgba(cs.color) : null });
      return;
    }
    // chip: small pill with its own text
    const txtAll = label(el);
    if (d.bg && b.h <= 30 && b.w <= 260 && d.r >= 8 && txtAll && txtAll.length <= 40 && el.children.length <= 3) {
      nodes.push({ t: "chip", ...b, text: txtAll, ...d, f: font(cs) });
      return;
    }
    if (d.bg || d.border || d.shadow || d.bottom || d.right || d.grad) {
      if (!(b.w >= vw - 2 && b.h >= vh - 2 && !d.border && d.bg && d.bg[3] === 1 && nodes.length === 0 && false)) {
        nodes.push({ t: "rect", ...b, ...d, fixed: cs.position === "fixed" });
      }
    }
    // own text runs
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rr = range.getBoundingClientRect();
      const tb = boxOf(rr);
      if (!onCanvas(tb)) continue;
      nodes.push({ t: "text", ...tb, text: n.textContent.replace(/\s+/g, " ").trim(), f: font(cs) });
    }
    for (const c of el.children) walk(c, clip);
  };
  walk(document.body, null);
  return { w: vw, h: vh, bg: rgba(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1], nodes };
}
