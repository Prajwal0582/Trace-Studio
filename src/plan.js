// Turns captured screens into a Figma build plan: frames, library-component
// instances with variant props and text overrides, loose text, placeholders for
// anything unmatched, prototype links between frames, and handoff notes.
//
// The plan is tool-agnostic JSON. It is consumed either by the host AI agent
// through Figma MCP (use_figma), or by the bundled Trace Importer Figma plugin.
import fs from "node:fs";
import path from "node:path";

const GAP_X = 480; // room for the handoff-notes panel beside each frame
const GAP_Y = 240;

export function buildPlan(session) {
  const screens = session.screens;
  const review = [];

  // Layout: one column per screen name (the happy path reads left -> right),
  // its alternate states (loading / empty / error ...) stacked underneath.
  const columns = [];
  for (const s of screens) {
    let col = columns.find((c) => c.name === s.name);
    if (!col) columns.push((col = { name: s.name, screens: [] }));
    col.screens.push(s);
  }
  const position = new Map();
  let x = 0;
  for (const col of columns) {
    let y = 0;
    const width = Math.max(...col.screens.map((s) => s.size.w));
    for (const s of col.screens) {
      position.set(s.id, { x, y });
      y += s.size.h + GAP_Y;
    }
    x += width + GAP_X;
  }

  const planScreens = screens.map((s) => {
    const nodes = [];
    for (const c of s.components) {
      const hasFigma = c.figma && (c.figma.componentKey || c.figma.nodeId);
      if (!hasFigma) {
        const existing = review.find((r) => r.screen === s.id && r.kind === "mapping-missing-figma" && r.component === c.component);
        if (existing) existing.count++;
        else review.push({ screen: s.id, severity: "warn", kind: "mapping-missing-figma", component: c.component, count: 1 });
      }
      nodes.push({
        ref: c.id,
        type: hasFigma ? "instance" : "placeholder",
        layerName: c.component,
        component: c.component,
        storybookId: c.storybookId,
        componentKey: c.figma?.componentKey || null,
        componentSetKey: c.figma?.componentSetKey || null,
        nodeId: c.figma?.nodeId || null,
        fileKey: c.figma?.fileKey || null,
        props: c.props,
        state: c.state,
        texts: c.texts,
        ...c.box,
        reason: hasFigma ? undefined : "No Figma component linked for this mapping entry",
      });
    }
    for (const t of s.texts) {
      nodes.push({ ref: t.id, type: "text", layerName: t.text.slice(0, 40), text: t.text, font: t.font, ...t.box });
    }
    for (const u of s.unmatched) {
      if (u.kind === "container" || u.kind === "styled-container") {
        if (u.kind === "styled-container") {
          review.push({
            screen: s.id,
            severity: "review",
            kind: "unmatched",
            ref: u.id,
            message: `Styled ${u.reactComponent || "<" + u.tag + ">"}${u.text ? ` "${u.text.slice(0, 40)}"` : ""} at ${u.box.x},${u.box.y} matches no component (banner/panel?). Add a mapping or rebuild manually.`,
          });
          nodes.unshift({ ref: u.id, type: "placeholder", layerName: `⚠ ${u.reactComponent || u.tag}`, ...u.box, reason: "Styled container with no mapped component" });
          continue;
        }
        nodes.unshift({ ref: u.id, type: "rect", layerName: u.reactComponent || u.tag, fill: u.background, ...u.box });
        continue;
      }
      nodes.push({
        ref: u.id,
        type: "placeholder",
        layerName: `⚠ ${u.reactComponent || u.tag}`,
        text: u.text,
        ...u.box,
        reason: `Unmatched <${u.tag}>${u.reactComponent ? ` (React: ${u.reactComponent})` : ""} — no mapping entry`,
      });
      review.push({
        screen: s.id,
        severity: "review",
        kind: "unmatched",
        ref: u.id,
        message: `Unmatched ${u.reactComponent || "<" + u.tag + ">"}${u.text ? ` "${u.text.slice(0, 40)}"` : ""} at ${u.box.x},${u.box.y}. Add a mapping or rebuild manually.`,
      });
    }
    for (const err of s.consoleErrors || []) {
      review.push({ screen: s.id, severity: "info", kind: "console-error", message: err.slice(0, 200) });
    }
    const pos = position.get(s.id);
    return {
      id: s.id,
      frameName: `${String(s.index).padStart(2, "0")} ${s.name}${s.state && s.state !== "default" ? ` — ${s.state}` : ""}`,
      name: s.name,
      state: s.state,
      url: s.url,
      x: pos.x,
      y: pos.y,
      width: s.size.w,
      height: s.size.h,
      background: s.background,
      screenshot: path.join(session.dir, s.screenshot),
      nodes,
      notes: [],
    };
  });

  for (const r of review.filter((r) => r.kind === "mapping-missing-figma")) {
    r.message = `"${r.component}"${r.count > 1 ? ` (×${r.count})` : ""} is mapped but has no Figma componentKey/nodeId in trace.mapping.json.`;
  }

  // Prototype links: actions recorded before screen N were performed on the
  // screen captured just before it. Attach the link to the smallest node that
  // contains the click target.
  const links = [];
  for (let i = 1; i < screens.length; i++) {
    const to = planScreens[i];
    const from = planScreens.find((p) => p.id === screens[i].fromScreen) || planScreens[i - 1];
    for (const a of screens[i].arrivedVia) {
      let sourceRef = null;
      if (a.target?.box) {
        const cx = a.target.box.x + a.target.box.w / 2;
        const cy = a.target.box.y + a.target.box.h / 2;
        const hits = from.nodes
          .filter((n) => n.type !== "rect" && cx >= n.x && cx <= n.x + n.w && cy >= n.y && cy <= n.y + n.h)
          .sort((p, q) => p.w * p.h - q.w * q.h);
        sourceRef = hits[0]?.ref || null;
      }
      links.push({
        from: from.id,
        to: to.id,
        sourceRef,
        trigger: a.type === "press" ? "ON_KEY_DOWN" : "ON_CLICK",
        label: a.target?.text || a.selector || a.url || a.type,
        action: a.type,
      });
    }
  }

  // Handoff notes per screen.
  for (const ps of planScreens) {
    const s = screens.find((x) => x.id === ps.id);
    const notes = ps.notes;
    notes.push(`Route: ${new URL(s.url).pathname}${new URL(s.url).search}`);
    if (s.state && s.state !== "default") {
      const how = s.activeMocks.length
        ? s.activeMocks
            .map((m) => (m.hang ? `${m.urlPattern} never resolves` : `${m.urlPattern} → HTTP ${m.status}${m.delayMs ? ` after ${m.delayMs}ms` : ""}`))
            .join("; ")
        : "reached through interaction";
      notes.push(`State "${s.state}": ${how}.`);
    }
    if (s.notes) notes.push(s.notes);
    for (const l of links.filter((l) => l.from === ps.id)) {
      const target = planScreens.find((p) => p.id === l.to);
      notes.push(`${l.action === "press" ? "Pressing" : "Clicking"} "${l.label}" → ${target.frameName}`);
    }
    const flagged = s.components.filter((c) => Object.keys(c.state).length);
    for (const c of flagged) {
      notes.push(`${c.component} "${(c.texts[0] || "").slice(0, 30)}" is ${Object.keys(c.state).join(", ")}`);
    }
    const used = [...new Set(s.components.map((c) => c.component + (c.storybookId ? ` (${c.storybookId})` : "")))];
    if (used.length) notes.push(`Components: ${used.join(", ")}`);
    const issues = review.filter((r) => r.screen === ps.id && r.severity !== "info").length;
    if (issues) notes.push(`⚠ ${issues} item(s) need designer review before handoff.`);
  }

  // Flow-level coverage hints: which common states were never captured.
  const statesByName = new Map();
  for (const s of screens) {
    if (!statesByName.has(s.name)) statesByName.set(s.name, new Set());
    statesByName.get(s.name).add(s.state);
  }
  const coverage = [...statesByName].map(([name, states]) => ({
    screen: name,
    captured: [...states],
    missing: ["loading", "empty", "error"].filter((st) => ![...states].some((x) => x.includes(st))),
  }));

  const totalComponents = screens.reduce((n, s) => n + s.components.length, 0);
  const totalUnmatched = screens.reduce((n, s) => n + s.unmatched.filter((u) => u.kind !== "container").length, 0);

  return {
    tool: "trace",
    version: 1,
    flowName: session.flowName,
    generatedAt: new Date().toISOString(),
    sessionDir: session.dir,
    figmaFileKey: session.figmaFileKey || null,
    page: `Trace / ${session.flowName}`,
    stats: {
      screens: screens.length,
      componentInstances: totalComponents,
      unmatched: totalUnmatched,
      matchRate: totalComponents + totalUnmatched ? +(totalComponents / (totalComponents + totalUnmatched)).toFixed(2) : 0,
    },
    screens: planScreens,
    links,
    coverage,
    review,
  };
}

