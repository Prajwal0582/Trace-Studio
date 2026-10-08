// Trace Importer — Figma plugin.
// Builds editable, linked Figma screens from a Trace plan.json.
//
// The section between the <trace-builder> markers is also served by the Trace
// MCP server (tool: trace_figma_script) so an AI agent can run the exact same
// build through Figma MCP `use_figma`. Keep it free of plugin-UI code.

// <trace-builder>
async function buildTraceScreens(plan, opts) {
  opts = opts || {};
  const report = { page: plan.page, frames: [], instances: 0, texts: 0, placeholders: 0, links: 0, failures: [] };

  // ---------- helpers ----------
  const parseColor = (css) => {
    const m = String(css || "").match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a] = m[1].split(",").map((v) => parseFloat(v));
    return { color: { r: r / 255, g: g / 255, b: b / 255 }, opacity: a == null || isNaN(a) ? 1 : a };
  };
  const solid = (css, fallback) => {
    const c = parseColor(css);
    if (!c || c.opacity === 0) return fallback || [];
    return [{ type: "SOLID", color: c.color, opacity: c.opacity }];
  };
  const styleFor = (w) => (w >= 700 ? "Bold" : w >= 600 ? "Semi Bold" : w >= 500 ? "Medium" : "Regular");
  const loaded = new Set();
  const loadFont = async (font) => {
    const key = font.family + "/" + font.style;
    if (loaded.has(key)) return font;
    await figma.loadFontAsync(font);
    loaded.add(key);
    return font;
  };
  const resolveFont = async (family, weight) => {
    const tries = [
      { family, style: styleFor(weight) },
      { family, style: "Regular" },
      { family: "Inter", style: styleFor(weight) },
      { family: "Inter", style: "Regular" },
    ];
    for (const f of tries) {
      try {
        return await loadFont(f);
      } catch (e) {
        /* try next */
      }
    }
    throw new Error("No usable font");
  };
  const componentCache = new Map();
  const getComponent = async (n) => {
    const cacheKey = n.componentKey || n.componentSetKey || n.nodeId;
    if (componentCache.has(cacheKey)) return componentCache.get(cacheKey);
    let comp = null;
    if (n.componentKey) {
      try {
        comp = await figma.importComponentByKeyAsync(n.componentKey);
      } catch (e) {
        try {
          const set = await figma.importComponentSetByKeyAsync(n.componentKey);
          comp = set.defaultVariant;
        } catch (e2) {
          /* fall through */
        }
      }
    }
    if (!comp && n.componentSetKey) {
      try {
        comp = (await figma.importComponentSetByKeyAsync(n.componentSetKey)).defaultVariant;
      } catch (e) {
        /* fall through */
      }
    }
    if (!comp && n.nodeId) {
      const node = await figma.getNodeByIdAsync(n.nodeId);
      if (node && node.type === "COMPONENT") comp = node;
      if (node && node.type === "COMPONENT_SET") comp = node.defaultVariant;
    }
    componentCache.set(cacheKey, comp);
    return comp;
  };
  const applyProps = (inst, props) => {
    const defs = inst.componentProperties || {};
    const applied = new Set();
    for (const [k, v] of Object.entries(props || {})) {
      const key = Object.keys(defs).find((d) => d === k || d.split("#")[0].toLowerCase() === k.toLowerCase());
      if (!key) continue;
      try {
        const type = defs[key].type;
        const value = type === "BOOLEAN" ? v === true || v === "true" : String(v);
        inst.setProperties({ [key]: value });
        applied.add(type);
      } catch (e) {
        report.failures.push(`${inst.name}: property ${k}=${v} (${e.message})`);
      }
    }
    return applied;
  };
  const overrideTexts = async (inst, texts) => {
    if (!texts || !texts.length) return;
    const layers = inst.findAll((n) => n.type === "TEXT" && n.visible);
    for (let i = 0; i < Math.min(layers.length, texts.length); i++) {
      const t = layers[i];
      try {
        const fonts = t.characters.length ? t.getRangeAllFontNames(0, t.characters.length) : [t.fontName];
        for (const f of fonts) await loadFont(f);
        t.characters = texts[i];
      } catch (e) {
        report.failures.push(`${inst.name}: text override (${e.message})`);
      }
    }
  };
  const label = async (parent, text, x, y, size, color) => {
    const t = figma.createText();
    t.fontName = await resolveFont("Inter", 500);
    t.fontSize = size;
    t.characters = text;
    t.fills = [{ type: "SOLID", color }];
    t.x = x;
    t.y = y;
    parent.appendChild(t);
    return t;
  };

  // Shared plugin data isn't available in every runtime (e.g. Figma MCP
  // use_figma), so tags degrade gracefully and lookups fall back to names.
  const tag = (node, key, value) => {
    try {
      node.setSharedPluginData("trace", key, value);
    } catch (e) {
      /* unsupported here */
    }
  };
  const readTag = (node, key) => {
    try {
      return node.getSharedPluginData("trace", key);
    } catch (e) {
      return "";
    }
  };

  // ---------- page ----------
  let page = figma.root.children.find((p) => p.name === plan.page);
  if (!page) {
    page = figma.createPage();
    page.name = plan.page;
  }
  await figma.setCurrentPageAsync(page);

  const frameById = new Map();
  const nodeByRef = new Map();
  for (const f of page.children) {
    const sid = readTag(f, "screenId") || (plan.screens.find((s) => s.frameName === f.name) || {}).id;
    if (sid) frameById.set(sid, f);
  }

  // ---------- screens ----------
  for (const s of plan.screens) {
    const old = frameById.get(s.id);
    if (old) old.remove(); // rebuilding a screen replaces it
    const frame = figma.createFrame();
    frame.name = s.frameName;
    frame.resize(Math.max(1, s.width), Math.max(1, s.height));
    frame.x = s.x;
    frame.y = s.y;
    frame.fills = solid(s.background, [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]);
    frame.clipsContent = true;
    tag(frame, "screenId", s.id);
    tag(frame, "url", s.url || "");
    page.appendChild(frame);
    frameById.set(s.id, frame);

    const order = { rect: 0, instance: 1, text: 2, placeholder: 3 };
    const nodes = [...s.nodes].sort((a, b) => order[a.type] - order[b.type]);
    for (const n of nodes) {
      try {
        let node = null;
        if (n.type === "rect") {
          node = figma.createRectangle();
          node.resize(Math.max(1, n.w), Math.max(1, n.h));
          node.fills = solid(n.fill);
        } else if (n.type === "instance") {
          const comp = await getComponent(n);
          if (!comp) {
            n.type = "placeholder";
            n.reason = `Could not import Figma component for ${n.component}`;
          } else {
            node = comp.createInstance();
            const applied = applyProps(node, n.props);
            if (!applied.has("TEXT")) await overrideTexts(node, n.texts);
            try {
              if (Math.abs(node.width - n.w) > 2 || Math.abs(node.height - n.h) > 2) node.resize(Math.max(1, n.w), Math.max(1, n.h));
            } catch (e) {
              /* fixed-size component – keep its native size */
            }
            tag(node, "storybookId", n.storybookId || "");
            report.instances++;
          }
        } else if (n.type === "text") {
          node = figma.createText();
          node.fontName = await resolveFont(n.font.family, n.font.weight);
          node.fontSize = Math.max(1, n.font.size || 14);
          node.characters = n.text;
          node.fills = solid(n.font.color, [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }]);
          node.textAlignHorizontal = { center: "CENTER", right: "RIGHT", end: "RIGHT" }[n.font.align] || "LEFT";
          // Single-line text stays single-line (browser and Figma fonts differ
          // slightly in width); only multi-line text gets a fixed wrap width.
          const lh = parseFloat(n.font.lineHeight) || (n.font.size || 14) * 1.5;
          if (n.h <= lh * 1.5) node.textAutoResize = "WIDTH_AND_HEIGHT";
          else {
            node.textAutoResize = "HEIGHT";
            node.resize(Math.max(1, n.w + 2), node.height);
          }
          report.texts++;
        }
        if (n.type === "placeholder") {
          node = figma.createFrame();
          node.resize(Math.max(8, n.w), Math.max(8, n.h));
          node.fills = [{ type: "SOLID", color: { r: 1, g: 0.23, b: 0.19 }, opacity: 0.08 }];
          node.strokes = [{ type: "SOLID", color: { r: 1, g: 0.23, b: 0.19 } }];
          node.dashPattern = [6, 4];
          node.strokeWeight = 1;
          node.clipsContent = false;
          // Label sits just above the box so it never covers the content it flags.
          await label(node, "⚠ " + (n.component || n.layerName.replace(/^⚠\s*/, "")), 0, -14, 10, { r: 0.8, g: 0.1, b: 0.1 });
          tag(node, "review", n.reason || "unmatched");
          report.placeholders++;
        }
        if (!node) continue;
        node.name = n.type === "placeholder" ? (n.layerName.startsWith("⚠") ? n.layerName : "⚠ " + n.layerName) : n.layerName;
        frame.appendChild(node);
        node.x = n.x;
        node.y = n.y;
        nodeByRef.set(s.id + ":" + n.ref, node);
      } catch (e) {
        report.failures.push(`${s.frameName} / ${n.layerName}: ${e.message}`);
      }
    }

    // Handoff notes panel, to the right of the frame.
    if (opts.notes !== false && s.notes && s.notes.length) {
      const panel = figma.createFrame();
      panel.name = "Handoff notes — " + s.frameName;
      panel.layoutMode = "VERTICAL";
      panel.itemSpacing = 8;
      panel.paddingTop = panel.paddingBottom = panel.paddingLeft = panel.paddingRight = 16;
      panel.primaryAxisSizingMode = "AUTO";
      panel.counterAxisSizingMode = "FIXED";
      panel.resize(360, 100);
      panel.cornerRadius = 8;
      panel.fills = [{ type: "SOLID", color: { r: 1, g: 0.97, b: 0.84 } }];
      panel.x = s.x + s.width + 40;
      panel.y = s.y;
      tag(panel, "notesFor", s.id);
      const title = await label(panel, "📝 " + s.frameName, 0, 0, 14, { r: 0.2, g: 0.16, b: 0 });
      title.layoutSizingHorizontal = "FILL";
      for (const line of s.notes) {
        const t = await label(panel, "• " + line, 0, 0, 12, { r: 0.25, g: 0.2, b: 0.05 });
        t.layoutSizingHorizontal = "FILL";
        t.textAutoResize = "HEIGHT";
      }
      for (const old of page.children.filter((c) => c !== panel && (readTag(c, "notesFor") === s.id || c.name === panel.name))) old.remove();
      page.appendChild(panel);
    }
    report.frames.push({ id: frame.id, screenId: s.id, name: frame.name });
  }

  // ---------- prototype links ----------
  for (const l of plan.links || []) {
    const from = frameById.get(l.from);
    const to = frameById.get(l.to);
    if (!from || !to) continue;
    const src = (l.sourceRef && nodeByRef.get(l.from + ":" + l.sourceRef)) || from;
    try {
      const existing = (src.reactions || []).filter(
        (r) => !(r.actions || []).some((a) => a.destinationId === to.id)
      );
      await src.setReactionsAsync([
        ...existing,
        {
          trigger: { type: "ON_CLICK" },
          actions: [
            {
              type: "NODE",
              destinationId: to.id,
              navigation: "NAVIGATE",
              transition: { type: "DISSOLVE", easing: { type: "EASE_OUT" }, duration: 0.25 },
              preserveScrollPosition: false,
            },
          ],
        },
      ]);
      report.links++;
    } catch (e) {
      report.failures.push(`link ${l.from}→${l.to}: ${e.message}`);
    }
  }
  if (plan.screens.length) {
    const first = frameById.get(plan.screens[0].id);
    if (first && !page.flowStartingPoints.some((f) => f.nodeId === first.id) && plan.screens[0].id === "s1") {
      page.flowStartingPoints = [...page.flowStartingPoints, { nodeId: first.id, name: plan.flowName }];
    }
    const built = plan.screens.map((s) => frameById.get(s.id)).filter(Boolean);
    try {
      if (built.length) figma.viewport.scrollAndZoomIntoView(built);
    } catch (e) {
      /* no viewport in headless runtimes */
    }
  }
  return report;
}
// </trace-builder>

// ---------- plugin glue ----------
if (typeof __html__ !== "undefined") {
  figma.showUI(__html__, { width: 420, height: 520 });
  figma.ui.onmessage = async (msg) => {
    if (msg.type !== "build") return;
    try {
      const plan = JSON.parse(msg.plan);
      const report = await buildTraceScreens(plan, { notes: msg.notes });
      figma.ui.postMessage({ type: "done", report });
      figma.notify(`Trace: ${report.frames.length} screens, ${report.instances} instances, ${report.placeholders} to review`);
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: e.message });
    }
  };
}
