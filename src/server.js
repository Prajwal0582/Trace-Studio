// Trace MCP server. Speaks MCP over stdio, so any MCP-capable AI tool
// (Cursor, Claude Code, Claude Desktop, VS Code Copilot, Windsurf, Codex, …)
// can drive it. The host's own model is the agent: Trace supplies the tools
// and the playbook (templates/instructions.md).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TraceSession } from "./session.js";
import { buildPlan, writeHandoff } from "./plan.js";
import { findMappingFile } from "./mapping.js";
import { Run } from "./run.js";
import { ProjectStore } from "./projects.js";
import { designSystem, FRAME } from "./design-systems.js";
import { TRACE_HOME } from "./home.js";
import { startStudio } from "./studio-server.js";
import { prepareBuild, batchCode, libraryIdFor } from "./build-run.js";
import { loadLibrary, installScript } from "./figma-build.js";
import { exec } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTRUCTIONS = fs.readFileSync(path.join(ROOT, "templates/instructions.md"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });

function builderSource() {
  const src = fs.readFileSync(path.join(ROOT, "figma-plugin/code.js"), "utf8");
  const m = src.match(/\/\/ <trace-builder>([\s\S]*?)\/\/ <\/trace-builder>/);
  if (!m) throw new Error("Builder section not found in figma-plugin/code.js");
  return m[1].trim();
}

