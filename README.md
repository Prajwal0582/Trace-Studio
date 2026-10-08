# ▲ Trace

**AI-powered prototype → Figma handoff.**
Trace walks a working coded prototype, recognises your design-system components using
your Storybook-to-Figma mapping, and rebuilds the flow as **linked, editable Figma screens
made of real library components**. It covers loading / empty / error states, prototype
links, handoff notes, and flags anything it couldn't match. A designer reviews and
approves the output before developer handoff.

Trace doesn't come with its own AI. It plugs into the one you already use
(Cursor, Claude Code, VS Code Copilot, Windsurf, Codex, Claude Desktop) as an
**MCP server plus a playbook**. Your AI drives the browser through Trace and builds in
Figma through the Figma MCP server.

```
 "Trace the create-campaign flow at localhost:5173 into <figma url>"
                 │
        your AI tool (Cursor / Claude / Copilot …)
        ├── Trace MCP  ── headless browser → screens, states, components
        └── Figma MCP  ── use_figma → frames, library instances, links, notes
```

## Install

```bash
cd trace && npm install        # also downloads headless Chromium
npm link                       # puts `trace` on your PATH (optional)
```

Then, in the project that holds your prototype:

```bash
trace init
```

| Tool | What `trace init` writes | How to start |
|---|---|---|
| Cursor | `.cursor/mcp.json`, `.cursor/rules/trace.mdc` | Ask in Agent chat |
| Claude Code | `.mcp.json`, `.claude/skills/trace/` | `/trace` or just ask |
| VS Code Copilot | `.vscode/mcp.json`, `.github/prompts/trace.prompt.md` | `/trace` in Agent mode |
| Windsurf | `.windsurf/workflows/trace.md` (+ MCP with `--global`) | `/trace` |
| Codex, Zed, Aider … | `AGENTS.md` section (+ Codex MCP with `--global`) | Just ask |
| Claude Desktop | only with `--global` | Use the **trace** prompt |

`trace init` creates `trace.mapping.json` if it's missing, and merges into existing
config files without overwriting them. Run `trace doctor` to check the setup.

**Also connect the Figma MCP server** in your AI tool (Figma's official remote server,
or Dev Mode MCP). That's how the screens get built.

## The mapping (`trace.mapping.json`)

This file is the bridge between Storybook and Figma. Each entry says how to spot a
component in the running prototype and which Figma library component to place:

```jsonc
{
  "name": "Button",
  "storybookId": "inputs-button--contained",
  "match": {
    "react": ["Button", "LoadingButton"],     // React display names (read from the live component tree)
    "selectors": [".MuiButton-root"],         // CSS selectors
    "dataComponent": ["button"]               // data-component="button" / data-trace="button"
  },
  "figma": { "componentKey": "a1b2c3…" },     // published library component (or componentSetKey / nodeId)
  "props": {                                  // Figma property ← prototype value
    "Variant": { "source": "prop",  "key": "variant", "map": { "contained": "Contained" } },
    "State":   { "source": "state", "key": "disabled", "map": { "true": "Disabled" } },
    "Label":   { "source": "text" }
  }
}
```

Prop `source` can be `prop` (React prop), `attr`, `class` (regex `pattern`), `text`, or
`state` (disabled / error / selected / checked / expanded / focused / loading).

- Scaffold entries from Storybook: `trace storybook http://localhost:6006`
- Fill the Figma keys yourself, or let the agent look them up with Figma MCP
  `search_design_system` and save them with the `trace_mapping` tool.
- Commit the file. Each run makes the next one better.

## Trace Studio

The designer's review screen, served locally at `http://127.0.0.1:4747`. The agent opens it with
`trace_studio_open`, and every captured screen appears live:

- **Flow:** a storyboard. Steps run left to right, each screen's states stack under it, and arrows
  are labelled with the action ("Click 'Save list'"). Click a screen to inspect it, rename it, see
  what leads in and out, request changes, add a state, or remove it.
- **Questions:** Trace's questions appear at the top. Your answers go straight back to the agent.
- **Components:** every element on every screen with the proposed library component and your
  decision (library component / detached nearest / plain frames / skip).
- **Build:** live progress per screen while Trace builds in Figma.
- **Approve flow:** nothing is built in Figma until you approve.

Reopen a past run with `trace studio .trace/<session>`.

## What the agent does

1. **Brief**: prototype URL, the flow in plain words, the states you want, the Figma file.
2. **Check the mapping** with `trace_inspect` and fix gaps before walking the flow.
3. **Walk the flow** with `trace_act` and `trace_capture`. It forces loading / empty / error
   states by mocking API responses (`trace_mock_network`), so you don't need special builds.
4. **Plan**: `trace_build_plan` writes `.trace/<session>/plan.json` and `handoff.md`.
5. **Build in Figma**: `trace_figma_script` returns Plugin-API code that the agent runs
   through Figma MCP `use_figma`, one screen at a time, then checks each result against the
   prototype screenshot.
6. **Hand back** a review checklist: placeholders, unmatched elements, missing keys, state gaps.

### In Figma you get

- A page called `Trace / <flow>`. The happy path runs left → right, and each screen's
  states stack underneath it.
- Real **library instances** with variant props and text overrides applied.
- Loose text as text layers, and unmatched elements as **red dashed ⚠ placeholders**.
- **Prototype links** from the clicked element to the next screen.
- A yellow **handoff-notes panel** beside each frame: route, how each state is triggered,
  interactions, component list, review count.

### No Figma MCP?

Figma → Plugins → Development → *Import plugin from manifest…* → `figma-plugin/manifest.json`,
then load `plan.json`. It runs the same builder.

## MCP tools

| Tool | Purpose |
|---|---|
| `trace_start` | Open the prototype, load the mapping |
| `trace_inspect` | Dry-run component recognition; list unmatched elements and API endpoints |
| `trace_act` | click / fill / select / check / hover / press / scroll / wait / goto / back / reload |
| `trace_mock_network` / `trace_clear_mocks` | Force loading (`hang`), empty, and error states |
| `trace_capture` | Screenshot plus component structure for one screen state |
| `trace_screenshot` | View a captured screen (or the live page) |
| `trace_mapping` | List / upsert / remove mapping entries |
| `trace_build_plan` | Produce `plan.json` and `handoff.md` |
| `trace_figma_script` | Figma build code for chosen screens (for `use_figma`) |
| `trace_end` | Close the browser |

Prompt: `trace` (url, flow, figma) runs the whole playbook.

## Try it on the demo

```bash
npm run demo     # http://localhost:4321: a campaigns list with loading/empty/error + a create form
```

Then ask your AI: *"Trace the create-campaign flow at http://localhost:4321, including loading, empty and error states."*

## Settings

| Env var | Default | |
|---|---|---|
| `TRACE_MAPPING` | `./trace.mapping.json` | Mapping file path |
| `TRACE_OUT_DIR` | `./.trace` | Session output (screens, plan, handoff) |
| `TRACE_HEADLESS` | `true` | `false` opens a visible browser so you can watch |

## Limits (by design)

- Trace only places components that are in the mapping. Everything else becomes a flagged
  placeholder for the designer. It never guesses Figma keys.
- Matched components are placed at their prototype size and position (absolute layout),
  not rebuilt as auto-layout.
- The output is a draft for designer review, not a finished deliverable.
