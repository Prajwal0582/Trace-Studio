// A Trace "run" is the shared state between the AI agent and Trace Studio:
// the proposed flow (screens, states, connections), component matches,
// questions for the designer, the designer's requests, approval, and build
// progress. Persisted as run.json inside the session folder; every change is
// broadcast to Studio over server-sent events.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export const STAGES = ["understanding", "review", "approved", "building", "done"];

let seq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export class Run extends EventEmitter {
  constructor(dir, init = {}) {
    super();
    this.dir = dir;
    this.file = path.join(dir, "run.json");
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : {
          id: path.basename(dir),
          createdAt: new Date().toISOString(),
          project: init.project || {},
          stage: "understanding",
          screens: [],
          edges: [],
          questions: [],
          requests: [],
          log: [],
          figma: {},
        };
    this.normalize();
    this.mtime = this.fileMtime();
  }

  fileMtime() {
    try {
      return fs.statSync(this.file).mtimeMs;
    } catch {
      return 0;
    }
  }

  // Pick up changes another process (Trace Studio) wrote since we last read or saved.
  sync() {
    if (this.fileMtime() !== this.mtime) this.reload();
    return this;
  }

  // Fields added after the first version of run.json.
  normalize() {
    this.data.stepOrder ||= [];
    this.data.suggestions ||= [];
    this.data.progress ||= null;
  }

  // Re-read run.json after another process (the MCP server) changed it.
  reload() {
    this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    this.normalize();
    this.mtime = this.fileMtime();
    this.emit("change", "file");
  }

  save(event = "update") {
    this.data.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    this.mtime = this.fileMtime();
    this.emit("change", event);
  }

  log(msg, kind = "info") {
    this.data.log.push({ at: new Date().toISOString(), msg, kind });
    if (this.data.log.length > 300) this.data.log.shift();
  }

  screen(id) {
    const s = this.data.screens.find((x) => x.id === id);
    if (!s) throw new Error(`No screen ${id}. Screens: ${this.data.screens.map((x) => x.id).join(", ")}`);
    return s;
  }

  // Called for every trace_capture. `step` groups a screen with its states.
  addScreen({ id, name, state, screenshot, layout, url, size, reachedBy, from, components = [], unmatched = [] }) {
    const existing = this.data.screens.find((s) => s.id === id);
    const elements = [
      ...components.map((c) => ({
        id: c.id,
        label: c.texts?.[0] || c.component,
        role: c.component,
        box: c.box,
        proposed: { component: c.component, props: c.props },
        decision: c.figma?.componentKey || c.figma?.nodeId ? "component" : "detached",
        confidence: c.matchedVia?.startsWith("react:") || c.matchedVia === "data-attribute" ? "high" : "medium",
      })),
      ...unmatched
        .filter((u) => u.kind !== "container")
        .map((u) => ({
          id: u.id,
          label: u.text || u.reactComponent || u.tag,
          role: u.reactComponent || u.tag,
          box: u.box,
          proposed: null,
          decision: "undecided",
          confidence: "none",
        })),
    ];
    const screen = {
      id,
      name,
      state: state || "default",
      step: name,
      screenshot,
      layout,
      url,
      size,
      reachedBy: reachedBy || [],
      status: existing?.status || "proposed",
      notes: existing?.notes || "",
      elements,
      build: existing?.build || { status: "pending" },
    };
    if (existing) Object.assign(existing, screen);
    else this.data.screens.push(screen);
    if (from && reachedBy?.length) {
      for (const label of reachedBy) this.addEdge({ from, to: id, label });
    }
    this.log(`Captured ${name}${state && state !== "default" ? ` — ${state}` : ""}`);
    this.save("screen");
    return screen;
  }

  addEdge({ from, to, label }) {
    if (!this.data.edges.some((e) => e.from === from && e.to === to && e.label === label)) {
      this.data.edges.push({ id: uid("e"), from, to, label });
    }
  }

  // ---- designer side (Studio) ------------------------------------------
  request({ type, screenId, text, after }) {
    const r = { id: uid("r"), type, screenId: screenId || null, after: after || null, text: text || "", status: "open", at: new Date().toISOString() };
    this.data.requests.push(r);
    if (type === "remove" && screenId) this.screen(screenId).status = "removed";
    if (type === "restore" && screenId) {
      this.screen(screenId).status = "proposed";
      r.status = "done";
    }
    this.log(`Designer: ${type}${screenId ? ` on ${screenId}` : ""}${text ? ` — "${text.slice(0, 60)}"` : ""}`, "designer");
    this.save("request");
    return r;
  }

  answer(questionId, answer) {
    const q = this.data.questions.find((x) => x.id === questionId);
    if (!q) throw new Error("No such question");
    q.answer = answer;
    q.answeredAt = new Date().toISOString();
    this.log(`Designer answered: "${q.text.slice(0, 50)}" → ${answer}`, "designer");
    this.save("answer");
  }

  // items: [{ screenId, elementId }] — one call for a whole component group.
  decide(screenId, elementId, decision, items) {
    const list = items?.length ? items : [{ screenId, elementId }];
    for (const it of list) {
      const el = this.screen(it.screenId).elements.find((e) => e.id === it.elementId);
      if (!el) continue;
      el.decision = decision;
      el.decidedBy = "designer";
    }
    if (list.length > 1) this.log(`Designer set ${list.length} elements to "${decision}"`, "designer");
    this.save("decision");
  }

  // Designer rearranged the storyboard: which step each screen belongs to,
  // the order inside a step, and the order of steps.
  arrange({ screens = [], stepOrder }) {
    for (const a of screens) {
      const sc = this.screen(a.id);
      if (a.step != null) sc.step = a.step;
      if (a.order != null) sc.order = a.order;
      if (a.main) {
        for (const o of this.data.screens) if (o.step === sc.step && o !== sc && (!o.state || o.state === "default")) o.state = o.state || "alternate";
        sc.state = "default";
      }
    }
    if (stepOrder) this.data.stepOrder = stepOrder;
    this.data.arrangedByDesigner = true;
    this.log("Designer rearranged the flow", "designer");
    this.save("arrange");
  }

  suggestion(id, action) {
    const sg = this.data.suggestions.find((x) => x.id === id);
    if (!sg) throw new Error("No such suggestion");
    sg.status = action === "add" ? "added" : "dismissed";
    if (action === "add") this.request({ type: "add-state", screenId: sg.screenId, after: sg.screenId, text: `${sg.state}${sg.reason ? ` — ${sg.reason}` : ""}` });
    else this.save("suggestion");
  }

  // Post-build check from the Compare view.
  validate(screenId, verdict, note) {
    const sc = this.screen(screenId);
    sc.review = { verdict, note: note || "", at: new Date().toISOString() };
    if (verdict === "fix") this.request({ type: "fix", screenId, text: note || "Figma result doesn't match the prototype" });
    else {
      this.log(`Designer marked ${sc.name}${sc.state && sc.state !== "default" ? ` — ${sc.state}` : ""} as looking right`, "designer");
      this.save("review");
    }
  }

  rename(screenId, { name, state, notes }) {
    const s = this.screen(screenId);
    if (name != null) s.name = name;
    if (state != null) s.state = state;
    if (notes != null) s.notes = notes;
    this.save("screen");
  }

  approve() {
    const open = this.data.requests.filter((r) => r.status === "open").length;
    const unanswered = this.data.questions.filter((q) => !q.answer).length;
    if (open || unanswered) throw new Error(`Resolve ${open} open request(s) and ${unanswered} question(s) first.`);
    this.data.stage = "approved";
    this.data.approvedAt = new Date().toISOString();
    for (const s of this.data.screens) if (s.status === "proposed") s.status = "confirmed";
    this.log("Designer approved the flow", "designer");
    this.save("stage");
  }

  // ---- agent side (MCP tools) -------------------------------------------
  update(patch) {
    const d = this.data;
    if (patch.project) d.project = { ...d.project, ...patch.project };
    if (patch.stage) d.stage = patch.stage;
    if (patch.figma) d.figma = { ...d.figma, ...patch.figma };
    if (patch.progress !== undefined) d.progress = patch.progress;
    if (patch.matching) d.matching = patch.matching;
    for (const sg of patch.suggestions || []) {
      d.suggestions.push({ id: uid("g"), screenId: sg.screenId, state: sg.state, reason: sg.reason || "", status: "open" });
    }
    for (const q of patch.questions || []) {
      d.questions.push({ id: uid("q"), text: q.text, options: q.options || [], screenId: q.screenId || null, answer: null });
    }
    for (const r of patch.resolveRequests || []) {
      const req = d.requests.find((x) => x.id === r.id);
      if (req) {
        req.status = r.status || "done";
        req.reply = r.reply || "";
      }
    }
    for (const e of patch.edges || []) this.addEdge(e);
    for (const id of patch.removeEdges || []) d.edges = d.edges.filter((e) => e.id !== id);
    for (const s of patch.screens || []) {
      const sc = this.screen(s.id);
      for (const k of ["name", "state", "step", "notes", "status", "order"]) if (s[k] != null) sc[k] = s[k];
      if (s.elements) {
        for (const el of s.elements) {
          const cur = sc.elements.find((x) => x.id === el.id);
          if (cur) {
            if (cur.decidedBy === "designer") delete el.decision; // never override the designer
            Object.assign(cur, el);
          } else sc.elements.push({ decision: "undecided", confidence: "medium", ...el });
        }
      }
      if (s.build) sc.build = { ...sc.build, ...s.build };
    }
    if (patch.log) this.log(patch.log, "agent");
    this.save("agent");
  }

  feedback() {
    const d = this.data;
    return {
      stage: d.stage,
      approved: ["approved", "building", "done"].includes(d.stage),
      openRequests: d.requests.filter((r) => r.status === "open"),
      answers: d.questions.filter((q) => q.answer && !q.consumed).map((q) => ({ id: q.id, question: q.text, answer: q.answer, screenId: q.screenId })),
      unansweredQuestions: d.questions.filter((q) => !q.answer).length,
      designerDecisions: d.screens.flatMap((s) =>
        s.elements.filter((e) => e.decidedBy === "designer").map((e) => ({ screen: s.id, element: e.id, label: e.label, decision: e.decision }))
      ),
      removedScreens: d.screens.filter((s) => s.status === "removed").map((s) => s.id),
      arrangement: d.arrangedByDesigner
        ? { stepOrder: d.stepOrder, screens: d.screens.map((s) => ({ id: s.id, step: s.step, state: s.state, order: s.order })) }
        : null,
      validation: d.screens.filter((s) => s.review).map((s) => ({ screen: s.id, verdict: s.review.verdict, note: s.review.note })),
      screenEdits: d.screens.filter((s) => s.notes).map((s) => ({ screen: s.id, notes: s.notes })),
    };
  }

  markAnswersConsumed() {
    for (const q of this.data.questions) if (q.answer) q.consumed = true;
    this.save("agent");
  }
}
