// Plays the AI tool's part for a project started in Trace Studio, using the
// real Trace MCP tools. For testing Studio end to end.
//   node examples/agent-sim.mjs understand   → progress + proposed flows
//   node examples/agent-sim.mjs trace        → traces the first picked flow
// The flow proposals are written by hand from reading NXG-NLP's code
// (src/types.ts views + ScenarioLaunchView scenarios). A real AI tool derives them itself.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const phase = process.argv[2] || "understand";
const c = new Client({ name: "agent-sim", version: "1" });
await c.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "bin/trace.js"), "serve"],
    cwd: path.join(root, "examples"),
    env: { ...process.env, TRACE_MAPPING: path.join(root, "examples/none.json") },
  })
);
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const t = r.content.find((x) => x.type === "text")?.text || "";
  if (r.isError) throw new Error(`${name}: ${t}`);
  return t;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const next = JSON.parse(await call("trace_project_next", process.env.PROJECT ? { projectId: process.env.PROJECT } : {}));
const proj = next.pending[0];
if (!proj) {
  console.log("Nothing pending");
  process.exit(0);
}
console.log("Picked up:", proj.name, proj.status, "→", proj.todo.split(":")[0]);
const id = proj.projectId;
const SCEN = ["New Freemium User", "Freemium — 5 Prompts Left", "Freemium — Prompts Exhausted", "New Subscriber", "Existing Subscriber", "Subscriber Using Credits", "Subscriber — Credits Exhausted"];

if (phase === "understand") {
  const steps = ["Get the prototype", "Install and start it", "Read screens, states and scenarios", "Check the Figma file and design system", "Propose flows"];
  const prog = (i, message) => ({
    message,
    current: i,
    total: steps.length,
    steps: steps.map((label, j) => ({ label, status: j < i ? "done" : j === i ? "doing" : "todo" })),
  });
  const msgs = [
    "Cloning github.com/Prajwal0582/NXG-NLP (main)…",
    "Installing dependencies and starting the prototype…",
    "Reading src/App.tsx: found 10 views and 7 user scenarios…",
    "Checking the Figma file and the V1 · Genie Material Design library…",
    "Grouping screens into flows…",
  ];
  for (let i = 0; i < steps.length; i++) {
    await call("trace_project_update", { projectId: id, status: "understanding", progress: prog(i, msgs[i]) });
    console.log("progress", i + 1, "/", steps.length);
    await wait(Number(process.env.STEP_MS || 2500));
  }
  await call("trace_project_update", {
    projectId: id,
    status: "choose-flows",
    progress: null,
    figma: { verified: true, fileName: "Trace demo — Create campaign" },
    summary: { views: 10, scenarios: SCEN, prototypeUrl: "http://localhost:5310", notes: "The prototype starts on a scenario picker. That's a prototype tool, so it's left out of the flows." },
    flows: [
      { name: "Smart search → save a list", description: "Ask in plain language, review results, save them as a list.", steps: ["Landing", "Search results", "Save list", "Saved lists"], scenarios: SCEN, screensEstimate: 7, states: ["Welcome modal", "Save list — empty", "Save list — filled", "Error"] },
      { name: "Buy a lead list", description: "From results, purchase the list and see the confirmation.", steps: ["Search results", "Purchase", "Purchase success"], scenarios: ["Subscriber Using Credits", "Existing Subscriber", "New Freemium User"], screensEstimate: 5, states: ["Credit confirmation", "Credits exhausted"] },
      { name: "Upgrade to a plan", description: "Hit the prompt limit, compare plans and check out.", steps: ["Landing", "Plans", "Subscription checkout"], scenarios: ["Freemium — Prompts Exhausted", "Freemium — 5 Prompts Left"], screensEstimate: 5, states: ["Monthly / annual", "Card error"] },
      { name: "Manual search", description: "Build a search with filters instead of a prompt.", steps: ["Landing", "Manual search", "Search results"], scenarios: SCEN, screensEstimate: 4, states: ["Empty", "Filters applied"] },
      { name: "Search history", description: "Open History and reopen an earlier conversation.", steps: ["Search results", "History drawer", "Search results"], scenarios: ["Existing Subscriber", "New Freemium User"], screensEstimate: 3, states: ["No history yet"] },
      { name: "Saved lists", description: "Browse saved lists and open one.", steps: ["Saved lists", "List detail"], scenarios: SCEN, screensEstimate: 3, states: ["Empty", "Save-list education tour"] },
    ],
    log: "Found 10 screens, 7 scenarios and 6 flows",
  });
  console.log("Proposed 6 flows. Waiting for the designer to pick in Studio.");
}

if (phase === "trace") {
  const flow = proj.pickedFlows.find((f) => !f.runId);
  if (!flow) {
    console.log("No picked flow waiting");
    process.exit(0);
  }
  console.log("Tracing", flow.name, "·", flow.scenario);
  await call("trace_start", { url: "http://localhost:5310", flowName: `${flow.name} — ${flow.scenario}`, projectId: id, flowId: flow.id, scenario: flow.scenario });
  await call("trace_studio_update", { stage: "understanding", progress: { message: `Entering scenario “${flow.scenario}”…`, current: 0, total: 6 } });
  const idx = SCEN.indexOf(flow.scenario);
  await call("trace_act", { action: "click", selector: `:nth-match(:text("Enter scenario"), ${idx + 1})` });
  await call("trace_capture", { name: "Landing", state: "welcome modal" });
  await call("trace_studio_update", { progress: { message: "Captured the welcome modal", current: 1, total: 6 } });
  await call("trace_act", { action: "click", role: "button", name: "Get started" });
  await call("trace_capture", { name: "Landing" });
  await call("trace_act", { action: "fill", role: "textbox", name: "Describe the leads you want to find in natural language", value: "Dentists in Austin with more than 10 employees" });
  await call("trace_act", { action: "press", key: "Enter" });
  await call("trace_act", { action: "wait", ms: 2500 });
  await call("trace_capture", { name: "Search results", fullPage: false });
  await call("trace_studio_update", { progress: { message: "Captured search results", current: 3, total: 6 } });
  await call("trace_act", { action: "click", role: "button", name: "Save list" });
  await call("trace_capture", { name: "Search results", state: "save list · empty", fullPage: false });
  await call("trace_act", { action: "fill", role: "textbox", name: "List name", value: "Austin dentists" });
  await call("trace_capture", { name: "Search results", state: "save list · filled", fullPage: false });
  await call("trace_act", { action: "click", selector: 'button:text-is("Save list") >> nth=-1' });
  await call("trace_act", { action: "wait", ms: 1200 });
  await call("trace_capture", { name: "Saved lists", fullPage: false });
  await call("trace_studio_update", {
    stage: "review",
    progress: null,
    suggestions: [{ screenId: "s3", state: "Error", reason: "the search request can fail" }],
    log: "Flow ready for review",
  });
  console.log("Flow captured and ready for review in Studio");
  await call("trace_end");
}
await c.close();
