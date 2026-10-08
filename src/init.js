// `trace init` — installs Trace into a project for every supported AI tool:
// registers the MCP server and drops the Trace playbook where each tool looks
// for agent instructions. Existing config files are merged, never clobbered.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "trace.js");
const read = (p) => fs.readFileSync(p, "utf8");

const TARGETS = {
  cursor: "Cursor",
  claude: "Claude Code",
  vscode: "VS Code (GitHub Copilot)",
  windsurf: "Windsurf",
  codex: "Codex / any AGENTS.md agent",
  desktop: "Claude Desktop",
};

function serverEntry() {
  return { command: process.execPath, args: [BIN, "serve"] };
}

function mergeJson(file, mutate) {
  let data = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(read(file));
    } catch {
      throw new Error(`${file} is not valid JSON. Fix it or remove it, then re-run trace init.`);
    }
  }
  mutate(data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function writeIfChanged(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && read(file) === content) return false;
  fs.writeFileSync(file, content);
  return true;
}

function upsertSection(file, content) {
  const start = "<!-- trace:start -->";
  const end = "<!-- trace:end -->";
  const block = `${start}\n${content.trim()}\n${end}`;
  let existing = fs.existsSync(file) ? read(file) : "";
  if (existing.includes(start)) {
    existing = existing.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block);
  } else {
    existing = (existing ? existing.trimEnd() + "\n\n" : "") + block + "\n";
  }
  fs.writeFileSync(file, existing);
}

// Project-level files only, unless `global` is set: Windsurf, Codex and Claude
// Desktop keep MCP config per machine, so touching it needs an explicit opt-in.
export function init({ cwd = process.cwd(), only, global = false } = {}) {
  const instructions = read(path.join(ROOT, "templates/instructions.md"));
  const want = (t) => !only || only.includes(t);
  const done = [];

  if (want("cursor")) {
    mergeJson(path.join(cwd, ".cursor/mcp.json"), (d) => {
      d.mcpServers ||= {};
      d.mcpServers.trace = serverEntry();
    });
    writeIfChanged(
      path.join(cwd, ".cursor/rules/trace.mdc"),
      `---\ndescription: Trace — turn a coded prototype flow into linked, editable Figma screens (prototype to Figma, design handoff, rebuild in Figma, capture states)\nalwaysApply: false\n---\n\n${instructions}`
    );
    done.push("Cursor: .cursor/mcp.json + .cursor/rules/trace.mdc");
  }

  if (want("claude")) {
    mergeJson(path.join(cwd, ".mcp.json"), (d) => {
      d.mcpServers ||= {};
      d.mcpServers.trace = { type: "stdio", ...serverEntry() };
    });
    writeIfChanged(
      path.join(cwd, ".claude/skills/trace/SKILL.md"),
      `---\nname: trace\ndescription: Trace a coded prototype flow into linked, editable Figma screens built from design-system components, with loading/empty/error states and handoff notes. Use when the user says "trace", wants a prototype rebuilt in Figma, or wants design handoff from a working prototype.\n---\n\n${instructions}`
    );
    done.push("Claude Code: .mcp.json + .claude/skills/trace (use /trace)");
  }

  if (want("vscode")) {
    mergeJson(path.join(cwd, ".vscode/mcp.json"), (d) => {
      d.servers ||= {};
      d.servers.trace = { type: "stdio", ...serverEntry() };
    });
    writeIfChanged(
      path.join(cwd, ".github/prompts/trace.prompt.md"),
      `---\nmode: agent\ndescription: Trace a prototype flow into Figma\n---\n\n${instructions}`
    );
    done.push("VS Code: .vscode/mcp.json + .github/prompts/trace.prompt.md (use /trace in Copilot Chat)");
  }

  if (want("windsurf")) {
    writeIfChanged(path.join(cwd, ".windsurf/workflows/trace.md"), instructions);
    const globalCfg = path.join(os.homedir(), ".codeium/windsurf/mcp_config.json");
    if (global && fs.existsSync(path.dirname(globalCfg))) {
      mergeJson(globalCfg, (d) => {
        d.mcpServers ||= {};
        d.mcpServers.trace = serverEntry();
      });
      done.push(`Windsurf: .windsurf/workflows/trace.md + ${globalCfg}`);
    } else {
      done.push("Windsurf: .windsurf/workflows/trace.md (MCP server not registered — re-run with --global)");
    }
  }

  if (want("codex")) {
    upsertSection(path.join(cwd, "AGENTS.md"), instructions);
    const codexCfg = path.join(os.homedir(), ".codex/config.toml");
    if (global && fs.existsSync(path.dirname(codexCfg))) {
      const cfg = fs.existsSync(codexCfg) ? read(codexCfg) : "";
      if (!cfg.includes("[mcp_servers.trace]")) {
        fs.appendFileSync(
          codexCfg,
          `\n[mcp_servers.trace]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(BIN)}, "serve"]\n`
        );
      }
      done.push(`Codex: AGENTS.md + ${codexCfg}`);
    } else {
      done.push("AGENTS.md: Trace section added (Codex MCP server not registered — re-run with --global)");
    }
  }

  if (want("desktop") && global) {
    const desktopCfg =
      process.platform === "darwin"
        ? path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json")
        : path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "Claude/claude_desktop_config.json");
    if (fs.existsSync(path.dirname(desktopCfg))) {
      mergeJson(desktopCfg, (d) => {
        d.mcpServers ||= {};
        d.mcpServers.trace = { ...serverEntry(), env: { TRACE_MAPPING: path.join(cwd, "trace.mapping.json") } };
      });
      done.push("Claude Desktop: claude_desktop_config.json (restart Claude Desktop)");
    }
  }

  const mapping = path.join(cwd, "trace.mapping.json");
  if (!fs.existsSync(mapping)) {
    fs.copyFileSync(path.join(ROOT, "trace.mapping.example.json"), mapping);
    done.push("trace.mapping.json created from the example. Fill in your Figma component keys.");
  }

  const gi = path.join(cwd, ".gitignore");
  if (fs.existsSync(gi) && !read(gi).split("\n").includes(".trace/")) fs.appendFileSync(gi, "\n.trace/\n");

  return done;
}

export { TARGETS };
