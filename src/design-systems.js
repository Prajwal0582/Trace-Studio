// The two company design systems a designer can target. Fixed by design
// decision: Studio offers only these.
export const DESIGN_SYSTEMS = [
  {
    id: "v1",
    name: "V1 · Genie Material Design",
    short: "Salesgenie V1",
    fileKey: "6s0ANB0VAVkU6lhkwIQ8qs",
    url: "https://www.figma.com/design/6s0ANB0VAVkU6lhkwIQ8qs/Genie-Material-Design",
    tokens: "Colour, text and effect styles",
    notes: "Current product library. Some components are still being updated, so more elements may come out detached.",
  },
  {
    id: "v2",
    name: "V2 · Data Axle | Trust",
    short: "Salesgenie V2",
    fileKey: "KB3TjtDdxAyQkIgitCNWwm",
    url: "https://www.figma.com/design/KB3TjtDdxAyQkIgitCNWwm/Data-Axle-%7C-Trust",
    tokens: "Variables with Light, Dark, Indigo-Light and Indigo-Dark modes",
    notes: "New system with wide component coverage. V1-styled prototypes are rebuilt fully in V2.",
  },
];

export const designSystem = (id) => DESIGN_SYSTEMS.find((d) => d.id === id) || null;

// figma.com/design/<key>/... or /file/<key>/... (branch links use the branch key)
export function parseFigmaUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)figma\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(design|file)\/([0-9a-zA-Z]{15,128})(?:\/branch\/([0-9a-zA-Z]{15,128}))?/);
    if (!m) return null;
    const nodeId = u.searchParams.get("node-id");
    return { fileKey: m[3] || m[2], nodeId: nodeId ? nodeId.replace("-", ":") : null };
  } catch {
    return null;
  }
}
