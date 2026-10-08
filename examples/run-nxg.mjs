// Test run on the real NXG-NLP prototype (SalesGenie Smart Search), driving
// Trace over MCP the way an AI agent would. Scenario: New Freemium User.
// Usage: node examples/run-nxg.mjs [prototypeUrl]   (prototype must be running)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] || "http://localhost:5310";
const c = new Client({ name: "trace-nxg", version: "1" });
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
  console.log(`✓ ${name} ${args.name ? `"${args.name}${args.state ? " / " + args.state : ""}"` : args.action ? `${args.action} ${args.name || args.text || args.selector || ""}` : ""}`);
  return t;
};

const start = JSON.parse(
  await call("trace_start", {
    url,
    flowName: "Smart Search → Save list",
    source: "github.com/Prajwal0582/NXG-NLP",
    library: "V1 · Genie Material Design",
    scenario: "New Freemium User",
  })
);
await call("trace_studio_update", { stage: "understanding", log: "Exploring the prototype for scenario 'New Freemium User'" });

// Setup (not captured): pick the scenario on the prototype's launcher.
await call("trace_act", { action: "click", text: "Enter scenario" });
await call("trace_capture", { name: "Landing", state: "welcome modal" }); // s1

await call("trace_act", { action: "click", role: "button", name: "Get started" });
await call("trace_capture", { name: "Landing" }); // s2

await call("trace_act", { action: "fill", role: "textbox", name: "Describe the leads you want to find in natural language", value: "Dentists in Austin with more than 10 employees" });
await call("trace_act", { action: "press", key: "Enter" });
await call("trace_act", { action: "wait", ms: 2500 });
await call("trace_capture", { name: "Search results", fullPage: false }); // s3

await call("trace_act", { action: "click", role: "button", name: "Save list" });
await call("trace_capture", { name: "Search results", state: "save list · empty", fullPage: false }); // s4

await call("trace_act", { action: "fill", role: "textbox", name: "List name", value: "Austin dentists" });
await call("trace_capture", { name: "Search results", state: "save list · filled", fullPage: false }); // s5

await call("trace_act", { action: "click", selector: 'button:text-is("Save list") >> nth=-1' });
await call("trace_act", { action: "wait", ms: 1200 });
await call("trace_capture", { name: "Saved lists", fullPage: false }); // s6

// What the agent would do next: hand the flow to the designer with questions.
await call("trace_studio_update", {
  stage: "review",
  edges: [{ from: "s3", to: "s4", label: 'Click "Save list"' }],
  questions: [
    { text: "The results page also has a History drawer and a Purchase list flow. Add them to this flow?", options: ["Add History drawer", "Add Purchase flow", "Add both", "Neither"], screenId: "s3" },
    { text: "Include the 'Prompts exhausted' state for freemium users (shown after 20 searches)?", options: ["Yes", "No"] },
  ],
  log: "Flow ready for review: 6 screens across 3 steps",
});
console.log("Session folder:", start.outputDir);
await call("trace_end");
await c.close();
