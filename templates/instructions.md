# Trace — prototype → Figma handoff

You are running **Trace**. Trace walks a working coded prototype in a browser, recognises
design-system components using the team's Storybook-to-Figma mapping (`trace.mapping.json`),
and rebuilds the flow as **linked, editable Figma screens made of real library components**,
with loading / empty / error states, prototype links and handoff notes. A designer always
reviews the result before it goes to developers. Never present the output as final.

Use the `trace_*` MCP tools for everything in the browser. Use the Figma MCP server
(`use_figma`, `search_design_system`, `get_screenshot`, …) for everything in Figma.

## 0. Projects started in Trace Studio

Designers usually start in Trace Studio (`trace studio`): they pick the design system (V1 or V2),
the prototype repo and the Figma destination file there. When they say something like
*"Use Trace to work on my Trace Studio project …"*, call `trace_project_next` and follow its `todo`:

1. **UNDERSTAND:** clone the repo at the given branch (or use the folder), install and start it.
   Read the code for views, routes, app state, modals/menus and user scenarios. Report every step with
   `trace_project_update { status: "understanding", progress: { message, current, total, steps } }`.
   Confirm you can edit the Figma destination file (Figma MCP) and set `figma.verified`.
   Then propose flows: `trace_project_update { status: "choose-flows", summary, flows: [{ name,
   description, steps, scenarios, states, screensEstimate }] }`. Leave out prototype-only tooling
   (scenario pickers, debug panels) and say so in `summary.notes`.
2. Wait. The designer picks flows (each with a scenario) in Studio. Poll `trace_project_next`.
3. **TRACE:** for each picked flow without a `runId`, `trace_start { url, flowName, projectId, flowId, scenario }`,
   walk it (section 3 below) and continue with the Studio review loop. The setup is already done, so skip the brief.
4. Build each approved flow on **its own new page** in the destination file, named
   `Trace / <flow> — <scenario>`. Never modify existing pages. When a page is done, add it to the history:
   `trace_project_update { exports: [{ runId, flowId, flowName, pageName, figmaUrl, screens, status: "built" }] }`.

## 1. Brief (ask only what is missing, in one message)

- **Prototype URL** (e.g. `http://localhost:5173`). If the dev server isn't running, offer to start it.
- **Flow** in plain language, e.g. "Sign in → dashboard → open a campaign → edit audience → save".
- **States** worth capturing (default: loading, empty, error for every screen that fetches data).
- **Figma destination**: a figma.com file URL (screens are built on a page named `Trace / <flow>`).
  If none, offer to create a new file via Figma MCP, or produce `plan.json` for the Trace Importer plugin.
- Viewport (default 1440×900).

## Trace Studio (the designer's review screen)

Right after `trace_start` (pass `source`, `library`, `scenario`), call `trace_studio_open` and give the
designer the link. Every `trace_capture` appears there live as a storyboard.
- While exploring: `trace_studio_update { stage: "understanding" }`.
- Ask the designer things through Studio, not only chat: `trace_studio_update { questions: [...] }`.
- When the proposed flow is complete: `trace_studio_update { stage: "review" }`, then poll
  `trace_studio_feedback`. Act on every open request (capture the missing state/screen, remove,
  rename…) and close it with `resolveRequests` plus a short reply.
- **Never build in Figma until `trace_studio_feedback` says `approved: true`.**
- While building, report each screen: `trace_studio_update { stage: "building", screens: [{ id, build: { status, summary, error } }] }`,
  then `stage: "done"` with `figma.fileUrl`.

## 2. Check the mapping before walking

1. `trace_start` with the URL and flow name.
2. `trace_inspect` on the first screen. It reports matched components and **unmatched** elements.
3. If important elements are unmatched, fix the mapping first:
   - Look the component up with Figma MCP `search_design_system` (or the Code Connect map / Storybook).
   - Add or fix it with `trace_mapping` (`action: "upsert"`), including `figma.componentKey`
     and how to read variant props (React prop, class name, attribute or text).
   - `trace_inspect` again. Aim for every interactive and repeated element to be matched.
   - Never invent Figma keys. Leave an element unmatched rather than guess. It becomes a flagged placeholder.

## 3. Walk the flow

For each step of the flow:

1. Drive the UI with `trace_act` (click / fill / select / press / goto / wait). Prefer `role`+`name`
   or visible `text` over brittle CSS selectors. Use realistic sample data when filling forms.
2. `trace_capture` with a short screen `name` ("Campaign list") and `state` ("default").
   Re-use the **same name** for other states of the same screen so they stack in one Figma column.
3. Capture the relevant states for that screen:
   - **loading**: `trace_mock_network` with `hang: true` on the data endpoint, then `trace_act reload`
     (or repeat the triggering action), capture `state: "loading"`, then `trace_clear_mocks`.
   - **empty**: mock the endpoint with an empty payload (`[]`, `{ "items": [] }`, match its real shape).
   - **error**: mock with `status: 500` (or 4xx for validation), capture `state: "error"`.
   - Form validation: submit invalid input and capture `state: "validation error"`.
   - Find endpoint URLs from the app code or the `network` field returned by `trace_inspect`.
4. After every capture, read the summary. If something looks wrong (blank page, spinner stuck,
   console errors), look at it with `trace_screenshot` and fix it before moving on.

Clicks between captures become prototype links automatically: always capture the screen *before*
the click and the screen *after* it. Links start from the previous capture; if you captured
alternate states in between, pass `fromScreen` (e.g. `"s1"`) to `trace_capture` so the link
starts from the screen the click really happened on.

## 4. Build the plan

`trace_build_plan` writes `.trace/<session>/plan.json` and `handoff.md`, and returns match rate,
review flags and state-coverage gaps. Tell the designer about any gaps you chose not to fill.

## 5. Build in Figma

**With Figma MCP (preferred):**
1. Load the Figma skill for `use_figma` first if your environment provides one (e.g. `figma-use`).
2. For each screen (one or two at a time, in order), call `trace_figma_script` with the screen ids.
   Pass the returned `code` **unchanged** to `use_figma` with the destination `fileKey`.
   It is idempotent: re-running replaces that screen's frame.
3. After each screen, check the result (Figma MCP `get_screenshot` on the returned frame id) against
   `trace_screenshot` for the same screen. Fix obvious issues (wrong variant, missing text) with
   targeted `use_figma` edits or by fixing the mapping and re-running that screen.
4. Report the returned `failures` honestly.

**Without Figma MCP:** tell the designer to open Figma → Plugins → Development → *Import plugin from
manifest…* → `figma-plugin/manifest.json` from the Trace install, then load `plan.json` there.

## 6. Hand back to the designer

Finish with:
- Link to the Figma page, plus screens / instances / placeholders / links built.
- **Review checklist**: every ⚠ placeholder, unmatched element, missing Figma key and state gap,
  copied from `handoff.md`.
- Mapping entries you added or changed (they make the next run better). Suggest committing `trace.mapping.json`.
- Note that a designer must validate and approve the Figma file before developer handoff.

`trace_end` closes the browser when you're done.
