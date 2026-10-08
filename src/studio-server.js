// Trace Studio: a small local web server (127.0.0.1 only).
// - Designers start projects here (design system → prototype → Figma file),
//   pick the flows Trace proposes, review each flow's canvas, approve, and
//   compare the Figma result.
// - The engine (the designer's AI tool through MCP, or later the built-in
//   agent) reads and writes the same files under .trace/, so Studio watches
//   that folder and pushes changes to the browser live.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Run } from "./run.js";
import { ProjectStore, checkRepo } from "./projects.js";
import { DESIGN_SYSTEMS, parseFigmaUrl } from "./design-systems.js";
import { TRACE_HOME } from "./home.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "studio");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json" };

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

// Is an AI tool running Trace right now? (heartbeat written by the MCP server)
function engineStatus(root) {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(root, "engine.json"), "utf8"));
    let alive = Date.now() - new Date(e.lastSeen).getTime() < 15000;
    if (alive) {
      try {
        process.kill(e.pid, 0);
      } catch {
        alive = false;
      }
    }
    return alive ? { connected: true, client: e.client, working: e.working, since: e.startedAt } : { connected: false, lastSeen: e.lastSeen };
  } catch {
    return { connected: false };
  }
}

function runSummary(run, active) {
  const d = run.data;
  const live = d.screens.filter((s) => s.status !== "removed");
  return {
    id: d.id,
    active,
    projectId: d.project?.projectId || null,
    flowId: d.project?.flowId || null,
    flowName: d.project?.flowName || d.id,
    library: d.project?.library || null,
    scenario: d.project?.scenario || null,
    stage: d.stage,
    screens: live.length,
    steps: new Set(live.map((s) => s.step)).size,
    built: live.filter((s) => s.build?.status === "built").length,
    cover: live[0]?.screenshot || null,
    updatedAt: d.updatedAt || d.createdAt,
    figma: d.figma || {},
  };
}

