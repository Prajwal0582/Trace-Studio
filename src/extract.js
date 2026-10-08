// Runs inside the prototype page (serialized by Playwright). Must be fully
// self-contained: no imports, no closures over module scope.
//
// Walks the DOM and returns:
//   components – elements matched to a mapping entry (outermost match wins)
//   texts      – visible text not inside a matched component
//   unmatched  – visually significant elements Trace could not map (flagged for review)
export function extractInPage({ components: rules, minArea = 64 }) {
  const out = { components: [], texts: [], unmatched: [], page: {} };
  const doc = document.documentElement;
  out.page = {
    url: location.href,
    title: document.title,
    width: Math.max(doc.clientWidth, window.innerWidth),
    height: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
    background: getComputedStyle(document.body || doc).backgroundColor,
  };

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.01;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  const ownText = (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  // Box of the element's own text runs (excludes padding), so text lands
  // where it renders rather than at the container's corner.
  const textBox = (el) => {
    const range = document.createRange();
    let r = null;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      range.selectNodeContents(n);
      const b = range.getBoundingClientRect();
      r = r
        ? { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top), right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) }
        : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
    if (!r) return box(el);
    return {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.right - r.left),
      h: Math.round(r.bottom - r.top),
    };
  };
  const allText = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();

  // --- React fiber introspection ------------------------------------------
  const fiberOf = (el) => {
    for (const k in el) {
      if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return el[k];
    }
    return null;
  };
  const typeName = (t) => {
    if (!t) return null;
    if (typeof t === "function") return t.displayName || t.name || null;
    if (typeof t === "object") {
      if (t.displayName) return t.displayName;
      if (t.render) return t.render.displayName || t.render.name || null; // forwardRef
      if (t.type) return typeName(t.type); // memo
    }
    return null;
  };
  // First DOM element rendered by a composite fiber (depth-first, so wrappers
  // that render null first, e.g. Emotion's <Insertion/>, are skipped).
  const firstHostNode = (fiber) => {
    const stack = fiber.child ? [fiber.child] : [];
    while (stack.length) {
      const f = stack.pop();
      if (f.stateNode instanceof Element) return f.stateNode;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  };
  // React components whose outermost DOM node is `el` (innermost first).
  const reactComponentsFor = (el) => {
    const found = [];
    let f = fiberOf(el);
    if (!f) return found;
    f = f.return;
    while (f && !(f.stateNode instanceof Element)) {
      const name = typeName(f.type);
      if (name && typeof f.type !== "string" && firstHostNode(f) === el) {
        found.push({ name, props: f.memoizedProps || {} });
      }
      f = f.return;
    }
    return found;
  };
  // Generic wrappers say nothing about which design-system component this is.
  const GENERIC = /^(Styled\(|Mui\w*Root$|Box$|Stack$|Grid2?$|Container$|Fragment$|Insertion$|ForwardRef|Memo|Anonymous|Unstable_)/;
  const meaningfulName = (hits) => {
    for (let i = hits.length - 1; i >= 0; i--) if (!GENERIC.test(hits[i].name)) return hits[i].name;
    return null;
  };
  const primitiveProps = (props) => {
    const o = {};
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "children" || k.startsWith("on") || k === "sx" || k === "style") continue;
      if (["string", "number", "boolean"].includes(typeof v)) o[k] = v;
    }
    return o;
  };

  // --- Matching -------------------------------------------------------------
  const matchRule = (el) => {
    const dataName = (el.getAttribute("data-trace") || el.getAttribute("data-component") || "").toLowerCase();
    const reactHits = reactComponentsFor(el);
    for (const rule of rules) {
      if (dataName && rule.match.dataComponent.includes(dataName)) {
        return { rule, via: "data-attribute", react: reactHits[0] };
      }
    }
    for (const rule of rules) {
      const hit = reactHits.find((h) => rule.match.react.includes(h.name));
      if (hit) return { rule, via: "react:" + hit.name, react: hit };
    }
    for (const rule of rules) {
      for (const sel of rule.match.selectors) {
        try {
          if (el.matches(sel)) return { rule, via: "selector:" + sel, react: reactHits[0] };
        } catch {
          /* invalid selector in mapping – ignore */
        }
      }
    }
    return null;
  };

  const resolveProps = (rule, el, react) => {
    const props = {};
    const rprops = react ? react.props : {};
    for (const [figmaProp, spec] of Object.entries(rule.props || {})) {
      let v;
      if (spec.source === "prop") v = rprops[spec.key];
      else if (spec.source === "attr") v = el.getAttribute(spec.key);
      else if (spec.source === "text") v = allText(el);
      else if (spec.source === "class") {
        const m = (el.className && el.className.baseVal != null ? el.className.baseVal : el.className || "").match(
          new RegExp(spec.pattern)
        );
        v = m ? m[1] : undefined;
      } else if (spec.source === "state") {
        v = stateOf(el)[spec.key];
      }
      if (v == null && spec.default != null) v = spec.default;
      if (v == null) continue;
      if (spec.map && Object.prototype.hasOwnProperty.call(spec.map, String(v))) v = spec.map[String(v)];
      props[figmaProp] = typeof v === "boolean" ? v : String(v);
    }
    return props;
  };

  const stateOf = (el) => {
    const s = {};
    if (el.disabled || el.getAttribute("aria-disabled") === "true" || el.classList.contains("Mui-disabled"))
      s.disabled = true;
    if (el.getAttribute("aria-expanded") === "true") s.expanded = true;
    if (el.getAttribute("aria-selected") === "true" || el.classList.contains("Mui-selected")) s.selected = true;
    if (el.getAttribute("aria-checked") === "true" || el.checked || el.classList.contains("Mui-checked"))
      s.checked = true;
    if (el.getAttribute("aria-invalid") === "true" || el.classList.contains("Mui-error")) s.error = true;
    if (el.getAttribute("aria-busy") === "true") s.loading = true;
    if (el === document.activeElement || el.classList.contains("Mui-focused")) s.focused = true;
    return s;
  };

  // Text inside a matched component becomes overrides on the Figma instance.
  const textLayers = (el) => {
    const list = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    let n = el;
    while (n) {
      if (isVisible(n)) {
        const t = ownText(n);
        if (t) list.push(t);
        if ((n.tagName === "INPUT" || n.tagName === "TEXTAREA") && (n.value || n.placeholder)) {
          list.push(n.value || n.placeholder);
        }
      }
      n = walker.nextNode();
    }
    return list;
  };

  const SIGNIFICANT = new Set(["IMG", "SVG", "CANVAS", "VIDEO", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "A", "TABLE", "IFRAME"]);
  const hasVisualStyle = (el) => {
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const hasBg = bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
    const hasBorder = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
    const hasShadow = cs.boxShadow && cs.boxShadow !== "none";
    return hasBg || hasBorder || hasShadow || cs.backgroundImage !== "none";
  };

  let order = 0;
  const visit = (el, depth) => {
    if (!(el instanceof Element) || !isVisible(el)) return;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) return;

    const m = matchRule(el);
    if (m) {
      const b = box(el);
      out.components.push({
        id: "c" + ++order,
        component: m.rule.name,
        storybookId: m.rule.storybookId,
        figma: m.rule.figma,
        matchedVia: m.via,
        box: b,
        props: resolveProps(m.rule, el, m.react),
        codeProps: m.react ? primitiveProps(m.react.props) : {},
        state: stateOf(el),
        texts: textLayers(el),
        depth,
        selector: cssPath(el),
      });
      return; // the Figma instance owns everything inside it
    }

    const t = ownText(el);
    if (t) {
      const cs = getComputedStyle(el);
      out.texts.push({
        id: "t" + ++order,
        text: t,
        box: textBox(el),
        tag: el.tagName.toLowerCase(),
        font: {
          family: cs.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
          size: parseFloat(cs.fontSize),
          weight: parseInt(cs.fontWeight, 10) || 400,
          lineHeight: cs.lineHeight,
          color: cs.color,
          align: cs.textAlign,
        },
      });
    }

    const b = box(el);
    const reactName = meaningfulName(reactComponentsFor(el));
    const significant = SIGNIFICANT.has(el.tagName.toUpperCase()) || (b.w * b.h >= minArea && hasVisualStyle(el));
    if (significant && el !== document.body && el !== doc) {
      const leafLike = SIGNIFICANT.has(el.tagName.toUpperCase());
      out.unmatched.push({
        id: "u" + ++order,
        tag: el.tagName.toLowerCase(),
        reactComponent: reactName || null,
        role: el.getAttribute("role"),
        box: b,
        text: leafLike ? allText(el).slice(0, 120) : ownText(el).slice(0, 120),
        background: getComputedStyle(el).backgroundColor,
        backgroundImage: getComputedStyle(el).backgroundImage !== "none",
        kind: leafLike ? "element" : "container",
        selector: cssPath(el),
      });
      if (leafLike) return; // don't descend into an unmatched button/img/etc.
    }
    for (const child of el.children) visit(child, depth + 1);
  };

  function cssPath(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 5) {
      let s = n.tagName.toLowerCase();
      const testId = n.getAttribute("data-testid");
      if (testId) {
        parts.unshift(`${s}[data-testid="${testId}"]`);
        break;
      }
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(s);
      n = parent;
    }
    return parts.join(" > ");
  }

  visit(document.body, 0);

  // Styled containers (cards, panels, banners) are kept. If one holds no
  // mapped component it is likely a design-system piece missing from the
  // mapping (e.g. a promo banner): flag it for review instead of silently
  // flattening it. Unstyled containers are just layout and are dropped.
  const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
  out.unmatched = out.unmatched.filter((u) => {
    if (u.kind === "element") return true;
    const styled = u.background !== "rgba(0, 0, 0, 0)" || u.backgroundImage;
    if (!styled) return false;
    const holdsComponent = out.components.some((c) => inside(c.box, u.box));
    const isPageShell = u.box.w >= out.page.width - 2 && u.box.h >= window.innerHeight - 2;
    if (!holdsComponent && !isPageShell) u.kind = "styled-container";
    return true;
  });
  return out;
}

// Describes the element an action targeted, so prototype links can be drawn
// from the right Figma layer.
export function describeTargetInPage(el) {
  const r = el.getBoundingClientRect();
  return {
    box: {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    },
    text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80),
    tag: el.tagName.toLowerCase(),
  };
}
