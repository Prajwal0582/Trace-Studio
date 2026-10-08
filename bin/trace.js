#!/usr/bin/env node
// Trace CLI
//   trace init [--only cursor,claude,vscode,windsurf,codex,desktop]
//   trace serve                      (MCP server over stdio — AI tools launch this)
//   trace storybook <url>            (scaffold mapping entries from a Storybook)
//   trace doctor                     (check the install)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const HELP = `
  ▲ Trace — prototype → Figma handoff agent

  Usage
    trace init                 Connect Trace to Cursor, Claude Code, VS Code, Windsurf,
                               Codex and Claude Desktop in this project
      --only cursor,claude     Limit to some tools
      --global                 Also register in per-machine configs
                               (Windsurf, Codex, Claude Desktop)
    trace storybook <url>      Add mapping entries for every component in a Storybook
    trace studio [folder]      Open Trace Studio (start projects, review runs, exports)
    trace doctor               Check browser, mapping and AI-tool setup
    trace serve                Run the MCP server (your AI tool starts this for you)

  Then, in your AI tool, ask:
    "Trace the checkout flow at http://localhost:5173 into Figma <file url>"
`;

async function main() {
  switch (cmd) {
    case "serve": {
      const { startServer } = await import("../src/server.js");
      await startServer({ cwd: process.cwd() });
      break;
    }
    case "init": {
      const { init } = await import("../src/init.js");
      const only = flag("only")?.split(",").map((s) => s.trim());
      const done = init({ cwd: process.cwd(), only, global: rest.includes("--global") });
      console.log("\n  ▲ Trace installed\n");
      for (const d of done) console.log("  ✓ " + d);
      console.log(`
  Next
    1. Fill Figma component keys into trace.mapping.json
       (or let the agent find them with Figma MCP → it will ask before writing)
    2. Make sure the Figma MCP server is connected in your AI tool
    3. Reload your AI tool, then ask:
       "Trace the <flow> at <prototype url> into Figma <file url>"
`);
      break;
    }
    case "storybook": {
      const url = rest[0];
      if (!url) throw new Error("Usage: trace storybook <storybook url>");
      const { scaffoldFromStorybook, findMappingFile } = await import("../src/mapping.js");
      const file = findMappingFile() || path.join(process.cwd(), "trace.mapping.json");
      const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { figmaFileKey: "", components: [] };
      const found = await scaffoldFromStorybook(url);
      let added = 0;
      for (const c of found) {
        if (data.components.some((x) => x.name === c.name)) continue;
        const { stories, ...entry } = c;
        data.components.push(entry);
        added++;
      }
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
      console.log(`  ✓ ${found.length} components in Storybook, ${added} new entries → ${file}`);
      console.log("  Fill figma.componentKey for each (Figma: right-click component → Copy link, or ask your agent).");
      break;
    }
    case "studio": {
      // trace studio [.trace folder | run folder] — opens Trace Studio. Designers
      // start new projects from there; past runs and exports are listed too.
      const { TRACE_HOME } = await import("../src/home.js");
      const target = path.resolve(rest[0] || TRACE_HOME);
      const isRun = fs.existsSync(path.join(target, "run.json"));
      const root = isRun ? path.dirname(target) : target;
      const { startStudio } = await import("../src/studio-server.js");
      const { url } = await startStudio({ root });
      const open = isRun ? `${url}/#/run/${encodeURIComponent(path.basename(target))}/flow` : url;
      console.log(`  ▲ Trace Studio → ${open}`);
      break;
    }
    case "doctor": {
      const ok = (b, m) => console.log(`  ${b ? "✓" : "✗"} ${m}`);
      const { chromium } = await import("playwright");
      let browser = false;
      try {
        const b = await chromium.launch();
        await b.close();
        browser = true;
      } catch {}
      ok(browser, browser ? "Chromium available" : "Chromium missing. Run: npx playwright install chromium");
      const { loadMapping } = await import("../src/mapping.js");
      const m = loadMapping();
      ok(!!m.file, m.file ? `Mapping: ${m.file} (${m.components.length} components)` : "No trace.mapping.json here. Run: trace init");
      const missing = m.components.filter((c) => !c.figma.componentKey && !c.figma.nodeId).map((c) => c.name);
      if (m.file) ok(!missing.length, missing.length ? `No Figma key yet: ${missing.join(", ")}` : "Every mapping entry has a Figma key");
      const cwd = process.cwd();
      for (const [f, label] of [
        [".cursor/mcp.json", "Cursor"],
        [".mcp.json", "Claude Code"],
        [".vscode/mcp.json", "VS Code"],
        ["AGENTS.md", "AGENTS.md agents"],
      ]) {
        const p = path.join(cwd, f);
        ok(fs.existsSync(p) && fs.readFileSync(p, "utf8").includes("trace"), `${label} (${f})`);
      }
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error("  ✗ " + e.message);
  process.exit(1);
});