// startStudio({ root, activeRun }) — root is the .trace folder.
export function startStudio(opts = {}, legacy = {}) {
  // Back-compat: startStudio(run, { port })
  if (opts instanceof Run) opts = { activeRun: opts, ...legacy };
  const activeRun = opts.activeRun || null;
  const root = opts.root || (activeRun ? path.dirname(activeRun.dir) : TRACE_HOME);
  const port = opts.port || Number(process.env.TRACE_STUDIO_PORT || 4747);
  fs.mkdirSync(root, { recursive: true });
  const projects = new ProjectStore(root);
  const runs = new Map(activeRun ? [[activeRun.data.id, activeRun]] : []);
  const clients = new Set();
  const broadcast = (payload) => {
    for (const res of clients) res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  // In-process changes (same Node process as the MCP server)…
  const onActive = (event) => broadcast({ kind: "run", id: activeRun.data.id, event });
  activeRun?.on("change", onActive);
  // …and changes written by other processes (agent, CLI). Debounced per file.
  const timers = new Map();
  let watcher = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_, file) => {
      if (!file || !/(run|project|engine)\.json$/.test(file)) return;
      clearTimeout(timers.get(file));
      timers.set(
        file,
        setTimeout(() => {
          const parts = file.split(path.sep);
          if (file === "engine.json") return broadcast({ kind: "engine" });
          if (file.endsWith("project.json")) return broadcast({ kind: "project", id: parts[1] });
          const id = parts[0];
          const cached = runs.get(id);
          if (cached && cached !== activeRun) {
            try {
              cached.reload();
            } catch {
              /* half-written */
            }
          }
          broadcast({ kind: "run", id });
        }, 120)
      );
    });
  } catch {
    /* recursive watch unsupported: in-process updates still work */
  }

  const getRun = (id) => {
    if (activeRun && (!id || id === activeRun.data.id)) return activeRun;
    if (!id) throw new Error("No run selected");
    if (runs.has(id)) return runs.get(id);
    const dir = path.join(root, path.basename(id));
    if (!fs.existsSync(path.join(dir, "run.json"))) throw new Error(`Unknown run ${id}`);
    const run = new Run(dir);
    runs.set(id, run);
    return run;
  };
  const listRuns = () => {
    const out = [];
    for (const name of fs.readdirSync(root)) {
      const f = path.join(root, name, "run.json");
      if (!fs.existsSync(f)) continue;
      try {
        const run = runs.get(name) || { data: JSON.parse(fs.readFileSync(f, "utf8")) };
        out.push(runSummary(run, name === activeRun?.data.id));
      } catch {
        /* unreadable run — skip */
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  };
  // Every Figma page Trace produced, newest first.
  const exportsList = (allRuns, allProjects) => {
    const rows = [];
    for (const p of allProjects) for (const x of p.exports || []) rows.push({ ...x, projectId: p.id, projectName: p.name, designSystem: p.designSystem });
    for (const r of allRuns) {
      if (!["building", "done"].includes(r.stage) && !r.built) continue;
      if (rows.some((x) => x.runId === r.id)) continue;
      const p = allProjects.find((pp) => pp.id === r.projectId);
      rows.push({
        id: `run-${r.id}`,
        at: r.updatedAt,
        runId: r.id,
        flowName: r.flowName,
        projectId: r.projectId,
        projectName: p?.name || null,
        library: r.library,
        designSystem: p?.designSystem || null,
        screens: r.screens,
        built: r.built,
        status: r.stage === "done" ? "built" : "building",
        figmaUrl: r.figma.pageUrl || r.figma.fileUrl || null,
      });
    }
    return rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  };

  const send = (res, status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    try {
      if (req.method === "GET") {
        if (p === "/api/home") {
          const allRuns = listRuns();
          const allProjects = projects.list();
          return send(res, 200, { engine: engineStatus(root), active: activeRun?.data.id || null, projects: allProjects, runs: allRuns, exports: exportsList(allRuns, allProjects), designSystems: DESIGN_SYSTEMS });
        }
        if (p === "/api/runs") return send(res, 200, { active: activeRun?.data.id || null, runs: listRuns() });
        if (p === "/api/run") return send(res, 200, getRun(url.searchParams.get("id")).data);
        if (p === "/api/project") {
          const proj = projects.get(url.searchParams.get("id"));
          return send(res, 200, { engine: engineStatus(root), project: proj, runs: listRuns().filter((r) => r.projectId === proj.id), designSystems: DESIGN_SYSTEMS });
        }
        if (p === "/api/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          res.write("retry: 2000\n\n");
          clients.add(res);
          const ping = setInterval(() => res.write(": ping\n\n"), 25000);
          req.on("close", () => {
            clearInterval(ping);
            clients.delete(res);
          });
          return;
        }
        // /shots/<runId>/<path inside run folder>
        if (p.startsWith("/shots/")) {
          const [runId, ...rest] = decodeURIComponent(p.slice("/shots/".length)).split("/");
          const run = getRun(runId);
          const file = path.resolve(run.dir, rest.join("/"));
          if (!file.startsWith(run.dir + path.sep) || !fs.existsSync(file)) return send(res, 404, "not found", "text/plain");
          return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
        }
      }
      if (req.method === "POST" && p.startsWith("/api/")) {
        const body = await readBody(req);
        // ---- projects
        switch (p) {
          case "/api/project/create":
            return send(res, 200, projects.createDraft(body));
          case "/api/project/update":
            return send(res, 200, projects.updateDraft(body.id, body));
          case "/api/project/start":
            try {
              return send(res, 200, projects.start(body.id));
            } catch (e) {
              return send(res, 400, { error: e.message, fields: e.fields || null });
            }
          case "/api/project/select-flows":
            return send(res, 200, projects.selectFlows(body.id, body));
          case "/api/project/pause":
            return send(res, 200, projects.pause(body.id, body.paused));
          case "/api/project/delete": {
            const out = projects.remove(body.id, { withRuns: body.withRuns !== false });
            for (const r of out.removedRuns) runs.delete(r);
            broadcast({ kind: "project", id: body.id, deleted: true });
            return send(res, 200, out);
          }
          case "/api/project/cancel":
            return send(res, 200, projects.cancel(body.id));
          case "/api/check/repo":
            return send(res, 200, await checkRepo(String(body.url || "").trim()));
          case "/api/check/figma": {
            const parsed = parseFigmaUrl(String(body.url || "").trim());
            return send(res, 200, parsed ? { ok: true, ...parsed } : { ok: false, error: "Paste a Figma design file link, like figma.com/design/…" });
          }
        }
        // ---- runs
        const run = getRun(body.runId);
        switch (p) {
          case "/api/request":
            return send(res, 200, run.request(body));
          case "/api/answer":
            run.answer(body.id, body.answer);
            break;
          case "/api/decide":
            run.decide(body.screenId, body.elementId, body.decision, body.items);
            break;
          case "/api/screen":
            run.rename(body.id, body);
            break;
          case "/api/arrange":
            run.arrange(body);
            break;
          case "/api/suggestion":
            run.suggestion(body.id, body.action);
            break;
          case "/api/validate":
            run.validate(body.screenId, body.verdict, body.note);
            break;
          case "/api/approve":
            run.approve();
            break;
          default:
            return send(res, 404, { error: "unknown endpoint" });
        }
        if (run !== activeRun) broadcast({ kind: "run", id: run.data.id });
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET") {
        const rel = p === "/" ? "index.html" : p.slice(1);
        const file = path.resolve(ROOT, rel);
        if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "text/plain");
        }
      }
      send(res, 404, "not found", "text/plain");
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (pt) => {
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && attempt++ < 20) tryListen(pt + 1);
        else reject(e);
      });
      server.listen(pt, "127.0.0.1", () =>
        resolve({
          url: `http://127.0.0.1:${pt}`,
          root,
          close: () => {
            activeRun?.off("change", onActive);
            watcher?.close();
            for (const c of clients) c.end();
            server.close();
          },
        })
      );
    };
    tryListen(port);
  });
}