export function writeHandoff(plan) {
  const lines = [];
  lines.push(`# ${plan.flowName} — Trace handoff`);
  lines.push("");
  lines.push(`Generated ${plan.generatedAt}. ${plan.stats.screens} screens, ${plan.stats.componentInstances} library instances, ${plan.stats.unmatched} unmatched (match rate ${Math.round(plan.stats.matchRate * 100)}%).`);
  lines.push("");
  lines.push("> Designer review required: check every ⚠ item below before sharing with developers.");
  lines.push("");
  for (const s of plan.screens) {
    lines.push(`## ${s.frameName}`);
    lines.push("");
    lines.push(`![${s.frameName}](${path.relative(plan.sessionDir, s.screenshot)})`);
    lines.push("");
    for (const n of s.notes) lines.push(`- ${n}`);
    const flags = plan.review.filter((r) => r.screen === s.id);
    if (flags.length) {
      lines.push("");
      lines.push("**Review**");
      for (const f of flags) lines.push(`- [ ] (${f.severity}) ${f.message}`);
    }
    lines.push("");
  }
  const gaps = plan.coverage.filter((c) => c.missing.length);
  if (gaps.length) {
    lines.push("## State coverage gaps");
    lines.push("");
    for (const g of gaps) lines.push(`- **${g.screen}**: no ${g.missing.join(" / ")} state captured (may not apply).`);
    lines.push("");
  }
  const md = lines.join("\n");
  fs.writeFileSync(path.join(plan.sessionDir, "handoff.md"), md);
  fs.writeFileSync(path.join(plan.sessionDir, "plan.json"), JSON.stringify(plan, null, 2));
  return md;
}
