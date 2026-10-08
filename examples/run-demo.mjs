// Drives Trace over MCP exactly like an AI agent would, for the demo prototype.
// Usage: npm run demo  (in another terminal), then  node examples/run-demo.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const c = new Client({ name: "trace-demo", version: "1" });
await c.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "bin/trace.js"), "serve"],
    cwd: path.join(root, "examples"),
    env: { ...process.env, TRACE_MAPPING: path.join(root, "examples/demo.mapping.json") },
  })
);
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const t = r.content.find((x) => x.type === "text")?.text || "";
  if (r.isError) throw new Error(t);
  console.log(`✓ ${name} ${args.name ? `"${args.name}${args.state ? " / " + args.state : ""}"` : args.action || ""}`);
  return t;
};
const api = "**/api/campaigns*";
await call("trace_start", { url: "http://localhost:4321", flowName: "Create campaign" });
await call("trace_capture", { name: "Campaign list" }); // s1
for (const [state, mock] of [
  ["loading", { hang: true }],
  ["empty", { body: [] }],
  ["error", { status: 500, body: { error: "boom" } }],
]) {
  await call("trace_mock_network", { urlPattern: api, ...mock });
  await call("trace_act", { action: "reload" });
  await call("trace_capture", { name: "Campaign list", state }); // s2..s4
  await call("trace_clear_mocks");
}
await call("trace_act", { action: "reload" });
await call("trace_act", { action: "click", role: "button", name: "New campaign" });
await call("trace_act", { action: "fill", selector: "#n", value: "Holiday promo" });
await call("trace_act", { action: "fill", selector: "#a", value: "Loyalty members" });
await call("trace_capture", { name: "New campaign", fromScreen: "s1" }); // s5
await call("trace_act", { action: "click", role: "button", name: "Save" });
await call("trace_capture", { name: "Campaign list", state: "after save" }); // s6
const plan = JSON.parse(await call("trace_build_plan"));
console.log(JSON.stringify({ stats: plan.stats, links: plan.links, review: plan.review }, null, 2));
const out = path.join(path.dirname(plan.planFile), "figma");
fs.mkdirSync(out, { recursive: true });
for (const s of plan.screens) {
  const r = JSON.parse(await call("trace_figma_script", { screenIds: [s.id] }));
  fs.writeFileSync(path.join(out, `${s.id}.js`), r.code);
}
console.log("Figma scripts →", out);
await call("trace_end");
await c.close();
