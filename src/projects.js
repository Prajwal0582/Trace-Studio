// Projects: one prototype + one design system + one Figma destination file.
// A project holds the setup, the "understanding" progress, the flows Trace
// proposes, which flows the designer picked (each becomes a run), and the
// export history. Stored as .trace/projects/<id>/project.json so both Trace
// Studio and the MCP server (the agent) can read and write it.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { designSystem, parseFigmaUrl } from "./design-systems.js";

// Lifecycle shown to the designer.
export const PROJECT_STATUS = [
  "draft", // setup not finished
  "queued", // setup done, waiting for an engine to pick it up
  "understanding", // Trace is cloning, starting and reading the prototype
  "choose-flows", // Trace proposed flows; designer picks
  "tracing", // runs exist for the picked flows (each has its own stage)
  "failed",
];

let seq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const slug = (s) =>
  String(s || "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "project";

export class ProjectStore {
  constructor(root) {
    this.root = root; // the .trace folder
    this.dir = path.join(root, "projects");
  }

  file(id) {
    return path.join(this.dir, path.basename(id), "project.json");
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .map((id) => {
        try {
          return this.get(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  get(id) {
    const f = this.file(id);
    if (!fs.existsSync(f)) throw new Error(`No project ${id}`);
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }

  save(p) {
    p.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.file(p.id)), { recursive: true });
    fs.writeFileSync(this.file(p.id), JSON.stringify(p, null, 2));
    return p;
  }

  log(p, msg, kind = "info") {
    p.log ||= [];
    p.log.push({ at: new Date().toISOString(), msg, kind });
    if (p.log.length > 300) p.log.shift();
  }

  // ---- designer side ------------------------------------------------------
  createDraft(fields = {}) {
    const p = {
      id: `${slug(fields.name || repoName(fields.repo?.url))}-${Date.now().toString(36)}`,
      name: fields.name || repoName(fields.repo?.url) || "Untitled project",
      createdAt: new Date().toISOString(),
      status: "draft",
      engine: "ai-tool",
      designSystem: fields.designSystem || null,
      repo: { url: "", branch: "", ...(fields.repo || {}) },
      figma: { fileUrl: "", fileKey: null, verified: false, ...(fields.figma || {}) },
      progress: null,
      summary: null,
      flows: [],
      customFlows: [],
      exports: [],
      log: [],
    };
    this.log(p, "Project created", "designer");
    return this.save(p);
  }

  updateDraft(id, fields) {
    const p = this.get(id);
    if (fields.designSystem !== undefined) p.designSystem = fields.designSystem;
    if (fields.repo) p.repo = { ...p.repo, ...fields.repo };
    if (fields.name) p.name = fields.name;
    if (fields.figma) {
      const parsed = parseFigmaUrl(fields.figma.fileUrl || "");
      p.figma = { ...p.figma, fileUrl: fields.figma.fileUrl, fileKey: parsed?.fileKey || null, verified: false };
    }
    if (p.status === "draft" && !fields.name && p.repo.url && p.name === "Untitled project") p.name = repoName(p.repo.url);
    return this.save(p);
  }

  validate(p) {
    const errors = {};
    if (!designSystem(p.designSystem)) errors.designSystem = "Choose V1 or V2.";
    if (!p.repo.url) errors.repo = "Add the prototype's GitHub repository or a local folder.";
    else if (!isRepoLike(p.repo.url)) errors.repo = "That doesn't look like a GitHub URL or a folder path.";
    if (!p.figma.fileUrl) errors.figma = "Add the Figma file where the screens should go.";
    else if (!p.figma.fileKey) errors.figma = "That isn't a Figma design file link (figma.com/design/…).";
    return errors;
  }

  start(id) {
    const p = this.get(id);
    const errors = this.validate(p);
    if (Object.keys(errors).length) throw Object.assign(new Error(Object.values(errors)[0]), { fields: errors });
    p.status = "queued";
    p.queuedAt = new Date().toISOString();
    this.log(p, "Setup finished. Waiting for Trace to start", "designer");
    return this.save(p);
  }

  selectFlows(id, { flows = [], custom = [] }) {
    const p = this.get(id);
    if (!flows.length && !custom.filter((c) => c.trim()).length) throw new Error("Pick at least one flow.");
    for (const f of p.flows) {
      const pick = flows.find((x) => x.id === f.id);
      f.selected = !!pick;
      if (pick?.scenario) f.scenario = pick.scenario;
    }
    for (const text of custom.map((c) => c.trim()).filter(Boolean)) {
      p.flows.push({ id: uid("f"), name: text.length > 48 ? text.slice(0, 47) + "…" : text, description: text, custom: true, selected: true, scenario: null, steps: [], scenarios: [] });
    }
    p.status = "tracing";
    p.flowsSelectedAt = new Date().toISOString();
    this.log(p, `Picked ${p.flows.filter((f) => f.selected).length} flow(s) to trace`, "designer");
    return this.save(p);
  }

  cancel(id) {
    const p = this.get(id);
    p.status = p.flows.length ? "choose-flows" : "draft";
    p.progress = null;
    this.log(p, "Cancelled", "designer");
    return this.save(p);
  }

  pause(id, paused) {
    const p = this.get(id);
    p.paused = !!paused;
    this.log(p, paused ? "Paused" : "Resumed", "designer");
    return this.save(p);
  }

  // Removes the project and (optionally) the flows it captured. Never touches Figma.
  remove(id, { withRuns = true } = {}) {
    const p = this.get(id);
    const removedRuns = [];
    for (const name of fs.readdirSync(this.root)) {
      {
        const f = path.join(this.root, name, "run.json");
        if (!fs.existsSync(f)) continue;
        try {
          const r = JSON.parse(fs.readFileSync(f, "utf8"));
          if (r.project?.projectId === id && !withRuns) {
            // Keep the flow, detached from the deleted project.
            r.project.projectId = null;
            r.project.flowId = null;
            fs.writeFileSync(f, JSON.stringify(r, null, 2));
          } else if (r.project?.projectId === id) {
            fs.rmSync(path.join(this.root, name), { recursive: true, force: true });
            removedRuns.push(name);
          }
        } catch {
          /* unreadable run — leave it */
        }
      }
    }
    fs.rmSync(path.dirname(this.file(p.id)), { recursive: true, force: true });
    return { removed: p.id, removedRuns };
  }

  // ---- agent side -----------------------------------------------------------
  update(id, patch) {
    const p = this.get(id);
    for (const k of ["status", "progress", "summary", "error"]) if (patch[k] !== undefined) p[k] = patch[k];
    if (patch.figma) p.figma = { ...p.figma, ...patch.figma };
    if (patch.repo) p.repo = { ...p.repo, ...patch.repo };
    if (patch.flows) {
      for (const f of patch.flows) {
        const cur = p.flows.find((x) => x.id === f.id || (f.name && x.name === f.name && !x.custom));
        if (cur) Object.assign(cur, f, { selected: cur.selected, scenario: cur.scenario ?? f.scenario });
        else p.flows.push({ id: f.id || uid("f"), selected: false, scenario: f.scenarios?.[0] || null, steps: [], scenarios: [], ...f });
      }
    }
    for (const e of patch.exports || []) p.exports.push({ id: uid("x"), at: new Date().toISOString(), ...e });
    if (patch.log) this.log(p, patch.log, "agent");
    return this.save(p);
  }

  // What needs the engine's attention, oldest first.
  pending() {
    return this.list()
      .filter((p) => !p.paused)
      .filter((p) => ["queued", "understanding"].includes(p.status) || (p.status === "tracing" && p.flows.some((f) => f.selected && !f.runId)))
      .reverse();
  }
}

export function repoName(url) {
  if (!url) return "";
  const m = String(url).replace(/\.git$/, "").match(/([^/:]+)\/?$/);
  return m ? m[1] : "";
}
export function isRepoLike(s) {
  return /^(https?:\/\/|git@)[^\s]+$/.test(s) || /^(\/|~\/|\.\.?\/)/.test(s);
}

// Cheap reachability check for the setup form: lists remote branches.
export function checkRepo(url) {
  return new Promise((resolve) => {
    if (/^(\/|~\/|\.\.?\/)/.test(url)) {
      const p = url.replace(/^~/, process.env.HOME || "");
      const ok = fs.existsSync(path.join(p, "package.json"));
      return resolve(ok ? { ok: true, kind: "folder", note: "Folder found" } : { ok: false, error: "No package.json in that folder." });
    }
    execFile("git", ["ls-remote", "--symref", url, "HEAD", "refs/heads/*"], { timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, out) => {
      if (err) return resolve({ ok: false, error: "Couldn't reach that repository. Check the link, or that you have access to it." });
      const def = out.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
      const branches = [...out.matchAll(/refs\/heads\/(\S+)$/gm)].map((m) => m[1]);
      resolve({ ok: true, kind: "github", defaultBranch: def?.[1] || branches[0] || "main", branches: branches.slice(0, 50) });
    });
  });
}
