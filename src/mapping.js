// Loads the Storybook-to-Figma component mapping (trace.mapping.json).
//
// A mapping entry tells Trace how to recognise a component in the running
// prototype and which Figma library component it corresponds to:
//
// {
//   "name": "Button",                       // canonical name
//   "storybookId": "inputs-button--primary", // optional, for traceability
//   "match": {
//     "react": ["Button", "LoadingButton"],  // React component display names
//     "selectors": [".MuiButton-root"],      // CSS selectors
//     "dataComponent": ["button"]            // data-component / data-trace values
//   },
//   "figma": { "componentKey": "abc123", "nodeId": "12:34", "fileKey": "XYZ" },
//   "props": {                               // Figma property <- prototype value
//     "Variant": { "source": "prop", "key": "variant", "map": { "contained": "Primary" } },
//     "Size":    { "source": "class", "pattern": "MuiButton-size(\\w+)" },
//     "Label":   { "source": "text" }
//   }
// }
import fs from "node:fs";
import path from "node:path";

export const MAPPING_FILENAMES = ["trace.mapping.json", ".trace/mapping.json"];

export function findMappingFile(cwd = process.cwd()) {
  if (process.env.TRACE_MAPPING) return path.resolve(cwd, process.env.TRACE_MAPPING);
  for (const name of MAPPING_FILENAMES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadMapping(file) {
  const p = file || findMappingFile();
  if (!p || !fs.existsSync(p)) {
    return { file: null, figmaFileKey: null, components: [] };
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const components = (raw.components || []).map(normalize);
  return { file: p, figmaFileKey: raw.figmaFileKey || null, components };
}

function normalize(c) {
  const match = c.match || {};
  return {
    name: c.name,
    storybookId: c.storybookId || null,
    match: {
      react: toArray(match.react),
      selectors: toArray(match.selectors),
      dataComponent: toArray(match.dataComponent).map((s) => s.toLowerCase()),
    },
    figma: c.figma || {},
    props: c.props || {},
    textLayers: c.textLayers || null,
  };
}

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// Scaffold mapping entries from a Storybook index.json (Storybook 7+) or
// stories.json (Storybook 6). Figma keys are left blank for the designer to fill
// (or for the agent to fill via Figma MCP search_design_system / Code Connect).
export async function scaffoldFromStorybook(storybookUrl) {
  const base = storybookUrl.replace(/\/$/, "");
  let data = null;
  for (const endpoint of ["/index.json", "/stories.json"]) {
    try {
      const res = await fetch(base + endpoint);
      if (res.ok) {
        data = await res.json();
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!data) throw new Error(`Could not read ${base}/index.json or /stories.json`);
  const entries = Object.values(data.entries || data.stories || {});
  const byComponent = new Map();
  for (const e of entries) {
    if (e.type && e.type !== "story") continue;
    const title = e.title || e.kind;
    const name = title.split("/").pop().replace(/\s+/g, "");
    if (!byComponent.has(name)) {
      byComponent.set(name, {
        name,
        storybookId: e.id,
        stories: [],
        match: { react: [name], selectors: [], dataComponent: [name.toLowerCase()] },
        figma: { componentKey: "", nodeId: "" },
        props: {},
      });
    }
    byComponent.get(name).stories.push(e.name);
  }
  return [...byComponent.values()];
}