export async function startServer({ cwd = process.cwd() } = {}) {
  const outDir = TRACE_HOME;
  const sessions = new Map();
  let current = null;
  let lastPlan = null;

  const get = (id) => {
    const s = id ? sessions.get(id) : current;
    if (!s) throw new Error("No active Trace session. Call trace_start first.");
    s.run?.sync();
    return s;
  };
  const guard = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(`Trace error: ${e.message}`);
    }
  };

  const projects = new ProjectStore(outDir);

  // Heartbeat: tells Trace Studio an AI tool is connected (and what it's on).
  fs.mkdirSync(outDir, { recursive: true });
  const engineFile = path.join(outDir, "engine.json");
  const engine = { pid: process.pid, startedAt: new Date().toISOString(), client: null, working: null, listening: false };
  const beat = () => {
    try {
      fs.writeFileSync(engineFile, JSON.stringify({ ...engine, lastSeen: new Date().toISOString() }));
    } catch {
      /* folder removed — ignore */
    }
  };
  beat();
  const beatTimer = setInterval(beat, 5000);
  beatTimer.unref();
  const working = (what) => {
    engine.working = what;
    beat();
  };
  process.on("exit", () => {
    try {
      const cur = JSON.parse(fs.readFileSync(engineFile, "utf8"));
      if (cur.pid === process.pid) fs.unlinkSync(engineFile);
    } catch {
      /* already gone */
    }
  });
  const server = new McpServer({ name: "trace", version: pkg.version }, { instructions: INSTRUCTIONS });
  // Record the last thing the AI did, so Studio can show it's working (trace_wait is listening, not working).
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, def, handler) =>
    registerTool(name, def, async (...args) => {
      if (name !== "trace_wait") {
        engine.lastTool = name;
        engine.lastActive = new Date().toISOString();
        beat();
      }
      return handler(...args);
    });

  // ---------------------------------------------------------------- prompts
  server.registerPrompt(
    "trace",
    {
      title: "Trace a prototype flow into Figma",
      description: "Walk a coded prototype and rebuild the flow as linked, editable Figma screens.",
      argsSchema: {
        url: z.string().optional().describe("Prototype URL"),
        flow: z.string().optional().describe("The flow to trace, in plain language"),
        figma: z.string().optional().describe("Destination Figma file URL"),
      },
    },
    ({ url, flow, figma }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              INSTRUCTIONS +
              "\n\n---\n\nStart Trace now." +
              (url ? `\nPrototype: ${url}` : "") +
              (flow ? `\nFlow: ${flow}` : "") +
              (figma ? `\nFigma destination: ${figma}` : ""),
          },
        },
      ],
    })
  );

  // ---------------------------------------------------------------- session
  server.registerTool(
    "trace_start",
    {
      title: "Start a Trace session",
      description: "Open the prototype in a browser and start recording a flow. Returns the session id.",
      inputSchema: {
        url: z.string().describe("Prototype URL, e.g. http://localhost:5173/campaigns"),
        flowName: z.string().describe("Short name for the flow, e.g. 'Create campaign'"),
        width: z.number().int().optional().describe("Viewport width (default 1496, the Figma frame width)"),
        height: z.number().int().optional().describe("Viewport height (default 1024)"),
        headless: z.boolean().optional().describe("Run the browser hidden (default true). Set false to watch."),
        mappingFile: z.string().optional().describe("Path to trace.mapping.json (auto-detected by default)"),
        source: z.string().optional().describe("Where the prototype came from (repo URL or folder) — shown in Trace Studio"),
        library: z.string().optional().describe("Target Figma library name, e.g. 'V1 · Genie Material Design'"),
        scenario: z.string().optional().describe("Prototype scenario / user state being traced"),
        projectId: z.string().optional().describe("Studio project this flow belongs to (from trace_project_next)"),
        flowId: z.string().optional().describe("The picked flow being traced (from trace_project_next)"),
      },
    },
    guard(async ({ url, flowName, width = FRAME.w, height = FRAME.h, headless, mappingFile, source, library, scenario, projectId, flowId }) => {
      const s = new TraceSession({
        flowName,
        url,
        viewport: { width, height },
        outDir,
        mappingFile: mappingFile ? path.resolve(cwd, mappingFile) : findMappingFile(cwd),
        headless: headless ?? process.env.TRACE_HEADLESS !== "false",
      });
      await s.start();
      let figma = {};
      if (projectId) {
        const proj = projects.get(projectId);
        library ||= designSystem(proj.designSystem)?.name;
        source ||= proj.repo.url;
        figma = { fileUrl: proj.figma.fileUrl, fileKey: proj.figma.fileKey };
        if (flowId) {
          const f = proj.flows.find((x) => x.id === flowId);
          scenario ||= f?.scenario || undefined;
          projects.update(projectId, { flows: [{ id: flowId, runId: s.id }], log: `Tracing "${f?.name || flowName}"` });
        }
      }
      s.run = new Run(s.dir, { project: { flowName, source: source || url, library, scenario, url, projectId: projectId || null, flowId: flowId || null } });
      if (figma.fileUrl) s.run.data.figma = figma;
      s.run.log(`Opened ${url}`);
      s.run.save();
      sessions.set(s.id, s);
      current = s;
      return text({
        sessionId: s.id,
        outputDir: s.dir,
        mappingFile: s.mapping.file || "⚠ none found — create trace.mapping.json (run `trace init`) or every element will be unmatched",
        mappingEntries: s.mapping.components.length,
        next: "Call trace_inspect to check mapping coverage on this screen.",
      });
    })
  );

  server.registerTool(
    "trace_act",
    {
      title: "Interact with the prototype",
      description:
        "Perform one browser action. Target elements by role+name (preferred), visible text, or CSS selector. Clicks/presses between captures become Figma prototype links.",
      inputSchema: {
        action: z.enum(["click", "fill", "hover", "select", "check", "press", "scroll", "wait", "goto", "back", "reload"]),
        role: z.string().optional().describe("ARIA role, e.g. button, link, textbox, tab"),
        name: z.string().optional().describe("Accessible name for role"),
        text: z.string().optional().describe("Visible text"),
        selector: z.string().optional().describe("CSS selector"),
        value: z.string().optional().describe("Value for fill/select, pixels for scroll"),
        url: z.string().optional().describe("For goto (absolute or relative)"),
        key: z.string().optional().describe("For press, e.g. Enter, Escape"),
        ms: z.number().optional().describe("For wait"),
        sessionId: z.string().optional(),
      },
    },
    guard(async ({ sessionId, ...a }) => {
      const s = get(sessionId);
      const entry = await s.act(a);
      return text({ ok: true, did: `${entry.type} ${entry.target?.text || entry.selector || entry.url || ""}`.trim(), url: entry.pageUrl });
    })
  );

  server.registerTool(
    "trace_mock_network",
    {
      title: "Mock a network response to force a UI state",
      description:
        "Intercept requests matching urlPattern (glob, e.g. '**/api/campaigns*'). Use hang:true for loading, an empty body for empty states, status 500/4xx for errors. Then reload or repeat the action.",
      inputSchema: {
        urlPattern: z.string(),
        status: z.number().int().optional(),
        body: z.any().optional().describe("JSON value or string"),
        delayMs: z.number().int().optional(),
        hang: z.boolean().optional().describe("Never respond, keeping the loading state on screen"),
        contentType: z.string().optional(),
        sessionId: z.string().optional(),
      },
    },
    guard(async ({ sessionId, ...m }) => {
      const s = get(sessionId);
      await s.mock(m);
      return text({ ok: true, active: s.mocks.filter((x) => x.active).map((x) => x.urlPattern), next: "Reload or repeat the triggering action, then trace_capture." });
    })
  );

  server.registerTool(
    "trace_clear_mocks",
    {
      title: "Remove all network mocks",
      description: "Restore real network responses.",
      inputSchema: { sessionId: z.string().optional() },
    },
    guard(async ({ sessionId }) => {
      await get(sessionId).clearMocks();
      return text({ ok: true });
    })
  );

  server.registerTool(
    "trace_inspect",
    {
      title: "Inspect the current screen",
      description:
        "Dry run of component recognition on the current page without saving: matched components, unmatched elements (with React component names), and API endpoints seen so far.",
      inputSchema: { sessionId: z.string().optional() },
    },
    guard(async ({ sessionId }) => text(await get(sessionId).inspect()))
  );

  server.registerTool(
    "trace_capture",
    {
      title: "Capture the current screen",
      description:
        "Screenshot the page and record its component structure as one Figma screen. Use the same name for different states of one screen.",
      inputSchema: {
        name: z.string().describe("Screen name, e.g. 'Campaign list'"),
        state: z.string().optional().describe("default | loading | empty | error | validation error | …"),
        notes: z.string().optional().describe("Extra handoff note for developers"),
        fullPage: z.boolean().optional().describe("Capture the full scroll height (default true)"),
        fromScreen: z
          .string()
          .optional()
          .describe("Id of the screen the triggering click happened on (default: the previous capture). Set it after capturing alternate states, e.g. 's1'."),
        sessionId: z.string().optional(),
      },
    },
    guard(async ({ sessionId, name, state, notes, fullPage, fromScreen }) => {
      const s = get(sessionId);
      const prev = s.screens.at(-1);
      const { screen, shotPath } = await s.capture({ name, state, notes, fullPage, fromScreen });
      s.run?.addScreen({
        id: screen.id,
        name,
        state,
        screenshot: screen.screenshot,
        layout: screen.layout,
        url: screen.url,
        size: screen.size,
        from: fromScreen || prev?.id,
        reachedBy: screen.arrivedVia.map(actionLabel),
        components: screen.components,
        unmatched: screen.unmatched,
      });
      const png = fs.readFileSync(shotPath).toString("base64");
      return {
        content: [
          { type: "text", text: JSON.stringify(s.summaryOf(screen), null, 2) },
          { type: "image", data: png, mimeType: "image/png" },
        ],
      };
    })
  );

  server.registerTool(
    "trace_screenshot",
    {
      title: "View a captured screen",
      description: "Return the screenshot of a captured screen (by id like 's3'), or of the live page if omitted.",
      inputSchema: { screenId: z.string().optional(), sessionId: z.string().optional() },
    },
    guard(async ({ screenId, sessionId }) => {
      const s = get(sessionId);
      let buf;
      if (screenId) {
        const screen = s.screens.find((x) => x.id === screenId);
        if (!screen) throw new Error(`No screen ${screenId}. Captured: ${s.screens.map((x) => x.id).join(", ")}`);
        buf = fs.readFileSync(path.join(s.dir, screen.screenshot));
      } else {
        buf = await s.page.screenshot();
      }
      return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
    })
  );

  // ---------------------------------------------------------------- mapping
  server.registerTool(
    "trace_mapping",
    {
      title: "Read or update the Storybook-to-Figma mapping",
      description:
        "action 'list' shows entries; 'upsert' adds/replaces an entry by name (writes trace.mapping.json and reloads it); 'remove' deletes one. Never invent Figma keys: look them up with Figma MCP search_design_system.",
      inputSchema: {
        action: z.enum(["list", "upsert", "remove"]),
        entry: z
          .object({
            name: z.string(),
            storybookId: z.string().optional(),
            match: z
              .object({
                react: z.array(z.string()).optional(),
                selectors: z.array(z.string()).optional(),
                dataComponent: z.array(z.string()).optional(),
              })
              .optional(),
            figma: z
              .object({
                componentKey: z.string().optional(),
                componentSetKey: z.string().optional(),
                nodeId: z.string().optional(),
                fileKey: z.string().optional(),
              })
              .optional(),
            props: z.record(z.any()).optional(),
          })
          .optional(),
        name: z.string().optional().describe("For remove"),
      },
    },
    guard(async ({ action, entry, name }) => {
      const file = (current && current.mapping.file) || findMappingFile(cwd) || path.join(cwd, "trace.mapping.json");
      const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { figmaFileKey: "", components: [] };
      data.components ||= [];
      if (action === "list") {
        return text({
          file,
          components: data.components.map((c) => ({
            name: c.name,
            react: c.match?.react,
            selectors: c.match?.selectors,
            figma: c.figma?.componentKey || c.figma?.nodeId || "⚠ missing",
            props: Object.keys(c.props || {}),
          })),
        });
      }
      if (action === "upsert") {
        if (!entry) throw new Error("entry is required for upsert");
        const i = data.components.findIndex((c) => c.name === entry.name);
        if (i >= 0) data.components[i] = { ...data.components[i], ...entry };
        else data.components.push(entry);
      } else {
        data.components = data.components.filter((c) => c.name !== name);
      }
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
      for (const s of sessions.values()) {
        s.mapping.file ||= file;
        s.reloadMapping();
      }
      return text({ ok: true, file, entries: data.components.length });
    })
  );

  // ---------------------------------------------------------------- output
  server.registerTool(
    "trace_build_plan",
    {
      title: "Build the Figma plan and handoff notes",
      description: "Turn all captured screens into plan.json (frames, instances, links, notes, review flags) and handoff.md.",
      inputSchema: { sessionId: z.string().optional() },
    },
    guard(async ({ sessionId }) => {
      const s = get(sessionId);
      if (!s.screens.length) throw new Error("No screens captured yet.");
      const plan = buildPlan(s);
      writeHandoff(plan);
      lastPlan = plan;
      return text({
        planFile: path.join(plan.sessionDir, "plan.json"),
        handoffFile: path.join(plan.sessionDir, "handoff.md"),
        stats: plan.stats,
        screens: plan.screens.map((x) => ({ id: x.id, frame: x.frameName, nodes: x.nodes.length })),
        links: plan.links.map((l) => `${l.from} → ${l.to} via "${l.label}"`),
        stateGaps: plan.coverage.filter((c) => c.missing.length),
        review: plan.review.filter((r) => r.severity !== "info"),
        next: "Build in Figma: for each screen id call trace_figma_script and pass the code to Figma MCP use_figma.",
      });
    })
  );

  // Which run to build: the current session's, or a past one by id (after trace_end).
  const runFor = ({ sessionId, runId }) => {
    if (runId) {
      const dir = path.join(outDir, path.basename(runId));
      if (!fs.existsSync(path.join(dir, "run.json"))) throw new Error(`Unknown run ${runId}`);
      return new Run(dir);
    }
    return get(sessionId).run;
  };

  server.registerTool(
    "trace_figma_install",
    {
      title: "Install the Trace builder in a Figma file (once per file)",
      description:
        "Returns Plugin-API code that stores Trace's builder and the design-system profile in the destination Figma file. Pass it unchanged to Figma MCP use_figma once per file (and again only if a build call says TRACE_NOT_INSTALLED). After that, trace_figma_script calls are small.",
      inputSchema: { sessionId: z.string().optional(), runId: z.string().optional(), library: z.enum(["v1", "v2"]).optional() },
    },
    guard(async ({ sessionId, runId, library }) => {
      const run = runFor({ sessionId, runId });
      const lib = loadLibrary(libraryIdFor(run, library));
      return text({ figmaFileKey: run.data.figma?.fileKey || "(the destination file)", code: installScript(lib), next: "Run this with use_figma once, then call trace_figma_script." });
    })
  );

  server.registerTool(
    "trace_figma_script",
    {
      title: "Get Figma build calls for screens",
      description:
        "Returns short use_figma calls that build the run's screens on the page 'Trace / <flow>': the design system's app shell (V1: navigation + header) with the active nav item and header text set per screen, the content rebuilt with library components (buttons, chips, text fields), repeated code components built once and reused, dialogs as overlay frames. Each call covers several screens. Pass each `code` unchanged to Figma MCP use_figma; then run `linksCode` once for prototype links. If a call fails with TRACE_NOT_INSTALLED, run trace_figma_install first. Idempotent per screen.",
      inputSchema: {
        screenIds: z.array(z.string()).optional().describe("Screens to build, e.g. ['s1','s2']. Default: all."),
        runId: z.string().optional().describe("Build a past run (its folder name) instead of the current session"),
        sessionId: z.string().optional(),
        shell: z.boolean().optional().describe("Use the design system's app shell for nav + header (default true)"),
        components: z.boolean().optional().describe("Make local components for the shell and repeated parts (default false: paste copies, use only the library's components and styles)"),
        planFile: z.string().optional().describe("Legacy: build a plan.json with the Trace Importer builder"),
        notes: z.boolean().optional(),
      },
    },
    guard(async ({ screenIds, runId, sessionId, shell = true, components = false, planFile, notes = true }) => {
      if (planFile) {
        const plan = JSON.parse(fs.readFileSync(path.resolve(cwd, planFile), "utf8"));
        const code = `${builderSource()}\n\nreturn await buildTraceScreens(${JSON.stringify(plan)}, { notes: ${notes} });`;
        return text({ code });
      }
      const run = runFor({ sessionId, runId });
      const b = prepareBuild(run, { shell, components });
      const want = screenIds?.length ? b.screens.filter((x) => screenIds.includes(x.id)) : b.screens;
      if (!want.length) throw new Error(`No matching screens. Available: ${b.screens.map((x) => x.id).join(", ")}`);
      // Batch screens into calls of ~40 KB so each use_figma round trip does several.
      const calls = [];
      let cur = [];
      for (const sc of want) {
        if (cur.length && cur.reduce((n, x) => n + x.code.length, 0) + sc.code.length > 40000) calls.push(cur), (cur = []);
        cur.push(sc);
      }
      if (cur.length) calls.push(cur);
      return text({
        figmaFileKey: run.data.figma?.fileKey || "(use the destination file the designer gave you)",
        pageName: b.pageName,
        calls: calls.map((c) => ({ screens: c.map((x) => `${x.id} ${x.frameName}`), code: batchCode(c) })),
        linksCode: b.linksCode,
        next: "Run each call's code with use_figma (results list each screen's frame id: report it with trace_studio_update screens[].build.nodeId), then linksCode once. Check one screenshot at the end, not every screen.",
      });
    })
  );

  // ---------------------------------------------------------------- studio
  let studio = null;
  server.registerTool(
    "trace_studio_open",
    {
      title: "Open Trace Studio",
      description:
        "Open the designer's review page for the current run (storyboard of screens, states and connections; component decisions; build progress). Captures appear there live. Opens the browser unless open:false.",
      inputSchema: { open: z.boolean().optional(), sessionId: z.string().optional() },
    },
    guard(async ({ open = true, sessionId }) => {
      const s = get(sessionId);
      if (studio && studio.run !== s.run) {
        studio.close();
        studio = null;
      }
      if (!studio) studio = { ...(await startStudio({ root: outDir, activeRun: s.run })), run: s.run };
      if (open && process.env.TRACE_NO_BROWSER !== "1") {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        exec(`${cmd} ${studio.url}`);
      }
      return text({ url: `${studio.url}/#/run/${encodeURIComponent(s.run.data.id)}/flow`, next: "Tell the designer the Studio link. Use trace_studio_update to set stage/questions/matches and trace_studio_feedback to read their input." });
    })
  );

  server.registerTool(
    "trace_studio_update",
    {
      title: "Update Trace Studio",
      description:
        "Push agent-side changes to the run shown in Studio: stage ('understanding' while exploring, 'review' when the flow is ready for the designer, 'building', 'done'), questions for the designer, replies to their requests, edges (connections), screen edits (rename, step grouping, notes, element matches) and build progress per screen. Never overrides a decision the designer made.",
      inputSchema: {
        stage: z.enum(["understanding", "review", "building", "done"]).optional(),
        project: z.record(z.any()).optional().describe("e.g. { library, scenario, source }"),
        figma: z.object({ fileUrl: z.string().optional(), fileKey: z.string().optional() }).optional(),
        progress: z
          .object({ message: z.string(), current: z.number().optional(), total: z.number().optional() })
          .nullable()
          .optional()
          .describe("What Trace is doing right now (shown live in Studio). null clears it."),
        matching: z.enum(["running", "done"]).optional().describe("Set 'done' once elements have library proposals"),
        suggestions: z
          .array(z.object({ screenId: z.string(), state: z.string(), reason: z.string().optional() }))
          .optional()
          .describe("Likely missing states for the designer to add or dismiss, e.g. { screenId:'s3', state:'Error', reason:'list request can fail' }"),
        questions: z.array(z.object({ text: z.string(), options: z.array(z.string()).optional(), screenId: z.string().optional() })).optional(),
        resolveRequests: z.array(z.object({ id: z.string(), reply: z.string().optional(), status: z.enum(["done", "declined"]).optional() })).optional(),
        edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })).optional(),
        removeEdges: z.array(z.string()).optional(),
        screens: z
          .array(
            z.object({
              id: z.string(),
              name: z.string().optional(),
              state: z.string().optional(),
              step: z.string().optional().describe("Screens with the same step are shown in one column"),
              order: z.number().optional(),
              notes: z.string().optional(),
              status: z.enum(["proposed", "confirmed", "removed"]).optional(),
              elements: z
                .array(
                  z.object({
                    id: z.string(),
                    label: z.string().optional(),
                    role: z.string().optional(),
                    box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
                    proposed: z.object({ component: z.string(), props: z.record(z.any()).optional(), key: z.string().optional() }).nullable().optional(),
                    decision: z.enum(["component", "detached", "frames", "skip", "undecided"]).optional(),
                    confidence: z.enum(["high", "medium", "low", "none"]).optional(),
                  })
                )
                .optional(),
              build: z
                .object({
                  status: z.enum(["pending", "building", "built", "failed"]).optional(),
                  url: z.string().optional().describe("Link to the frame in Figma"),
                  nodeId: z.string().optional().describe("Id of the built Figma frame (the `frame` returned by the trace_figma_script code). Studio links to it."),
                  image: z.string().optional().describe("Path to a PNG of the built Figma frame (for the Compare view)"),
                  summary: z.string().optional(),
                  error: z.string().optional(),
                })
                .optional(),
            })
          )
          .optional(),
        log: z.string().optional().describe("One line for the Studio activity feed"),
        sessionId: z.string().optional(),
      },
    },
    guard(async ({ sessionId, ...patch }) => {
      const s = get(sessionId);
      // Copy Figma frame images into the run folder so Studio can serve them.
      for (const sc of patch.screens || []) {
        if (!sc.build?.image) continue;
        const src = path.resolve(cwd, sc.build.image);
        if (!fs.existsSync(src)) throw new Error(`Image not found: ${src}`);
        const rel = path.join("figma", `${sc.id}${path.extname(src) || ".png"}`);
        fs.mkdirSync(path.join(s.run.dir, "figma"), { recursive: true });
        fs.copyFileSync(src, path.join(s.run.dir, rel));
        sc.build.image = rel;
      }
      s.run.update(patch);
      return text({ ok: true, stage: s.run.data.stage, screens: s.run.data.screens.length });
    })
  );

  server.registerTool(
    "trace_studio_feedback",
    {
      title: "Read the designer's input from Trace Studio",
      description:
        "Returns open requests (change / add-screen / add-state / remove), answers to your questions, element decisions the designer made, removed screens, and whether the flow is approved. Act on each open request, then resolve it with trace_studio_update.resolveRequests.",
      inputSchema: { sessionId: z.string().optional() },
    },
    guard(async ({ sessionId }) => {
      const s = get(sessionId);
      const fb = s.run.feedback();
      s.run.markAnswersConsumed();
      return text(fb);
    })
  );

  // ---------------------------------------------------------------- listening to Studio
  // Lets any MCP tool stay connected: the agent calls trace_wait in a loop and
  // acts on whatever the designer does in Studio, without a new chat message.
  server.registerTool(
    "trace_wait",
    {
      title: "Wait for the designer in Trace Studio",
      description:
        "Blocks until something in Trace Studio needs you, then returns it: a project to explore or flows to trace (same shape as trace_project_next), or designer input on a traced flow (open requests, answers, approval; same shape as trace_studio_feedback). Returns { event: 'timeout' } when nothing happened; call it again. Use this to stay connected instead of asking the designer to message you.",
      inputSchema: {
        timeoutSeconds: z.number().int().min(5).max(55).optional().describe("How long to wait before returning 'timeout' (default 45)"),
        sessionId: z.string().optional().describe("Also watch this traced flow for designer input (default: the current session)"),
      },
    },
    guard(async ({ timeoutSeconds = 45, sessionId }) => {
      const s = sessionId ? get(sessionId) : current;
      const deadline = Date.now() + timeoutSeconds * 1000;
      engine.listening = true;
      beat();
      try {
        while (Date.now() < deadline) {
          if (s) {
            const fb = s.run.sync().feedback();
            if (fb.openRequests.length || fb.answers.length || s.run.data.stage === "approved") {
              s.run.markAnswersConsumed();
              return text({ event: fb.approved ? "approved" : "feedback", sessionId: s.id, ...fb });
            }
          }
          const pending = projects.pending();
          if (pending.length) {
            return text({ event: "project", projectId: pending[0].id, name: pending[0].name, status: pending[0].status, next: `Call trace_project_next { projectId: "${pending[0].id}" } and follow its todo.` });
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        return text({ event: "timeout", next: "Nothing new in Trace Studio. Call trace_wait again to keep listening." });
      } finally {
        engine.listening = false;
        beat();
      }
    })
  );

  // ---------------------------------------------------------------- projects (started in Studio)
  server.registerTool(
    "trace_project_next",
    {
      title: "Get work started from Trace Studio",
      description:
        "Lists Studio projects that need the engine: newly set up (explore the prototype and propose flows), or with picked flows that have no run yet (trace them). Returns the project setup, the target design system (with its Figma library file key) and the Figma destination file.",
      inputSchema: { projectId: z.string().optional() },
    },
    guard(async ({ projectId }) => {
      const list = projectId ? [projects.get(projectId)] : projects.pending();
      if (projectId && list[0]?.paused) return text({ pending: [], paused: true, note: "The designer paused this project in Trace Studio. Stop after the current flow and don't start new work until it's resumed." });
      if (list[0]) working({ projectId: list[0].id, since: new Date().toISOString() });
      if (!list.length) return text({ pending: [], note: "Nothing waiting. Ask the designer to set up a project in Trace Studio (trace studio)." });
      return text({
        pending: list.map((p) => {
          const ds = designSystem(p.designSystem);
          const todo = ["queued", "understanding"].includes(p.status)
            ? "UNDERSTAND: clone/start the prototype, read the code (views, routes, state, scenarios), then propose flows with trace_project_update { status: 'choose-flows', summary, flows }. Report progress with trace_project_update { status: 'understanding', progress }."
            : "TRACE: for each picked flow without runId, trace_start with { projectId, flowId, scenario } and walk it; open Studio for review (trace_studio_open).";
          return {
            projectId: p.id,
            name: p.name,
            status: p.status,
            todo,
            designSystem: ds && { id: ds.id, name: ds.name, libraryFileKey: ds.fileKey, libraryUrl: ds.url, tokens: ds.tokens },
            repo: p.repo,
            figmaDestination: { ...p.figma, pagePerFlow: "Create one new page per flow, named 'Trace / <flow> — <scenario>'. Never change existing pages." },
            pickedFlows: p.flows.filter((f) => f.selected).map((f) => ({ id: f.id, name: f.name, description: f.description, scenario: f.scenario, steps: f.steps, runId: f.runId || null })),
          };
        }),
      });
    })
  );

  server.registerTool(
    "trace_project_update",
    {
      title: "Report project progress to Trace Studio",
      description:
        "Update a Studio project: status ('understanding' → 'choose-flows' → 'tracing', or 'failed' with error), live progress, a summary of what was found, the proposed flows (designer picks from these), Figma access check, and finished exports (one per Figma page built).",
      inputSchema: {
        projectId: z.string(),
        status: z.enum(["understanding", "choose-flows", "tracing", "failed"]).optional(),
        progress: z
          .object({
            message: z.string(),
            current: z.number().optional(),
            total: z.number().optional(),
            steps: z.array(z.object({ label: z.string(), status: z.enum(["todo", "doing", "done", "failed"]) })).optional(),
          })
          .nullable()
          .optional(),
        summary: z
          .object({ views: z.number().optional(), scenarios: z.array(z.string()).optional(), notes: z.string().optional(), prototypeUrl: z.string().optional() })
          .optional(),
        flows: z
          .array(
            z.object({
              id: z.string().optional(),
              name: z.string(),
              description: z.string().optional(),
              steps: z.array(z.string()).optional().describe("Screen names in order, e.g. ['Landing','Search results','Saved lists']"),
              scenarios: z.array(z.string()).optional().describe("Scenarios this flow applies to"),
              screensEstimate: z.number().optional(),
              states: z.array(z.string()).optional().describe("Notable states Trace expects to capture"),
            })
          )
          .optional(),
        figma: z.object({ verified: z.boolean().optional(), fileName: z.string().optional(), error: z.string().optional() }).optional(),
        exports: z
          .array(z.object({ runId: z.string().optional(), flowId: z.string().optional(), flowName: z.string(), pageName: z.string().optional(), figmaUrl: z.string().optional(), screens: z.number().optional(), status: z.string().optional() }))
          .optional(),
        error: z.string().optional(),
        log: z.string().optional(),
      },
    },
    guard(async ({ projectId, ...patch }) => {
      const p = projects.update(projectId, patch);
      working(["choose-flows", "failed"].includes(p.status) ? null : { projectId, since: new Date().toISOString() });
      return text({ ok: true, status: p.status, flows: p.flows.length, picked: p.flows.filter((f) => f.selected).length });
    })
  );

  server.registerTool(
    "trace_end",
    {
      title: "End the Trace session",
      description: "Close the browser and save the session.",
      inputSchema: { sessionId: z.string().optional() },
    },
    guard(async ({ sessionId }) => {
      const s = get(sessionId);
      await s.close();
      sessions.delete(s.id);
      if (current === s) current = null;
      return text({ closed: s.id, outputDir: s.dir });
    })
  );

  const shutdown = async () => {
    clearInterval(beatTimer);
    for (const s of sessions.values()) await s.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.server.oninitialized = () => {
    engine.client = server.server.getClientVersion()?.name || null;
    beat();
  };
  await server.connect(new StdioServerTransport());
}

function actionLabel(a) {
  const target = a.target?.text || a.name || a.text || a.selector || a.url || "";
  const verb = { click: "Click", press: "Press", goto: "Go to", select: "Select", check: "Check" }[a.type] || a.type;
  return a.type === "press" ? `Press ${a.key || "Enter"}` : `${verb} "${target.slice(0, 40)}"`;
}
