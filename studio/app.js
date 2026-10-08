// Trace Studio front end. Plain JS, no build step.
// Routes:  #/runs  ·  #/run/<id>/<flow|components|build|history>[/<screenId>]
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  const STAGES = [
    { id: "understanding", label: "Understand" },
    { id: "review", label: "Review" },
    { id: "building", label: "Build" },
    { id: "done", label: "Done" },
  ];
  const DECISIONS = [
    ["component", "Library component"],
    ["detached", "Detached nearest"],
    ["frames", "Plain frames"],
    ["skip", "Skip"],
    ["undecided", "Not decided"],
  ];
  const QUICK_STATES = ["Loading", "Empty", "Error", "Validation error", "Dropdown open", "Modal open", "Hover", "Disabled", "Success"];
  // Plain-language names for raw HTML tags found on a screen.
  const ROLE_NAMES = {
    button: "Button", a: "Link", input: "Text field", textarea: "Text area", select: "Dropdown", img: "Image",
    svg: "Icon", table: "Table", canvas: "Chart", video: "Video", iframe: "Embed", div: "Container",
    span: "Text", nav: "Navigation", header: "Header", footer: "Footer", main: "Main area", li: "List item",
    label: "Label", form: "Form", aside: "Side panel", section: "Section",
  };
  const MEANINGFUL = new Set(["button", "a", "input", "textarea", "select", "img", "table", "canvas", "video", "iframe"]);

  const S = {
    runs: [], active: null, runId: null, run: null,
    tab: "flow", screenId: null, compareId: null,
    zoom: 1, todoOpen: window.innerWidth > 900, showAll: false, overlays: true, fitShot: true,
    compFilter: "all", compShowAll: false, openGroups: new Set(), cmpMode: "side", cmpOpacity: 50,
    dragId: null, dragStep: null, pending: false, lastQuestionCount: 0,
    route: "home", home: null, project: null, projectRuns: [], projectId: null, runProject: null,
    newStep: 1, checks: {}, flowPicks: new Map(), custom: [], homeTab: "projects",
  };

  // ------------------------------------------------------------ data
  async function api(path) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  }
  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: S.runId, ...body }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || "Something went wrong");
      throw new Error(data.error);
    }
    return data;
  }
  async function loadHome() {
    S.home = await api("/api/home");
    S.engine = S.home.engine;
    S.connect = S.home.connect;
    S.runs = S.home.runs;
    S.active = S.home.active;
  }
  async function loadProject(id = S.projectId) {
    if (!id) return;
    const d = await api(`/api/project?id=${encodeURIComponent(id)}`);
    S.project = d.project;
    S.engine = d.engine;
    S.projectRuns = d.runs;
    S.designSystems = d.designSystems;
    S.connect = d.connect;
  }
  async function loadRun() {
    if (!S.runId) return;
    S.run = await api(`/api/run?id=${encodeURIComponent(S.runId)}`);
    S.run.stepOrder ||= [];
    S.run.suggestions ||= [];
    const qn = S.run.questions.filter((q) => !q.answer).length;
    if (qn > S.lastQuestionCount) announce(`Trace has ${qn} question${qn > 1 ? "s" : ""} for you`);
    S.lastQuestionCount = qn;
    const pid = S.run.project?.projectId;
    S.runProject = pid ? await api(`/api/project?id=${encodeURIComponent(pid)}`).catch(() => null) : null;
  }
  function connect() {
    const es = new EventSource("/api/events");
    // Studio restarted with new code (e.g. npm run studio:live pulled an update): reload.
    es.addEventListener("hello", (ev) => {
      const { boot } = JSON.parse(ev.data || "{}");
      if (S.boot && boot && boot !== S.boot) location.reload();
      S.boot ||= boot;
    });
    es.addEventListener("change", async (ev) => {
      const { kind, id } = JSON.parse(ev.data || "{}");
      const before = S.project?.status;
      if (S.route === "run" && kind === "run" && id === S.runId) await loadRun();
      if (S.route === "project" && (kind === "project" ? id === S.projectId : true)) {
        try {
          await loadProject();
        } catch {
          location.hash = "#/";
          return;
        }
      }
      if (S.route === "home") await loadHome();
      if (S.route === "project" && before && S.project?.status !== before) announce(statusText(S.project).title);
      if (S.route !== "new") render();
    });
    es.onopen = () => ($("live").hidden = true);
    es.onerror = () => ($("live").hidden = false);
  }
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), 2600);
  }
  function announce(msg) {
    $("announcer").textContent = "";
    setTimeout(() => ($("announcer").textContent = msg), 50);
  }

  // ------------------------------------------------------------ routing
  //   #/  · #/exports · #/new/<projectId>/<step> · #/project/<id>[/history] · #/run/<id>/<tab>[/<screen>]
  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "run" && parts[1]) return { route: "run", runId: parts[1], tab: parts[2] || "flow", screenId: parts[3] || null };
    if (parts[0] === "project" && parts[1]) return { route: "project", projectId: parts[1], tab: parts[2] || "flows" };
    if (parts[0] === "new") return { route: "new", projectId: parts[1] || null, step: Number(parts[2]) || 1 };
    return { route: "home", tab: parts[0] === "exports" ? "exports" : "projects" };
  }
  const routeTo = (tab = S.tab, screenId = null, runId = S.runId) =>
    (location.hash = `#/run/${encodeURIComponent(runId)}/${tab}${screenId ? "/" + encodeURIComponent(screenId) : ""}`);
  async function onRoute() {
    const r = parseRoute();
    S.route = r.route;
    if (r.route !== "run") S.screenId = S.compareId = null;
    if (r.route === "home") {
      S.homeTab = r.tab;
      S.runId = null;
      await loadHome();
      return render();
    }
    if (r.route === "new") {
      if (!r.projectId) {
        const p = await post("/api/project/create", {});
        return location.replace(`#/new/${encodeURIComponent(p.id)}/1`);
      }
      S.projectId = r.projectId;
      S.newStep = r.step;
      await loadProject();
      render();
      return focusFirst("#view-new");
    }
    if (r.route === "project") {
      const changed = S.projectId !== r.projectId;
      S.projectId = r.projectId;
      S.projTab = r.tab;
      if (changed) S.flowPicks = new Map();
      await loadProject().catch(() => toast("Project not found"));
      return render();
    }
    const runChanged = r.runId !== S.runId;
    S.runId = r.runId;
    S.tab = r.tab || "flow";
    S.screenId = r.tab === "flow" ? r.screenId : null;
    S.compareId = r.tab === "build" ? r.screenId : null;
    if (runChanged) {
      S.run = null;
      S.zoom = 1;
      await loadRun().catch(() => toast("Run not found"));
    }
    render();
    if (runChanged && S.tab === "flow" && S.run) requestAnimationFrame(() => fitIfLarge());
  }
  const focusFirst = (sel) => requestAnimationFrame(() => document.querySelector(`${sel} h2`)?.focus());

  // ------------------------------------------------------------ model helpers
  const run = () => S.run;
  const shot = (p) => (p ? `/shots/${encodeURIComponent(S.runId)}/${p.split("/").map(encodeURIComponent).join("/")}` : "");
  const isDefault = (s) => !s.state || s.state === "default";
  const stateLabel = (s) => (isDefault(s) ? "Main screen" : cap(s.state));
  const title = (s) => (isDefault(s) ? s.name : `${s.name} — ${cap(s.state)}`);
  const byId = (id) => run().screens.find((x) => x.id === id);
  const live = () => run().screens.filter((s) => s.status !== "removed");
  const openReqs = () => run().requests.filter((r) => r.status === "open");
  const unanswered = () => run().questions.filter((q) => !q.answer);
  const openSuggestions = () => run().suggestions.filter((g) => g.status === "open");
  const matchingDone = () => run().matching === "done" || run().screens.some((s) => (s.elements || []).some((e) => e.proposed));
  const kindOf = (e) => e.proposed?.component || ROLE_NAMES[e.role] || (/^[A-Z]/.test(e.role || "") ? e.role : cap(e.role || "Element"));
  // Element names: raw tag names ("img", "div") read as their kind instead.
  const elName = (e) => (!e.label || e.label === e.role ? kindOf(e) : e.label);
  const meaningful = (e) => !!e.proposed || MEANINGFUL.has(e.role) || /^[A-Z]/.test(e.role || "");

  function columns() {
    const r = run();
    const cols = [];
    const seen = [];
    r.screens.forEach((s, i) => {
      s._i = i;
      if (!seen.includes(s.step)) seen.push(s.step);
    });
    const order = [...r.stepOrder.filter((st) => seen.includes(st)), ...seen.filter((st) => !r.stepOrder.includes(st))];
    for (const step of order) {
      const screens = r.screens.filter((s) => s.step === step);
      screens.sort((a, b) => {
        if (a.order != null || b.order != null) return (a.order ?? 1e6 + a._i) - (b.order ?? 1e6 + b._i);
        return (isDefault(b) ? 1 : 0) - (isDefault(a) ? 1 : 0) || a._i - b._i;
      });
      cols.push({ step, screens });
    }
    return cols;
  }
  const flatOrder = () => columns().flatMap((c) => c.screens);

  function todos() {
    const r = run();
    const undecided = matchingDone() ? live().flatMap((s) => s.elements.filter((e) => meaningful(e) && e.decision === "undecided")) : [];
    const toValidate = ["building", "done"].includes(r.stage) ? live().filter((s) => s.build?.status === "built" && !s.review) : [];
    const count = unanswered().length + openSuggestions().length + (undecided.length ? 1 : 0) + toValidate.length;
    return { questions: unanswered(), suggestions: openSuggestions(), undecided, toValidate, waiting: openReqs(), count };
  }

  // ------------------------------------------------------------ render
  function render() {
    const inRun = S.route === "run" && !!S.run;
    renderEngine();
    $("tabs").hidden = $("runActions").hidden = $("stepper").hidden = !inRun;
    $("runHead").hidden = !(inRun || (S.route === "project" && S.project));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    if (S.route === "home") {
      document.title = "Trace Studio";
      $("view-home").classList.add("active");
      return renderHome();
    }
    if (S.route === "new") {
      document.title = "New project · Trace Studio";
      $("view-new").classList.add("active");
      return renderNew();
    }
    if (S.route === "project") {
      $("view-project").classList.add("active");
      return renderProject();
    }
    if (!inRun) return;
    renderChrome();
    $(`view-${S.tab}`)?.classList.add("active");
    if (S.tab === "flow") renderFlow();
    if (S.tab === "components") renderComponents();
    if (S.tab === "build") renderBuild();
    if (S.tab === "history") renderHistory();
  }

  function renderChrome() {
    const r = run();
    const p = r.project || {};
    $("runTitle").textContent = p.flowName || r.id;
    document.title = `${p.flowName || "Run"} · Trace Studio`;
    const proj = S.runProject?.project;
    const siblings = (S.runProject?.runs || []).filter((x) => x.id !== r.id);
    $("crumbs").innerHTML = `<a href="#/">Projects</a>${proj ? ` › <a href="#/project/${encodeURIComponent(proj.id)}">${esc(proj.name)}</a>` : ""}${
      siblings.length
        ? ` › <label class="sr-only" for="flowSwitch">Switch flow</label><select id="flowSwitch" class="flow-switch"><option selected>${esc(p.flowName)}</option>${siblings.map((x) => `<option value="${esc(x.id)}">${esc(x.flowName)}</option>`).join("")}</select>`
        : ""
    }`;
    $("runMeta").innerHTML = [
      p.library && `<span title="Design system">${esc(p.library)}</span>`,
      p.scenario && `<span title="Prototype scenario">${esc(p.scenario)}</span>`,
      p.source && `<span title="Prototype: ${esc(p.source)}">${esc(p.source.replace(/^https?:\/\/(www\.)?/, ""))}</span>`,
      r.figma?.fileUrl && `<a href="${esc(r.figma.fileUrl)}" target="_blank" rel="noopener">Figma file ↗</a>`,
    ].filter(Boolean).join('<span class="sep" aria-hidden="true">·</span>');

    const stage = r.stage === "approved" ? "building" : r.stage;
    const idx = STAGES.findIndex((s) => s.id === stage);
    // One pill that says where the flow is, instead of a stepper that repeats the tabs.
    const STAGE_TEXT = { understanding: "Trace is mapping the flow", review: "Your review", building: "Building in Figma", done: "Built in Figma" };
    $("stepper").innerHTML = `<li class="stage-pill ${stage}" title="${STAGES.map((s, i) => `${i + 1}. ${s.label}`).join("  ")}"><span class="n" aria-hidden="true">${stage === "done" ? "✓" : idx + 1}</span>${
      stage === "done" ? "" : `<span class="of">Step ${idx + 1} of ${STAGES.length} ·</span> `
    }${STAGE_TEXT[stage] || STAGES[idx]?.label || ""}</li>`;

    for (const a of document.querySelectorAll(".tabs a")) {
      a.href = `#/run/${encodeURIComponent(S.runId)}/${a.dataset.tab}`;
      if (a.dataset.tab === S.tab) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    $("cFlow").textContent = live().length || "";
    const t = todos();
    const und = t.undecided.length;
    $("cComp").textContent = und ? `${und} to decide` : "";
    $("cComp").classList.toggle("alert", und > 0);
    $("cBuild").textContent = ["approved", "building", "done"].includes(r.stage) ? `${live().filter((s) => s.build?.status === "built").length}/${live().length}` : "";

    $("todoCount").textContent = t.count || "";
    $("todoCount").classList.toggle("alert", t.count > 0);
    $("todoBtn").setAttribute("aria-expanded", String(S.todoOpen && S.tab === "flow" && !S.screenId));

    const btn = $("approveBtn");
    if (["approved", "building", "done"].includes(r.stage)) {
      btn.disabled = true;
      $("approveWhy").textContent = "";
      btn.textContent = r.stage === "done" ? "Built ✓" : "Approved ✓";
      btn.title = "";
    } else {
      const blockers = unanswered().length + openReqs().length;
      btn.textContent = "Approve flow";
      btn.disabled = r.stage !== "review" || blockers > 0 || !live().length;
      $("approveWhy").classList.toggle("linklike", unanswered().length > 0);
      $("approveWhy").textContent = !btn.disabled
        ? ""
        : r.stage === "understanding"
          ? "Waiting for Trace to finish mapping the flow"
          : blockers
            ? `${unanswered().length ? `${unanswered().length} question${unanswered().length > 1 ? "s" : ""} to answer` : ""}${unanswered().length && openReqs().length ? " · " : ""}${openReqs().length ? `${openReqs().length} change${openReqs().length > 1 ? "s" : ""} in progress` : ""}`
            : "No screens yet";
      btn.title =
        r.stage === "understanding"
          ? "Trace is still mapping the flow"
          : blockers
            ? `Answer ${unanswered().length} question(s) and wait for ${openReqs().length} request(s) first`
            : "Review what will be built, then approve";
    }
  }

  // Link to a screen's built frame in Figma, else to the flow's page or file.
  function figmaLink(s) {
    const f = S.run?.figma || {};
    if (s?.build?.url) return s.build.url;
    const key = f.fileKey || f.fileUrl?.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/)?.[1];
    if (s?.build?.nodeId && key) return `https://www.figma.com/design/${key}/?node-id=${encodeURIComponent(s.build.nodeId.replace(/:/g, "-"))}`;
    return f.pageUrl || f.fileUrl || null;
  }

  // ---------------- home: projects + export history
  const dsName = (id) => (S.home?.designSystems || S.designSystems || []).find((d) => d.id === id)?.short || (id ? id.toUpperCase() : "—");
  const engineOn = () => !!S.engine?.connected;
  const bar = (label, pct) =>
    pct == null
      ? `<div class="progress indeterminate" role="progressbar" aria-label="${esc(label)}" aria-valuetext="In progress"><div></div></div>`
      : `<div class="progress" role="progressbar" aria-label="${esc(label)}" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>`;
  // What the AI tool is doing right now, in words (shown in the run's tab bar).
  const ACTIVITY = {
    trace_start: "opening the prototype", trace_act: "clicking through the prototype", trace_capture: "capturing a screen",
    trace_inspect: "reading a screen", trace_screenshot: "checking a screen", trace_mock_network: "setting up a state",
    trace_clear_mocks: "setting up a state", trace_mapping: "matching components", trace_build_plan: "planning the build",
    trace_figma_script: "building in Figma", trace_studio_update: "updating Studio", trace_studio_feedback: "reading your feedback",
    trace_studio_open: "opening Studio", trace_project_next: "picking up the project", trace_project_update: "working on the project",
    trace_end: "finishing up",
  };
  function engineStatusHtml() {
    const e = S.engine;
    if (!e?.connected) return `<span class="engine-chip off" title="Start your AI tool with Trace connected, then ask it to stay connected to Trace Studio."><span class="dot" aria-hidden="true"></span>No AI tool connected</span>`;
    const who = esc(e.client || "AI tool");
    const ago = e.lastActive ? Date.now() - new Date(e.lastActive).getTime() : Infinity;
    if (e.listening) return `<span class="engine-chip on"><span class="dot" aria-hidden="true"></span>${who} · waiting for you</span>`;
    if (ago < 30000) return `<span class="engine-chip on busy"><span class="spinner sm" aria-hidden="true"></span>${who} · ${esc(ACTIVITY[e.lastTool] || "working")}</span>`;
    return `<span class="engine-chip idle" title="Connected, but not doing anything. Ask it to keep working or to stay connected to Trace Studio."><span class="dot" aria-hidden="true"></span>${who} · idle${e.lastActive ? ` since ${esc(timeAgo(e.lastActive))}` : ""}</span>`;
  }
  const renderEngine = () => {
    const el = $("engineStatus");
    if (el) el.innerHTML = engineStatusHtml();
  };
  const engineChip = () =>
    engineOn()
      ? `<span class="engine-chip on"><span class="dot" aria-hidden="true"></span>AI tool ${S.engine.listening ? "listening" : "connected"}${S.engine.client ? ` · ${esc(S.engine.client)}` : ""}</span>`
      : `<span class="engine-chip off"><span class="dot" aria-hidden="true"></span>No AI tool connected</span>`;
  const connectHelp = () => {
    const c = S.connect || {};
    return `<ol class="steps-list">
      <li><b>Once:</b> add Trace to your AI tool. Claude Code (works in every folder):
        <div class="copy-row"><code id="connectCmd">${esc(c.claude || "")}</code><button class="btn sm" data-act="copy" data-target="connectCmd">Copy</button></div>
        <details class="other-tools"><summary>Using Cursor, VS Code, Windsurf, Codex or Claude Desktop?</summary>
          <p class="muted">Run <code>trace init</code> in your project folder, or add this MCP server to the tool's config:</p>
          <div class="copy-row"><code id="connectJson">${esc(c.mcpJson || "")}</code><button class="btn sm" data-act="copy" data-target="connectJson">Copy</button></div></details></li>
      <li>Make sure the <b>Figma</b> connector is signed in in that tool.</li>
      <li>Start a <b>new</b> session in that tool and send this once. It then keeps listening to Studio, so everything you do here reaches it:
        <div class="copy-row"><code id="listenPrompt">${esc(c.prompt || "")}</code><button class="btn sm" data-act="copy" data-target="listenPrompt">Copy</button></div></li></ol>`;
  };
  function statusText(p) {
    const picked = p.flows.filter((f) => f.selected);
    return (
      {
        draft: { badge: "", title: "Setup not finished", body: "Pick a design system, the prototype and the Figma file." },
        queued: { badge: "state", title: "Waiting for Trace", body: "Trace will start exploring the prototype." },
        understanding: { badge: "state", title: "Trace is exploring", body: p.progress?.message || "Reading the prototype…" },
        "choose-flows": { badge: "warn", title: "Pick the flows", body: `Trace found ${p.flows.length} flow${p.flows.length === 1 ? "" : "s"}.` },
        tracing: { badge: "ok", title: `${picked.length} flow${picked.length === 1 ? "" : "s"} in progress`, body: "" },
        failed: { badge: "bad", title: "Trace hit a problem", body: p.error || "" },
      }[p.status] || { badge: "", title: p.status, body: "" }
    );
  }
  function renderHome() {
    const h = S.home;
    const tab = S.homeTab;
    const projects = h.projects;
    const loose = h.runs.filter((r) => !r.projectId);
    const cards = projects
      .map((p) => {
        const st = statusText(p);
        const href = p.status === "draft" ? `#/new/${encodeURIComponent(p.id)}/1` : `#/project/${encodeURIComponent(p.id)}`;
        const runs = h.runs.filter((r) => r.projectId === p.id);
        const cover = runs[0]?.cover ? `/shots/${encodeURIComponent(runs[0].id)}/${runs[0].cover.split("/").map(encodeURIComponent).join("/")}` : "";
        return `<a class="run-card" href="${href}">
          <div class="cover ${cover ? "" : "placeholder"}" style="${cover ? `background-image:url('${cover}')` : ""}">${cover ? "" : `<span>${esc(p.name.slice(0, 1).toUpperCase())}</span>`}</div>
          <div class="body">
            <div class="name">${esc(p.name)}</div>
            <div class="row">${p.paused ? '<span class="badge warn">Paused</span>' : ""}<span class="badge ${st.badge}">${esc(st.title)}</span></div>
            <div class="row">${p.designSystem ? `<span class="chip">${esc(dsName(p.designSystem))}</span>` : ""}${p.repo.url ? `<span class="chip" title="${esc(p.repo.url)}">${esc(p.repo.url.replace(/^https?:\/\/(www\.)?github\.com\//, ""))}</span>` : ""}</div>
            <div class="muted" style="font-size:12px">${runs.length ? `${runs.length} flow${runs.length > 1 ? "s" : ""} · ` : ""}Updated ${esc(timeAgo(p.updatedAt))}</div>
          </div></a>`;
      })
      .join("");
    const exportsRows = h.exports
      .map(
        (x) => `<tr>
          <td>${esc(new Date(x.at).toLocaleDateString([], { day: "numeric", month: "short" }))} <span class="muted">${esc(new Date(x.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</span></td>
          <td>${x.runId ? `<a href="#/run/${encodeURIComponent(x.runId)}/build">${esc(x.flowName)}</a>` : esc(x.flowName)}</td>
          <td>${x.projectId ? `<a href="#/project/${encodeURIComponent(x.projectId)}">${esc(x.projectName || "—")}</a>` : '<span class="muted">—</span>'}</td>
          <td>${esc(x.designSystem ? dsName(x.designSystem) : x.library || "—")}</td>
          <td>${x.built != null ? `${x.built}/${x.screens}` : esc(x.screens ?? "—")}</td>
          <td>${x.figmaUrl ? `<a href="${esc(x.figmaUrl)}" target="_blank" rel="noopener">${esc(x.pageName || "Open in Figma")} ↗</a>` : '<span class="muted">—</span>'}</td>
          <td><span class="badge ${x.status === "built" ? "ok" : x.status === "failed" ? "bad" : "state"}">${esc(cap(x.status || "built"))}</span></td>
        </tr>`
      )
      .join("");
    $("view-home").innerHTML = `<div class="page">
      <div class="home-head"><div><h2 tabindex="-1">Trace Studio</h2><p class="lead">Turn a coded prototype into editable Figma screens built from your design system.</p></div>
        <div class="home-actions"><a class="btn primary lg" href="#/new">+ New project</a></div></div>
      <nav class="subtabs" aria-label="Home sections">
        <a href="#/" ${tab === "projects" ? 'aria-current="page"' : ""}>Projects <span class="pill">${projects.length || ""}</span></a>
        <a href="#/exports" ${tab === "exports" ? 'aria-current="page"' : ""}>Export history <span class="pill">${h.exports.length || ""}</span></a>
      </nav>
      ${
        tab === "projects"
          ? `${cards ? `<div class="runs-grid">${cards}</div>` : `<div class="empty-state"><div class="big">No projects yet</div><p>Start with your design system, your prototype's repository and the Figma file to build into.</p><a class="btn primary" href="#/new">+ New project</a></div>`}
             ${loose.length ? `<h3 class="section-title">Flows traced from your AI tool <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">· not part of a project</span></h3><div class="runs-grid">${loose.map(looseCard).join("")}</div>` : ""}`
          : exportsRows
            ? `<div class="table-wrap"><table class="table"><caption class="sr-only">Everything Trace has built in Figma</caption>
                <thead><tr><th scope="col">When</th><th scope="col">Flow</th><th scope="col">Project</th><th scope="col">Design system</th><th scope="col">Screens</th><th scope="col">Figma page</th><th scope="col">Status</th></tr></thead>
                <tbody>${exportsRows}</tbody></table></div>`
            : `<div class="empty-state"><div class="big">Nothing exported yet</div><p>Every flow Trace builds in Figma shows up here with a link to its page.</p></div>`
      }</div>`;
  }
  const looseCard = (r) => `<a class="run-card" href="#/run/${encodeURIComponent(r.id)}/flow">
      <div class="cover" style="background-image:url('${r.cover ? `/shots/${encodeURIComponent(r.id)}/${r.cover.split("/").map(encodeURIComponent).join("/")}` : ""}')"></div>
      <div class="body"><div class="name">${esc(r.flowName)}</div>
        <div class="row">${stageBadge(r.stage)}${r.active ? '<span class="badge ok">Live session</span>' : ""}</div>
        <div class="row muted">${r.screens} screens · ${r.steps} steps</div>
        <div class="muted" style="font-size:12px">Updated ${esc(timeAgo(r.updatedAt))}</div></div></a>`;

  // ---------------- new project: 3-step setup
  const NEW_STEPS = ["Design system", "Prototype", "Figma file"];
  // Re-rendering replaces inputs; keep whatever the designer is typing,
  // where the cursor is, and focus.
  function renderNew() {
    const a = document.activeElement;
    const keep = a && a.id && $("view-new").contains(a) ? { id: a.id, value: a.value, start: a.selectionStart, end: a.selectionEnd } : null;
    renderNewInner();
    if (keep) {
      const el = $(keep.id);
      if (!el) return;
      if (el.type !== "radio" && keep.value != null) el.value = keep.value;
      el.focus();
      try {
        el.setSelectionRange(keep.start, keep.end);
      } catch {
        /* not a text field */
      }
    }
  }
  function renderNewInner() {
    const p = S.project;
    if (!p) return;
    const step = Math.min(3, Math.max(1, S.newStep));
    const dss = S.designSystems || [];
    const c = S.checks;
    const err = (k) => (c[k]?.error ? `<p class="field-error" id="${k}Err" role="alert">${esc(c[k].error)}</p>` : "");
    let body = "";
    if (step === 1) {
      body = `<fieldset class="choice-grid" aria-describedby="dsErr"><legend class="step-q">Which design system should the screens use?</legend>
        ${dss
          .map(
            (d) => `<label class="choice ${p.designSystem === d.id ? "checked" : ""}">
              <input type="radio" name="ds" value="${d.id}" ${p.designSystem === d.id ? "checked" : ""} />
              <span class="choice-title">${esc(d.name)}</span>
              <span class="choice-sub">${esc(d.tokens)}</span>
              <span class="choice-note">${esc(d.notes)}</span>
              <a href="${esc(d.url)}" target="_blank" rel="noopener" class="choice-link">View library ↗</a>
            </label>`
          )
          .join("")}</fieldset>${err("ds")}`;
    } else if (step === 2) {
      const chk = c.repo;
      body = `<div class="step-q" id="repoQ">Where is the prototype?</div>
        <div class="field big"><label for="wRepo">GitHub repository (or a folder on this computer)</label>
          <div class="input-row"><input id="wRepo" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://github.com/your-org/prototype" value="${esc(p.repo.url)}" aria-describedby="repoHelp repoErr repoOk" />
          <button class="btn" data-act="check-repo" type="button">${chk?.loading ? '<span class="spinner" aria-hidden="true"></span> Checking' : "Check"}</button></div>
          <span class="help" id="repoHelp">Trace clones it, installs it and runs it on your computer.</span></div>
        ${chk?.ok ? `<p class="field-ok" id="repoOk" role="status">✓ ${chk.kind === "folder" ? "Folder found" : `Repository found · default branch <b>${esc(chk.defaultBranch)}</b>`}</p>` : ""}${err("repo")}
        <div class="row2">
          <label class="field" for="wBranch">Branch<input id="wBranch" list="branchList" placeholder="${esc(chk?.defaultBranch || "main")}" value="${esc(p.repo.branch)}" />
            <datalist id="branchList">${(chk?.branches || []).map((b) => `<option value="${esc(b)}">`).join("")}</datalist></label>
          <label class="field" for="wName">Project name<input id="wName" value="${esc(p.name === "Untitled project" ? "" : p.name)}" placeholder="e.g. Smart Search" /></label>
        </div>`;
    } else {
      const chk = c.figma;
      body = `<div class="step-q">Which Figma file should Trace build into?</div>
        <div class="field big"><label for="wFigma">Figma file link</label>
          <div class="input-row"><input id="wFigma" type="url" autocomplete="off" spellcheck="false" placeholder="https://www.figma.com/design/…" value="${esc(p.figma.fileUrl)}" aria-describedby="figmaHelp figmaErr figmaOk" />
          <button class="btn" data-act="check-figma" type="button">Check</button></div>
          <span class="help" id="figmaHelp">Trace adds <b>one new page per flow</b>, e.g. “Trace / Save list — New Freemium User”. Your existing pages are never changed.</span></div>
        ${chk?.ok ? `<p class="field-ok" id="figmaOk" role="status">✓ Figma file link looks right. Trace confirms it can edit the file when it starts.</p>` : ""}${err("figma")}
        <fieldset class="engine"><legend class="field-legend">Who does the work?</legend>
          <label class="choice compact checked"><input type="radio" name="engine" value="ai-tool" checked />
            <span class="choice-title">Your AI tool</span><span class="choice-sub">Claude Code, Cursor or another tool with Trace and Figma connected picks this project up.</span></label>
          <label class="choice compact disabled"><input type="radio" name="engine" value="built-in" disabled />
            <span class="choice-title">Built into Trace <span class="badge">Coming next</span></span><span class="choice-sub">Runs without an AI tool open. Needs an Anthropic API key and Figma access token.</span></label>
        </fieldset>`;
    }
    $("view-new").innerHTML = `<div class="wizard">
      <h2 tabindex="-1">New project</h2>
      <ol class="wiz-steps" aria-label="Setup steps">${NEW_STEPS.map(
        (t, i) => `<li class="${i + 1 < step ? "done" : i + 1 === step ? "current" : ""}" ${i + 1 === step ? 'aria-current="step"' : ""}><span class="n" aria-hidden="true">${i + 1 < step ? "✓" : i + 1}</span>${t}</li>`
      ).join("")}</ol>
      <form class="wiz-card" id="wizForm" novalidate>${body}
        <div class="wiz-foot">
          ${step > 1 ? `<button type="button" class="btn" data-act="wiz-back">Back</button>` : `<a class="btn ghost" href="#/">Cancel</a>`}
          <span class="muted" style="font-size:12px">Saved as a draft</span>
          <button type="submit" class="btn primary">${step < 3 ? "Continue" : "Start Trace"}</button>
        </div></form></div>`;
  }
  async function wizSave(fields) {
    S.project = await post("/api/project/update", { id: S.projectId, ...fields });
  }
  async function wizSubmit() {
    const p = S.project;
    const step = S.newStep;
    if (step === 1) {
      if (!p.designSystem) return wizError("ds", "Choose V1 or V2 to continue.");
      return (location.hash = `#/new/${encodeURIComponent(p.id)}/2`);
    }
    if (step === 2) {
      const url = $("wRepo").value.trim();
      await wizSave({ repo: { url, branch: $("wBranch").value.trim() }, name: $("wName").value.trim() || undefined });
      if (!url) return wizError("repo", "Add the prototype's GitHub repository or a folder path.");
      if (!S.checks.repo?.ok || S.checks.repo.url !== url) await checkRepoNow(url);
      if (!S.checks.repo?.ok) return;
      return (location.hash = `#/new/${encodeURIComponent(p.id)}/3`);
    }
    const fu = $("wFigma").value.trim();
    await wizSave({ figma: { fileUrl: fu } });
    if (!fu) return wizError("figma", "Add the Figma file where the screens should go.");
    if (!S.project.figma.fileKey) return wizError("figma", "That isn't a Figma design file link (figma.com/design/…).");
    try {
      await post("/api/project/start", { id: p.id });
    } catch {
      return;
    }
    announce("Project created. Trace will start exploring.");
    location.hash = `#/project/${encodeURIComponent(p.id)}`;
  }
  function wizError(k, msg) {
    S.checks[k] = { error: msg };
    renderNew();
    document.querySelector(`#${k === "ds" ? "wizForm input" : k === "repo" ? "wRepo" : "wFigma"}`)?.focus();
  }
  async function checkRepoNow(url) {
    S.checks.repo = { loading: true };
    renderNew();
    const r = await post("/api/check/repo", { url });
    S.checks.repo = r.ok ? { ...r, url } : { error: r.error };
    if (r.ok && !S.project.repo.branch && r.defaultBranch) await wizSave({ repo: { branch: r.defaultBranch } });
    renderNew();
  }

  // ---------------- project
  function renderProject() {
    const p = S.project;
    if (!p) return;
    const ds = (S.designSystems || []).find((d) => d.id === p.designSystem);
    document.title = `${p.name} · Trace Studio`;
    $("crumbs").innerHTML = `<a href="#/">Projects</a>`;
    $("runTitle").textContent = p.name;
    $("runMeta").innerHTML = [
      ds && `<span title="Design system">${esc(ds.short)}</span>`,
      p.repo.url && `<span title="Prototype: ${esc(p.repo.url)}">${esc(p.repo.url.replace(/^https?:\/\/(www\.)?/, ""))}${p.repo.branch ? ` (${esc(p.repo.branch)})` : ""}</span>`,
      p.figma.fileUrl && `<a href="${esc(p.figma.fileUrl)}" target="_blank" rel="noopener">Figma file${p.figma.verified ? " ✓" : ""} ↗</a>`,
    ].filter(Boolean).join('<span class="sep" aria-hidden="true">·</span>');
    const tab = S.projTab === "history" ? "history" : "flows";
    const actions = `<div class="proj-actions">
      ${p.status === "draft" ? "" : `<button class="btn sm" data-act="proj-pause" aria-pressed="${!!p.paused}">${p.paused ? "Resume" : "Pause"}</button>`}
      <button class="btn sm ghost danger" data-act="proj-delete">Delete…</button></div>`;
    const pausedBanner = p.paused
      ? `<div class="panel warn compact" role="status"><b>Paused.</b> Trace won't start new work on this project. Anything already captured stays here. <button class="btn sm" data-act="proj-pause">Resume</button></div>`
      : "";
    const tabs = `<nav class="subtabs" aria-label="Project sections">
      <a href="#/project/${encodeURIComponent(p.id)}" ${tab === "flows" ? 'aria-current="page"' : ""}>Flows</a>
      <a href="#/project/${encodeURIComponent(p.id)}/history" ${tab === "history" ? 'aria-current="page"' : ""}>History <span class="pill">${p.exports.length || ""}</span></a></nav>`;
    let body = "";
    if (tab === "history") body = projectHistory(p);
    else if (p.status === "draft") body = `<div class="panel"><h3>Setup isn't finished</h3><p class="muted">Pick the design system, prototype and Figma file.</p><a class="btn primary" href="#/new/${encodeURIComponent(p.id)}/1">Continue setup</a></div>`;
    else if (p.status === "queued") body = waitingPanel(p);
    else if (p.status === "understanding") body = understandingPanel(p);
    else if (p.status === "failed") body = `<div class="panel bad"><h3>Trace hit a problem</h3><p>${esc(p.error || "Unknown error")}</p><button class="btn primary" data-act="proj-retry">Try again</button></div>`;
    else if (p.status === "choose-flows") body = chooseFlows(p);
    else body = flowsInProgress(p);
    $("view-project").innerHTML = `<div class="page"><div class="proj-top">${tabs}${actions}</div>${pausedBanner}${body}</div>`;
  }
  function waitingPanel(p) {
    const prompt = `Use Trace to work on my Trace Studio project "${p.name}", then stay connected: call trace_wait in a loop and do whatever it returns.`;
    const copy = `<div class="copy-row"><code id="handoffPrompt">${esc(prompt)}</code><button class="btn sm" data-act="copy" data-target="handoffPrompt">Copy</button></div>`;
    if (!engineOn())
      return `<div class="panel warn">
        <div class="panel-head"><span class="warn-icon" aria-hidden="true">!</span><h3>Not started: no AI tool is connected</h3></div>
        <p>Your project is saved and queued, but nothing is working on it yet. Trace does its work inside your AI tool.</p>
        ${connectHelp()}
        <p class="muted">${S.engine?.lastSeen ? `Last connected ${esc(timeAgo(S.engine.lastSeen))}. ` : ""}This page checks every few seconds.</p>
        <div class="btn-row"><a class="btn sm" href="#/new/${encodeURIComponent(p.id)}/1">Edit setup</a></div></div>`;
    return `<div class="panel">
      <div class="panel-head"><span class="spinner" aria-hidden="true"></span><h3>Trace is connected and starting</h3>${engineChip()}</div>
      ${bar("Starting")}
      <p role="status">${S.engine.working?.projectId === p.id ? "Trace has picked up this project." : "Waiting for Trace to pick this project up. If it doesn't within a minute, send the prompt below in your AI tool."}</p>
      ${S.engine.working?.projectId === p.id ? "" : copy}</div>`;
  }
  function understandingPanel(p) {
    const pr = p.progress || {};
    const pct = pr.total ? Math.round(((pr.current || 0) / pr.total) * 100) : null;
    const steps = pr.steps || [
      { label: "Get the prototype", status: "doing" },
      { label: "Install and start it", status: "todo" },
      { label: "Read screens, states and scenarios", status: "todo" },
      { label: "Check the Figma file and design system", status: "todo" },
      { label: "Propose flows", status: "todo" },
    ];
    const icon = { done: "✓", doing: '<span class="spinner" aria-hidden="true"></span>', failed: "✕", todo: "" };
    return `<div class="panel">
      <div class="panel-head"><span class="spinner" aria-hidden="true"></span><h3>Trace is exploring the prototype</h3>${engineChip()}</div>
      <p role="status" aria-live="polite">${esc(pr.message || "Getting started…")}</p>
      ${bar("Exploring", pct)}
      ${engineOn() ? "" : `<p class="warn-text" role="alert">Trace stopped responding: the AI tool was closed or disconnected. Reopen it and send the prompt again to continue.</p>`}
      <ol class="checklist">${steps.map((st) => `<li class="st-${st.status}"><span class="ck" aria-hidden="true">${icon[st.status] || ""}</span>${esc(st.label)}<span class="sr-only"> — ${st.status === "doing" ? "in progress" : st.status}</span></li>`).join("")}</ol>
      <p class="muted">This usually takes a few minutes. You can leave this page. Trace keeps going and the project card shows when flows are ready.</p>
      <button class="btn sm" data-act="proj-cancel">Cancel</button></div>`;
  }
  function chooseFlows(p) {
    const sm = p.summary || {};
    const picks = S.flowPicks;
    if (!picks.size) for (const f of p.flows) if (f.selected) picks.set(f.id, f.scenario);
    const n = picks.size + S.custom.filter((c) => c.trim()).length;
    return `<div class="choose-head"><div><h3>Which flows should Trace build?</h3>
        <p class="muted">Trace found ${p.flows.length} flow${p.flows.length === 1 ? "" : "s"}${sm.views ? ` across ${sm.views} screens` : ""}${sm.scenarios?.length ? ` and ${sm.scenarios.length} scenarios` : ""}. Pick one or more. Each becomes its own page in Figma.</p></div>
        ${sm.notes ? `<p class="note">${esc(sm.notes)}</p>` : ""}</div>
      <div class="flow-grid" role="group" aria-label="Proposed flows">${p.flows
        .filter((f) => !f.runId)
        .map((f) => {
          const on = picks.has(f.id);
          return `<div class="flow-card ${on ? "checked" : ""}">
            <label class="flow-pick"><input type="checkbox" data-act="pick-flow" data-id="${f.id}" ${on ? "checked" : ""} />
              <span class="flow-name">${esc(f.name)}</span></label>
            ${f.description ? `<p class="muted">${esc(f.description)}</p>` : ""}
            ${f.steps?.length ? `<ol class="chain" aria-label="Screens">${f.steps.map((st) => `<li>${esc(st)}</li>`).join("")}</ol>` : ""}
            ${f.states?.length ? `<div class="badges">${f.states.map((st) => `<span class="badge state">${esc(st)}</span>`).join("")}</div>` : ""}
            <div class="flow-foot">
              ${f.scenarios?.length ? `<label class="field inline">Scenario<select data-act="flow-scenario" data-id="${f.id}" ${on ? "" : "disabled"}>${f.scenarios.map((sc) => `<option ${(picks.get(f.id) || f.scenario) === sc ? "selected" : ""}>${esc(sc)}</option>`).join("")}</select></label>` : "<span></span>"}
              ${f.screensEstimate ? `<span class="muted">~${f.screensEstimate} screens</span>` : ""}
            </div></div>`;
        })
        .join("")}</div>
      <section class="custom-flows"><h3>Something missing?</h3>
        <p class="muted">Describe a flow in your own words and Trace will trace it too.</p>
        ${S.custom.map((c, i) => `<div class="input-row"><label class="sr-only" for="cf${i}">Custom flow ${i + 1}</label><input id="cf${i}" data-act="custom" data-i="${i}" value="${esc(c)}" placeholder="e.g. Search, open History, reopen an old search" /><button class="btn sm ghost" data-act="custom-remove" data-i="${i}" aria-label="Remove custom flow ${i + 1}">✕</button></div>`).join("")}
        <button class="btn sm" data-act="custom-add">+ Describe a flow</button></section>
      <div class="sticky-foot"><span class="muted">${n ? `${n} flow${n > 1 ? "s" : ""} selected` : "Select at least one flow"}</span>
        <button class="btn primary" data-act="trace-flows" ${n ? "" : "disabled"}>Trace ${n || ""} flow${n === 1 ? "" : "s"} →</button></div>`;
  }
  function flowsInProgress(p) {
    const picked = p.flows.filter((f) => f.selected);
    const others = p.flows.filter((f) => !f.selected);
    const rows = picked
      .map((f) => {
        const r = S.projectRuns.find((x) => x.id === f.runId || x.flowId === f.id);
        const exp = p.exports.filter((x) => x.flowId === f.id).at(-1);
        return `<div class="flow-row">
          <div class="mini" style="${r?.cover ? `background-image:url('/shots/${encodeURIComponent(r.id)}/${r.cover.split("/").map(encodeURIComponent).join("/")}')` : ""}"></div>
          <div><div class="flow-name">${esc(f.name)}</div><div class="muted">${f.scenario ? esc(f.scenario) + " · " : ""}${r ? `${r.screens} screens` : "Not started yet"}</div></div>
          <div>${
            r
              ? stageBadge(r.stage) + (r.stage === "understanding" ? bar("Capturing") : "")
              : engineOn()
                ? `<span class="badge state">Up next</span>${bar("Waiting")}`
                : '<span class="badge warn">Not started: no AI tool connected</span>'
          }</div>
          <div class="acts">${r ? `<a class="btn sm ${r.stage === "review" ? "primary" : ""}" href="#/run/${encodeURIComponent(r.id)}/flow">${r.stage === "review" ? "Review" : "Open"}</a>` : ""}
            ${exp?.figmaUrl ? `<a class="btn sm" href="${esc(exp.figmaUrl)}" target="_blank" rel="noopener">Figma page ↗</a>` : ""}</div></div>`;
      })
      .join("");
    const waitingFlows = picked.filter((f) => !S.projectRuns.some((x) => x.id === f.runId || x.flowId === f.id)).length;
    return `${waitingFlows && !engineOn() ? `<div class="panel warn compact"><b>${waitingFlows} flow${waitingFlows > 1 ? "s are" : " is"} waiting, but no AI tool is connected.</b> Open your AI tool and send: <code>${esc(S.connect?.prompt || "")}</code> <button class="btn sm" data-act="copy-text" data-text="${esc(S.connect?.prompt || "")}">Copy</button></div>` : ""}
    <h3 class="section-title">Flows ${engineChip()}</h3><div class="flow-list">${rows || '<div class="empty">No flows picked.</div>'}</div>
      ${others.length ? `<details class="more-flows"><summary>Pick more flows (${others.length} more proposed)</summary>${chooseFlows({ ...p, flows: others, summary: null })}</details>` : ""}`;
  }
  function projectHistory(p) {
    const rows = [...p.exports].reverse();
    return `<h3 class="section-title">Exports</h3>
      ${
        rows.length
          ? `<div class="table-wrap"><table class="table"><thead><tr><th scope="col">When</th><th scope="col">Flow</th><th scope="col">Figma page</th><th scope="col">Screens</th><th scope="col">Status</th></tr></thead><tbody>${rows
              .map((x) => `<tr><td>${esc(new Date(x.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</td><td>${esc(x.flowName)}</td><td>${x.figmaUrl ? `<a href="${esc(x.figmaUrl)}" target="_blank" rel="noopener">${esc(x.pageName || "Open")} ↗</a>` : "—"}</td><td>${esc(x.screens ?? "—")}</td><td><span class="badge ${x.status === "failed" ? "bad" : "ok"}">${esc(cap(x.status || "built"))}</span></td></tr>`)
              .join("")}</tbody></table></div>`
          : '<div class="empty">Nothing exported from this project yet.</div>'
      }
      <h3 class="section-title">Activity</h3>
      <div class="log">${[...(p.log || [])].reverse().map((l) => `<div><span class="t">${new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span class="k-${l.kind}">${l.kind === "designer" ? "You" : "Trace"}</span><span>${esc(l.msg)}</span></div>`).join("") || '<div class="empty">Nothing yet.</div>'}</div>`;
  }

  // project + wizard events
  document.addEventListener("submit", (ev) => {
    if (ev.target.id !== "wizForm") return;
    ev.preventDefault();
    wizSubmit();
  });
  document.addEventListener("change", async (ev) => {
    const t = ev.target;
    if (S.route === "new") {
      if (t.name === "ds") {
        await wizSave({ designSystem: t.value });
        S.checks.ds = null;
        renderNew();
        document.querySelector(`input[name=ds][value=${t.value}]`)?.focus();
      }
      if (t.id === "wRepo") {
        await wizSave({ repo: { url: t.value.trim() } });
        if (t.value.trim()) checkRepoNow(t.value.trim());
      }
      if (t.id === "wBranch") wizSave({ repo: { branch: t.value.trim() } });
      if (t.id === "wName") wizSave({ name: t.value.trim() || undefined });
      if (t.id === "wFigma") {
        await wizSave({ figma: { fileUrl: t.value.trim() } });
        const r = await post("/api/check/figma", { url: t.value.trim() });
        S.checks.figma = r.ok ? r : { error: r.error };
        renderNew();
      }
    }
    if (t.id === "flowSwitch" && t.value) location.hash = `#/run/${encodeURIComponent(t.value)}/flow`;
    if (t.dataset.act === "pick-flow") {
      const f = S.project.flows.find((x) => x.id === t.dataset.id);
      if (t.checked) S.flowPicks.set(f.id, f.scenario || f.scenarios?.[0] || null);
      else S.flowPicks.delete(f.id);
      renderProject();
      document.querySelector(`[data-act=pick-flow][data-id="${f.id}"]`)?.focus();
    }
    if (t.dataset.act === "flow-scenario") S.flowPicks.set(t.dataset.id, t.value);
  });
  document.addEventListener("input", (ev) => {
    if (ev.target.dataset.act === "custom") S.custom[Number(ev.target.dataset.i)] = ev.target.value;
  });
  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest("[data-act]");
    if (!t) return;
    switch (t.dataset.act) {
      case "wiz-back":
        return (location.hash = `#/new/${encodeURIComponent(S.projectId)}/${S.newStep - 1}`);
      case "check-repo":
        return checkRepoNow($("wRepo").value.trim());
      case "check-figma":
        return $("wFigma").dispatchEvent(new Event("change", { bubbles: true }));
      case "copy-text":
        navigator.clipboard?.writeText(t.dataset.text);
        return toast("Copied");
      case "copy":
        navigator.clipboard?.writeText($(t.dataset.target).textContent);
        return toast("Copied");
      case "proj-pause": {
        const paused = !S.project.paused;
        await post("/api/project/pause", { id: S.projectId, paused });
        announce(paused ? "Project paused" : "Project resumed");
        return toast(paused ? "Paused. Trace stops after the flow it's on" : "Resumed");
      }
      case "proj-delete": {
        const p = S.project;
        const n = S.projectRuns.length;
        $("deleteBody").innerHTML = `<p><b>${esc(p.name)}</b> will be removed from Trace Studio${n ? `, along with its <b>${n} captured flow${n > 1 ? "s" : ""}</b> (screenshots and decisions)` : ""}.</p>
          <p class="muted">Pages Trace already made in Figma stay in your Figma file. This can't be undone.</p>
          <label class="check"><input type="checkbox" id="keepRuns" /> Keep the captured flows (they move to "Flows traced from your AI tool")</label>`;
        $("deleteDialog").returnValue = "";
        $("deleteDialog").showModal();
        return;
      }
      case "proj-cancel":
        await post("/api/project/cancel", { id: S.projectId });
        return toast("Cancelled");
      case "proj-retry":
        await post("/api/project/start", { id: S.projectId });
        return toast("Trace will try again");
      case "custom-add":
        S.custom.push("");
        renderProject();
        return document.getElementById(`cf${S.custom.length - 1}`)?.focus();
      case "custom-remove":
        S.custom.splice(Number(t.dataset.i), 1);
        return renderProject();
      case "trace-flows": {
        const keep = S.project.flows.filter((f) => f.selected && !S.flowPicks.has(f.id)).map((f) => ({ id: f.id, scenario: f.scenario }));
        const flows = [...keep, ...[...S.flowPicks].map(([id, scenario]) => ({ id, scenario }))];
        await post("/api/project/select-flows", { id: S.projectId, flows, custom: S.custom });
        S.custom = [];
        S.flowPicks = new Map();
        announce("Flows sent to Trace");
        return toast("Trace will start tracing these flows");
      }
    }
  });

  const stageBadge = (st) => {
    const m = { understanding: ["state", "Exploring"], review: ["warn", "Needs review"], approved: ["state", "Approved"], building: ["state", "Building"], done: ["ok", "Built"] }[st] || ["", st];
    return `<span class="badge ${m[0]}">${m[1]}</span>`;
  };
  function timeAgo(iso) {
    const d = (Date.now() - new Date(iso)) / 1000;
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }

  // ---------------- flow
  function renderFlow() {
    const typingIn = (el) => el && el.contains(document.activeElement) && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
    renderProgress();
    renderBoard();
    const td = todos();
    $("todo").hidden = !S.todoOpen || !!S.screenId || (td.count === 0 && !td.waiting.length);
    if (!$("todo").hidden && !typingIn($("todo"))) renderTodo();
    if (typingIn($("detail"))) S.pending = true;
    else renderDetail();
  }

  function renderProgress() {
    const r = run();
    const el = $("progressStrip");
    const p = r.progress;
    if (r.stage !== "understanding" && !p) return (el.hidden = true);
    el.hidden = false;
    const pct = p?.total ? Math.round(((p.current || 0) / p.total) * 100) : null;
    el.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(p?.message || "Trace is exploring the prototype…")}</span>
      ${pct != null ? `<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div><span class="muted">${p.current} of ~${p.total}</span>` : ""}`;
  }

  function renderBoard() {
    const r = run();
    const board = $("board");
    const cols = columns();
    const pendingAdds = openReqs().filter((x) => x.type === "add-screen" || x.type === "add-state");
    if (!cols.length) {
      board.innerHTML = `<div class="empty-board"><div class="big">${r.stage === "understanding" ? "Trace is exploring the prototype" : "No screens yet"}</div>Screens appear here as Trace captures them.</div>`;
      return applyZoom();
    }
    board.innerHTML =
      `<svg class="edges" id="edges" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--edge)"/></marker></defs></svg>` +
      cols
        .map((c, ci) => {
          const adds = pendingAdds.filter((x) => x.type === "add-state" && c.screens.some((s) => s.id === (x.screenId || x.after)));
          return `<div class="column" data-step="${esc(c.step)}" role="group" aria-label="Step ${ci + 1}: ${esc(c.step)}">
            <div class="col-head" draggable="true" data-step-head="${esc(c.step)}" title="Drag to reorder steps"><span class="idx">${String(ci + 1).padStart(2, "0")}</span> ${esc(c.step)}
              ${c.screens.length > 1 ? `<span class="states">${c.screens.length} states</span>` : ""}</div>
            ${c.screens.map((s) => card(s, c.screens.length)).join("")}
            ${adds.map((x) => `<div class="pending-tile"><b>Trace is adding</b>${esc(x.text)}</div>`).join("")}
            <button class="add-tile" data-act="add-state" data-id="${esc(c.screens[0].id)}">+ Add a state</button>
          </div>`;
        })
        .join("") +
      pendingAdds
        .filter((x) => x.type === "add-screen")
        .map((x) => `<div class="column"><div class="col-head"><span class="idx">··</span> Being added</div><div class="pending-tile"><b>New screen</b>${esc(x.text)}</div></div>`)
        .join("") +
      `<div class="column ghost"><button class="add-tile" data-act="add-screen">+ Add a screen<br><span class="muted" style="font-weight:400">or drop a screen here to make it its own step</span></button></div>`;
    applyZoom();
    requestAnimationFrame(drawEdges);
  }

  function card(s, colSize) {
    const r = run();
    const els = s.elements || [];
    const badges = [];
    if (!isDefault(s)) badges.push(`<span class="badge state">${esc(cap(s.state))}</span>`);
    if (matchingDone()) {
      const m = els.filter((e) => e.decision === "component").length;
      const d = els.filter((e) => e.decision === "detached").length;
      const u = els.filter((e) => meaningful(e) && e.decision === "undecided").length;
      if (m) badges.push(`<span class="badge ok">${m} library</span>`);
      if (d) badges.push(`<span class="badge warn">${d} detached</span>`);
      if (u) badges.push(`<span class="badge bad">${u} to decide</span>`);
    } else {
      const n = els.filter(meaningful).length;
      if (n) badges.push(`<span class="badge">${n} elements</span>`);
    }
    const b = s.build?.status;
    if (b && b !== "pending" && ["approved", "building", "done"].includes(r.stage)) badges.push(`<span class="badge ${b === "built" ? "ok" : b === "failed" ? "bad" : "state"}">${esc(cap(b))}</span>`);
    if (s.review) badges.push(`<span class="badge ${s.review.verdict === "ok" ? "ok" : "bad"}">${s.review.verdict === "ok" ? "Looks right" : "Needs fix"}</span>`);
    const via = r.edges.filter((e) => e.to === s.id && byId(e.from)?.step === s.step).map((e) => e.label);
    const label = `${title(s)}${s.status === "removed" ? ", removed" : ""}. ${via.length ? "Reached by " + via.join(", ") + ". " : ""}Press Enter to open.`;
    return `<button class="card ${s.status === "removed" ? "removed" : ""} build-${esc(b || "")}" data-screen="${s.id}" draggable="true" aria-label="${esc(label)}">
      ${s.status === "removed" ? '<span class="corner removed">Removed</span>' : ""}
      <div class="thumb" style="background-image:url('${shot(s.screenshot)}')"></div>
      <div class="meta">
        <div class="title">${esc(isDefault(s) ? s.name : cap(s.state))}</div>
        ${isDefault(s) && colSize > 1 ? '<div class="main-tag">Main screen</div>' : ""}
        ${via.length ? `<div class="via">↳ ${esc(via.join(" · "))}</div>` : ""}
        ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}
      </div></button>`;
  }

  // Geometry in board coordinates (unaffected by the zoom transform).
  function boardPos(el) {
    const board = $("board");
    let x = 0, y = 0;
    while (el && el !== board) {
      x += el.offsetLeft;
      y += el.offsetTop;
      el = el.offsetParent;
    }
    return { x, y };
  }
  function drawEdges() {
    const board = $("board");
    const svg = $("edges");
    if (!svg || !S.run) return;
    svg.setAttribute("width", board.offsetWidth);
    svg.setAttribute("height", board.offsetHeight);
    const rect = (id) => {
      const el = board.querySelector(`.card[data-screen="${id}"]`);
      if (!el) return null;
      const p = boardPos(el);
      const th = el.querySelector(".thumb").offsetHeight;
      return { l: p.x, r: p.x + el.offsetWidth, t: p.y, b: p.y + el.offsetHeight, cy: p.y + th / 2, cx: p.x + el.offsetWidth / 2 };
    };
    let out = svg.querySelector("defs").outerHTML;
    let labels = "";
    for (const e of run().edges) {
      const a = rect(e.from), b = rect(e.to);
      if (!a || !b) continue;
      let p0, p1, p2, p3;
      if (Math.abs(b.cx - a.cx) < 20) {
        p0 = [a.l, a.cy]; p3 = [b.l - 2, b.cy];
        p1 = [p0[0] - 26, p0[1]]; p2 = [p3[0] - 26, p3[1]];
        out += `<path d="M${p0} C${p1} ${p2} ${p3}" marker-end="url(#arrow)" opacity="0.7"/>`;
        continue;
      }
      if (b.cx > a.cx) {
        p0 = [a.r, a.cy]; p3 = [b.l - 2, b.cy];
        const dx = Math.max(40, (p3[0] - p0[0]) / 2);
        p1 = [p0[0] + dx, p0[1]]; p2 = [p3[0] - dx, p3[1]];
      } else {
        p0 = [a.l, a.cy]; p3 = [b.r + 2, b.cy];
        const dip = Math.max(a.b, b.b) + 40;
        p1 = [p0[0] - 60, dip]; p2 = [p3[0] + 60, dip];
      }
      out += `<path d="M${p0} C${p1} ${p2} ${p3}" marker-end="url(#arrow)"/>`;
      const mid = [0, 1].map((k) => 0.125 * p0[k] + 0.375 * p1[k] + 0.375 * p2[k] + 0.125 * p3[k]);
      const label = e.label.length > 28 ? e.label.slice(0, 27) + "…" : e.label;
      labels += `<div class="edge-label" style="left:${mid[0]}px;top:${mid[1]}px" title="${esc(e.label)}">${esc(label)}</div>`;
    }
    svg.innerHTML = out;
    let layer = board.querySelector(".edge-labels");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "edge-labels";
      layer.setAttribute("aria-hidden", "true");
      board.appendChild(layer);
    }
    layer.innerHTML = labels;
  }

  function applyZoom() {
    const board = $("board");
    board.style.transform = `scale(${S.zoom})`;
    $("boardSizer").style.width = `${board.offsetWidth * S.zoom}px`;
    $("boardSizer").style.height = `${board.offsetHeight * S.zoom}px`;
    $("zoomVal").textContent = `${Math.round(S.zoom * 100)}%`;
  }
  function setZoom(z) {
    S.zoom = Math.min(2, Math.max(0.25, Math.round(z * 100) / 100));
    applyZoom();
  }
  // Fit shows the whole flow; screenshots stay readable (≥ 40%).
  function fit() {
    const sc = $("boardScroll"), board = $("board");
    setZoom(Math.max(0.4, Math.min(1, (sc.clientWidth - 16) / board.offsetWidth, (sc.clientHeight - 16) / board.offsetHeight)));
  }
  // On open, only shrink when the flow is much wider than the window, and by width only.
  function fitIfLarge() {
    const sc = $("boardScroll"), board = $("board");
    if (board.offsetWidth > sc.clientWidth * 1.2) setZoom(Math.max(0.5, (sc.clientWidth - 16) / board.offsetWidth));
  }

  // ---------------- to-do
  function renderTodo() {
    const t = todos();
    const r = run();
    const sec = (head, count, body) => (count ? `<section class="todo-section"><h3>${head} <span class="pill">${count}</span></h3>${body}</section>` : "");
    const body =
      sec(
        "Questions from Trace",
        t.questions.length,
        t.questions
          .map(
            (q) => `<div class="todo-item q" data-q="${q.id}">
              ${q.screenId && byId(q.screenId) ? `<div class="where"><button class="linklike" data-act="open" data-id="${q.screenId}">${esc(title(byId(q.screenId)))}</button></div>` : ""}
              <div class="t">${esc(q.text)}</div>
              <div class="opts">${(q.options?.length ? q.options : ["Yes", "No"]).map((o) => `<button class="btn sm" data-act="answer" data-answer="${esc(o)}">${esc(o)}</button>`).join("")}
              <button class="btn sm ghost" data-act="answer-free">Other…</button></div></div>`
          )
          .join("")
      ) +
      sec(
        "Possibly missing states",
        t.suggestions.length,
        t.suggestions
          .map(
            (g) => `<div class="todo-item" data-g="${g.id}">
              <div class="where">${byId(g.screenId) ? esc(title(byId(g.screenId))) : ""}</div>
              <div class="t">${esc(cap(g.state))}${g.reason ? ` <span class="muted" style="font-weight:400">— ${esc(g.reason)}</span>` : ""}</div>
              <div class="opts"><button class="btn sm" data-act="sg-add">Add to flow</button><button class="btn sm ghost" data-act="sg-dismiss">Not needed</button></div></div>`
          )
          .join("")
      ) +
      sec(
        "Component decisions",
        t.undecided.length ? 1 : 0,
        `<div class="todo-item"><div class="t">${t.undecided.length} element${t.undecided.length > 1 ? "s" : ""} have no decision yet</div>
          <div class="muted" style="margin-bottom:8px">Anything left undecided is built as the detached nearest component.</div>
          <a class="btn sm" href="#/run/${encodeURIComponent(S.runId)}/components">Review components</a></div>`
      ) +
      sec(
        "Check the Figma result",
        t.toValidate.length,
        `<div class="todo-item"><div class="t">${t.toValidate.length} built screen${t.toValidate.length > 1 ? "s" : ""} to compare with the prototype</div>
          <a class="btn sm" href="#/run/${encodeURIComponent(S.runId)}/build/${encodeURIComponent(t.toValidate[0]?.id || "")}">Start comparing</a></div>`
      ) +
      sec(
        "Trace is working on",
        t.waiting.length,
        t.waiting.map((w) => `<div class="todo-item"><div class="where">${w.screenId && byId(w.screenId) ? esc(title(byId(w.screenId))) : "Flow"}</div><div>${esc(w.text || cap(w.type))}</div></div>`).join("")
      );
    const ready = r.stage === "review" && !t.questions.length && !t.waiting.length;
    $("todo").innerHTML = `<div class="todo-head"><h2>To-do</h2><span class="pill ${t.count ? "alert" : ""}">${t.count || ""}</span>
        <button class="btn ghost sm" data-act="close-todo" aria-label="Close to-do" style="margin-left:auto">✕</button></div>
      <div class="todo-body">${
        body ||
        `<div class="todo-done"><div class="big" aria-hidden="true">✓</div>${
          ready ? "Nothing needs you. Check the flow, then approve." : r.stage === "understanding" ? "Nothing yet. Trace is still exploring." : "Nothing needs you right now."
        }</div>`
      }
      ${ready ? `<button class="btn primary" data-act="approve">Review &amp; approve…</button>` : ""}</div>`;
  }

  // ---------------- screen detail
  function renderDetail() {
    S.pending = false;
    const d = $("detail");
    const s = S.screenId && byId(S.screenId);
    if (!s) {
      d.hidden = true;
      d.innerHTML = "";
      return;
    }
    d.hidden = false;
    const r = run();
    const order = flatOrder();
    const idx = order.findIndex((x) => x.id === s.id);
    const col = columns().find((c) => c.step === s.step);
    const sibs = col ? col.screens : [s];
    const size = s.size || { w: 1440, h: 900 };
    const els = s.elements || [];
    const shown = S.showAll ? els : els.filter(meaningful);
    const inbound = r.edges.filter((e) => e.to === s.id);
    const outbound = r.edges.filter((e) => e.from === s.id);
    const steps = columns().map((c) => c.step);
    const sideScroll = d.querySelector(".side")?.scrollTop || 0;
    const viewScroll = d.querySelector(".viewer")?.scrollTop || 0;
    d.innerHTML = `
      <div class="detail-top">
        <button class="btn sm" data-act="back">← Flow</button>
        <h2 class="t">${esc(title(s))}</h2>
        <span class="spacer"></span>
        <div class="btn-row" role="group" aria-label="Screenshot view">
          <button class="btn sm ${S.fitShot ? "on" : ""}" data-act="shot-fit" aria-pressed="${S.fitShot}">Fit</button>
          <button class="btn sm ${S.fitShot ? "" : "on"}" data-act="shot-100" aria-pressed="${!S.fitShot}">100%</button>
          <button class="btn sm ${S.overlays ? "on" : ""}" data-act="overlays" aria-pressed="${S.overlays}">Outlines</button>
        </div>
        ${s.url ? `<a class="btn sm" href="${esc(s.url)}" target="_blank" rel="noopener">Open in prototype ↗</a>` : ""}
        ${figmaLink(s) ? `<a class="btn sm" href="${esc(figmaLink(s))}" target="_blank" rel="noopener" title="${s.build?.url || s.build?.nodeId ? "This screen's frame in Figma" : "The Figma page for this flow"}">Open in Figma ↗</a>` : ""}
        <button class="btn sm icon" data-act="prev" aria-label="Previous screen" ${idx <= 0 ? "disabled" : ""}>‹</button>
        <span class="muted" style="font-variant-numeric:tabular-nums">${idx + 1} / ${order.length}</span>
        <button class="btn sm icon" data-act="next" aria-label="Next screen" ${idx >= order.length - 1 ? "disabled" : ""}>›</button>
      </div>
      ${sibs.length > 1 ? `<div class="state-strip" role="tablist" aria-label="States of ${esc(s.step)}">${sibs
        .map((x) => `<button class="state-chip" role="tab" data-act="open" data-id="${x.id}" aria-current="${x.id === s.id}" aria-selected="${x.id === s.id}"><span class="mini" style="background-image:url('${shot(x.screenshot)}')"></span>${esc(stateLabel(x))}</button>`)
        .join("")}</div>` : ""}
      <div class="detail-body">
        <div class="viewer ${S.fitShot ? "fit" : ""}">
          <div class="shot-wrap" style="${S.fitShot ? "" : `width:${size.w}px`}">
            <img src="${shot(s.screenshot)}" alt="Screenshot of ${esc(title(s))}" />
            ${S.overlays ? shown.map((e) => (e.box ? `<div class="ov ${matchingDone() ? e.decision : "found"}" data-ov="${e.id}" style="left:${(e.box.x / size.w) * 100}%;top:${(e.box.y / size.h) * 100}%;width:${(e.box.w / size.w) * 100}%;height:${(e.box.h / size.h) * 100}%"></div>` : "")).join("") : ""}
          </div>
        </div>
        <div class="side">
          <section>
            <h3>Screen</h3>
            <div class="row2">
              <label class="field">Name<input id="fName" value="${esc(s.name)}" /></label>
              <label class="field">State<input id="fState" value="${esc(isDefault(s) ? "" : s.state)}" placeholder="Main screen" /></label>
            </div>
          </section>
          <section>
            <h3>Place in flow</h3>
            <label class="field">Step<select id="fStep">${steps.map((st) => `<option ${st === s.step ? "selected" : ""}>${esc(st)}</option>`).join("")}<option value="__new">New step…</option></select></label>
            <div class="btn-row" style="margin-top:8px">
              <button class="btn sm" data-act="move-up" ${sibs[0]?.id === s.id ? "disabled" : ""}>Move up</button>
              <button class="btn sm" data-act="move-down" ${sibs.at(-1)?.id === s.id ? "disabled" : ""}>Move down</button>
              ${isDefault(s) ? "" : `<button class="btn sm" data-act="make-main">Set as main screen</button>`}
            </div>
          </section>
          <section>
            <h3>Connections</h3>
            <div class="links">
              ${inbound.length ? inbound.map((e) => `<button data-act="open" data-id="${e.from}"><span class="act">${esc(e.label)}</span> from ${esc(byId(e.from) ? title(byId(e.from)) : e.from)}</button>`).join("") : '<span class="muted">Start of the flow</span>'}
              ${outbound.map((e) => `<button data-act="open" data-id="${e.to}"><span class="act">${esc(e.label)}</span> → ${esc(byId(e.to) ? title(byId(e.to)) : e.to)}</button>`).join("")}
            </div>
          </section>
          <section>
            <label class="field"><span style="text-transform:uppercase;letter-spacing:.05em">Handoff note</span>
              <textarea id="fNotes" placeholder="Anything developers should know about this screen">${esc(s.notes || "")}</textarea>
              <span class="help">Placed next to this frame in Figma.</span></label>
          </section>
          <section>
            <h3>Elements <span class="pill">${shown.length}</span></h3>
            ${matchingDone() ? "" : `<p class="muted" style="margin:0 0 8px;font-size:12px">Not matched to ${esc(r.project?.library || "the library")} yet.</p>`}
            ${shown.length ? `<div class="el-list">${shown.map((e) => elementRow(s, e)).join("")}</div>` : '<p class="muted">No elements found.</p>'}
            ${els.length > els.filter(meaningful).length ? `<button class="btn sm ghost show-more" data-act="show-all">${S.showAll ? "Hide layout & decorative" : `Show ${els.length - els.filter(meaningful).length} layout & decorative`}</button>` : ""}
          </section>
          <section class="btn-row">
            <button class="btn sm" data-act="add-state" data-id="${s.id}">+ Add a state</button>
            ${s.status === "removed" ? `<button class="btn sm" data-act="restore">Restore screen</button>` : `<button class="btn sm danger" data-act="remove">Remove from flow</button>`}
          </section>
        </div>
      </div>`;
    d.querySelector(".side").scrollTop = sideScroll;
    d.querySelector(".viewer").scrollTop = viewScroll;
  }

  function crop(s, e, w = 56, h = 36) {
    if (!e.box || !s.screenshot) return `<div class="crop-box" aria-hidden="true"></div>`;
    const size = s.size || { w: 1440, h: 900 };
    const sc = Math.min(w / e.box.w, h / e.box.h, 1);
    return `<div class="crop-box" aria-hidden="true"><div class="crop" style="width:${Math.max(4, e.box.w * sc)}px;height:${Math.max(4, e.box.h * sc)}px;background-image:url('${shot(s.screenshot)}');background-size:${size.w * sc}px auto;background-position:-${e.box.x * sc}px -${e.box.y * sc}px"></div></div>`;
  }
  const decisionSelect = (e, attrs, label) =>
    `<select ${attrs} aria-label="${esc(label)}">${DECISIONS.map(([v, l]) => `<option value="${v}" ${v === e.decision ? "selected" : ""} ${v === "component" && !e.proposed ? "disabled" : ""}>${l}</option>`).join("")}</select>`;
  function elementRow(s, e) {
    const sub = e.proposed
      ? `→ ${e.proposed.component}${e.proposed.props ? Object.entries(e.proposed.props).filter(([k]) => k !== "Label").map(([k, v]) => ` · ${k}: ${v}`).join("") : ""}`
      : kindOf(e);
    return `<div class="el" data-el="${e.id}">
      ${crop(s, e)}
      <div class="el-name" title="${esc(elName(e))}">${esc(elName(e))}</div>
      ${matchingDone() ? decisionSelect(e, `data-decide="${e.id}" data-screen="${s.id}"`, `Decision for ${e.label}`) : ""}
      <div class="el-sub">${esc(sub)}${e.decidedBy === "designer" ? " · set by you" : ""}</div>
    </div>`;
  }

  // ---------------- components
  function groupsFor() {
    const groups = new Map();
    for (const s of live())
      for (const e of s.elements || []) {
        if (!S.compShowAll && !meaningful(e)) continue;
        const k = kindOf(e);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push({ s, e });
      }
    return groups;
  }
  function renderComponents() {
    const groups = groupsFor();
    const all = [...groups.values()].flat();
    const n = (d) => all.filter((x) => x.e.decision === d).length;
    const f = S.compFilter;
    const pass = (x) => f === "all" || (f === "fs" ? ["frames", "skip"].includes(x.e.decision) : x.e.decision === f);
    const hidden = live().reduce((c, s) => c + (s.elements || []).filter((e) => !meaningful(e)).length, 0);
    const sorted = [...groups].map(([k, rows]) => [k, rows.filter(pass)]).filter(([, rows]) => rows.length).sort((a, b) => b[1].length - a[1].length);
    const filterBtn = (v, l, c) => `<button class="btn sm ${f === v ? "on" : ""}" data-act="cfilter" data-v="${v}" aria-pressed="${f === v}">${l} <span class="pill">${c}</span></button>`;
    $("view-components").innerHTML = `<div class="page">
      <h2>Components</h2>
      <p class="lead">Elements found across the flow, grouped by type. Decide once for a whole group, or open it to change single elements.</p>
      ${matchingDone() ? "" : `<div class="notice">Trace hasn't matched these to <b>${esc(run().project?.library || "the library")}</b> yet. Groups show what was found; library proposals appear once matching runs. You can already mark groups to skip or build as plain frames.</div>`}
      <div class="summary">
        <div class="stat ok"><div class="v">${n("component")}</div><div class="l">Library components</div></div>
        <div class="stat warn"><div class="v">${n("detached")}</div><div class="l">Detached nearest</div></div>
        <div class="stat"><div class="v">${n("frames") + n("skip")}</div><div class="l">Plain frames / skipped</div></div>
        <div class="stat bad"><div class="v">${n("undecided")}</div><div class="l">Not decided</div></div>
      </div>
      <div class="filters" role="group" aria-label="Filter">
        ${filterBtn("all", "All", all.length)}${filterBtn("undecided", "Not decided", n("undecided"))}${filterBtn("component", "Library", n("component"))}${filterBtn("detached", "Detached", n("detached"))}${filterBtn("fs", "Frames / skip", n("frames") + n("skip"))}
        <label style="margin-left:auto" class="muted"><input type="checkbox" data-act="comp-all" ${S.compShowAll ? "checked" : ""}/> Include layout &amp; decorative (${hidden})</label>
      </div>
      ${sorted.length ? sorted.map(([k, rows]) => groupHtml(k, rows)).join("") : '<div class="group empty">Nothing matches this filter.</div>'}</div>`;
  }
  // The same element repeated on many screens (sidebar, header…) is one row.
  function repeats(rows) {
    const m = new Map();
    for (const r of rows) {
      // Same code component with the same label = one element, wherever it sits
      // (a backdrop or a shifted layout doesn't make it a different one).
      const key = `${r.e.role || ""}|${elName(r.e)}`;
      if (!m.has(key)) m.set(key, { ...r, all: [] });
      m.get(key).all.push(r);
    }
    return [...m.values()];
  }
  function groupHtml(k, rows) {
    const screens = new Set(rows.map((x) => x.s.id)).size;
    const decs = new Set(rows.map((x) => x.e.decision));
    const common = decs.size === 1 ? [...decs][0] : "mixed";
    const proposed = rows.find((x) => x.e.proposed)?.e.proposed;
    const open = S.openGroups.has(k);
    return `<details class="group" data-group="${esc(k)}" ${open ? "open" : ""}>
      <summary>
        <span class="chev" aria-hidden="true">›</span>
        <div><div class="gname">${esc(k)}</div>
          <div class="gsub">${repeats(rows).length} unique · ${rows.length} on ${screens} screen${screens > 1 ? "s" : ""} · ${proposed ? `proposed: ${esc(proposed.component)}` : "no library match yet"}</div>
          <div class="crops">${rows.slice(0, 6).map((x) => crop(x.s, x.e, 72, 44)).join("")}</div></div>
        <div class="group-decide">
          <select data-group-decide="${esc(k)}" aria-label="Decision for all ${esc(k)}">
            ${common === "mixed" ? '<option value="mixed" selected disabled>Mixed</option>' : ""}
            ${DECISIONS.map(([v, l]) => `<option value="${v}" ${v === common ? "selected" : ""} ${v === "component" && !proposed ? "disabled" : ""}>${l}</option>`).join("")}
          </select>
          <span class="muted" style="font-size:12px">applies to all ${rows.length}</span>
        </div>
      </summary>
      <div class="instances">${repeats(rows)
        .map(({ s, e, all }) => {
          const where = all.length > 1 ? `on ${new Set(all.map((x) => x.s.id)).size} screens` : title(s);
          const decs = new Set(all.map((x) => x.e.decision));
          const sel =
            all.length > 1
              ? `<select data-multi='${esc(JSON.stringify(all.map((x) => ({ screenId: x.s.id, elementId: x.e.id }))))}' aria-label="Decision for ${esc(elName(e))} on all screens">
                  ${decs.size > 1 ? '<option selected disabled>Mixed</option>' : ""}
                  ${DECISIONS.map(([v, l]) => `<option value="${v}" ${decs.size === 1 && decs.has(v) ? "selected" : ""} ${v === "component" && !e.proposed ? "disabled" : ""}>${l}</option>`).join("")}</select>`
              : decisionSelect(e, `data-decide="${e.id}" data-screen="${s.id}"`, `Decision for ${elName(e)}`);
          return `<div class="inst">${crop(s, e, 72, 44)}
          <div><div>${esc(elName(e))}</div><button class="linklike" data-act="open" data-id="${s.id}" style="font-size:12px">${esc(where)}</button></div>
          <span class="muted" style="font-size:12px">${e.confidence && e.confidence !== "none" ? esc(cap(e.confidence)) + " confidence" : ""}</span>
          ${sel}</div>`;
        })
        .join("")}</div></details>`;
  }

  // ---------------- build & compare
  function renderBuild() {
    const r = run();
    const L = live();
    const st = (k) => L.filter((s) => (s.build?.status || "pending") === k).length;
    const pct = L.length ? Math.round((st("built") / L.length) * 100) : 0;
    const started = ["approved", "building", "done"].includes(r.stage);
    const ordered = flatOrder().filter((s) => s.status !== "removed");
    let html = `<div class="page">
      <h2>Build &amp; compare</h2>
      <p class="lead">${started ? (r.stage === "done" ? "Finished. Compare each screen with the prototype and mark it." : "Trace is rebuilding each approved screen in Figma.") : "Building starts after you approve the flow."}
        ${r.figma?.fileUrl ? ` <a href="${esc(r.figma.fileUrl)}" target="_blank" rel="noopener">Open the Figma file ↗</a>` : ""}</p>
      <div class="summary">
        <div class="stat ok"><div class="v">${st("built")}</div><div class="l">Built</div></div>
        <div class="stat"><div class="v">${st("building")}</div><div class="l">In progress</div></div>
        <div class="stat"><div class="v">${L.filter((s) => s.review?.verdict === "ok").length}</div><div class="l">Checked: looks right</div></div>
        <div class="stat bad"><div class="v">${st("failed") + L.filter((s) => s.review?.verdict === "fix").length}</div><div class="l">Failed / needs fix</div></div>
      </div>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Build progress"><div style="width:${pct}%"></div></div>
      <div class="build-list">${ordered
        .map(
          (s) => `<div class="build-row">
          <div class="mini" style="background-image:url('${shot(s.screenshot)}')" role="img" aria-label="Prototype"></div>
          <div class="mini" ${s.build?.image ? `style="background-image:url('${shot(s.build.image)}')" role="img" aria-label="Figma result"` : ""}>${s.build?.image ? "" : "Figma"}</div>
          <div><div><b>${esc(title(s))}</b></div>
            ${s.build?.summary ? `<div class="muted">${esc(s.build.summary)}</div>` : ""}
            ${s.build?.error ? `<div class="err">${esc(s.build.error)}</div>` : ""}
            ${s.review ? `<span class="badge ${s.review.verdict === "ok" ? "ok" : "bad"}">${s.review.verdict === "ok" ? "Looks right" : "Needs fix"}</span>${s.review.note ? ` <span class="muted">${esc(s.review.note)}</span>` : ""}` : ""}</div>
          <div class="acts">${buildBadge(s.build?.status)}
            <a class="btn sm" href="#/run/${encodeURIComponent(S.runId)}/build/${encodeURIComponent(s.id)}">Compare</a>
            ${s.build?.url || s.build?.nodeId ? `<a class="btn sm" href="${esc(figmaLink(s))}" target="_blank" rel="noopener">Figma ↗</a>` : ""}</div></div>`
        )
        .join("")}</div></div>`;
    const c = S.compareId && byId(S.compareId);
    if (c) html += compareHtml(c, ordered);
    $("view-build").innerHTML = html;
  }
  const buildBadge = (b = "pending") =>
    `<span class="badge ${b === "built" ? "ok" : b === "failed" ? "bad" : b === "building" ? "state" : ""}">${b === "building" ? '<span class="spinner" style="width:10px;height:10px;border-width:1.5px" aria-hidden="true"></span> Building' : esc(cap(b))}</span>`;
  function compareHtml(s, ordered) {
    const i = ordered.findIndex((x) => x.id === s.id);
    const fig = s.build?.image ? shot(s.build.image) : null;
    const empty = `<div class="cmp-empty">${s.build?.status === "built" ? "Trace didn't send an image of this frame." : "Not built yet. The Figma frame appears here after the build."}</div>`;
    const proto = `<img src="${shot(s.screenshot)}" alt="Prototype: ${esc(title(s))}" />`;
    const mode = fig ? S.cmpMode : "side";
    const body =
      mode === "side"
        ? `<div class="cmp-side"><figure><figcaption>Prototype</figcaption>${proto}</figure><figure><figcaption>Figma ${s.build?.url ? `<a href="${esc(s.build.url)}" target="_blank" rel="noopener">open ↗</a>` : ""}</figcaption>${fig ? `<img src="${fig}" alt="Figma: ${esc(title(s))}" />` : empty}</figure></div>`
        : `<div class="cmp-overlay">${proto}<img src="${fig}" alt="Figma overlay" style="opacity:${S.cmpOpacity / 100}" /></div>`;
    const nav = (j, label, sym) =>
      ordered[j] ? `<a class="btn sm icon" aria-label="${label}" href="#/run/${encodeURIComponent(S.runId)}/build/${encodeURIComponent(ordered[j].id)}">${sym}</a>` : `<button class="btn sm icon" aria-label="${label}" disabled>${sym}</button>`;
    return `<section class="compare" aria-label="Compare ${esc(title(s))}">
      <div class="detail-top">
        <a class="btn sm" href="#/run/${encodeURIComponent(S.runId)}/build">← All screens</a>
        <h2 class="t">${esc(title(s))}</h2><span class="spacer"></span>
        <div class="seg" role="group" aria-label="Compare mode">
          <button data-act="cmp-mode" data-v="side" aria-pressed="${mode === "side"}">Side by side</button>
          <button data-act="cmp-mode" data-v="overlay" aria-pressed="${mode === "overlay"}" ${fig ? "" : "disabled"}>Overlay</button>
        </div>
        ${mode === "overlay" ? `<label class="muted">Figma opacity <input type="range" min="0" max="100" value="${S.cmpOpacity}" data-act="cmp-opacity" /></label>` : ""}
        ${nav(i - 1, "Previous screen", "‹")}<span class="muted">${i + 1} / ${ordered.length}</span>${nav(i + 1, "Next screen", "›")}
      </div>
      <div class="compare-body">${body}</div>
      <div class="compare-foot">
        <button class="btn ok" data-act="verdict-ok" ${s.build?.status === "built" ? "" : "disabled"}>✓ Looks right</button>
        <input type="text" id="fixNote" placeholder="What's wrong? (optional)" aria-label="What needs fixing" value="${esc(s.review?.verdict === "fix" ? s.review.note : "")}" />
        <button class="btn danger" data-act="verdict-fix" ${["built", "failed"].includes(s.build?.status) ? "" : "disabled"}>Needs fix</button>
        ${s.review ? `<span class="badge ${s.review.verdict === "ok" ? "ok" : "bad"}">${s.review.verdict === "ok" ? "Marked: looks right" : "Marked: needs fix"}</span>` : ""}
      </div></section>`;
  }

  // ---------------- history
  function renderHistory() {
    const log = [...run().log].reverse();
    $("view-history").innerHTML = `<div class="page"><h2>History</h2><p class="lead">Everything Trace and you did in this run.</p>
      <div class="log">${
        log.length
          ? log.map((l) => `<div><span class="t">${new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span class="k-${l.kind}">${l.kind === "designer" ? "You" : "Trace"}</span><span>${esc(l.msg.replace(/^Designer:?\s*/, (m) => "").replace(/^./, (c) => c.toUpperCase()))}</span></div>`).join("")
          : '<div class="empty">Nothing yet.</div>'
      }</div></div>`;
  }

  // ------------------------------------------------------------ actions
  async function arrange(screens, stepOrder) {
    await post("/api/arrange", { screens, stepOrder });
    announce("Flow rearranged");
  }
  async function moveScreen(id, step, index) {
    const cols = columns();
    const col = cols.find((c) => c.step === step);
    const list = col ? col.screens.filter((x) => x.id !== id) : [];
    list.splice(Math.max(0, Math.min(index, list.length)), 0, byId(id));
    const stepOrder = cols.map((c) => c.step);
    if (!stepOrder.includes(step)) stepOrder.push(step);
    await arrange(list.map((x, i) => ({ id: x.id, step, order: i * 10 })), stepOrder);
  }
  const newStepName = (base) => {
    const steps = columns().map((c) => c.step);
    let n = base, i = 2;
    while (steps.includes(n)) n = `${base} (${i++})`;
    return n;
  };

  function openAdd(type, screenId) {
    const sel = $("addAfter");
    sel.innerHTML = live().map((x) => `<option value="${x.id}">${esc(title(x))}</option>`).join("");
    if (screenId) sel.value = screenId;
    $("addType").value = type;
    $("addText").value = "";
    $("quickStates").innerHTML = `<legend>Common states</legend>${QUICK_STATES.map((q) => `<button type="button" class="btn sm" data-quick="${q}">${q}</button>`).join("")}`;
    $("quickStates").hidden = type !== "add-state";
    $("addDialog").showModal();
  }
  $("addType").addEventListener("change", () => ($("quickStates").hidden = $("addType").value !== "add-state"));
  $("quickStates").addEventListener("click", (e) => {
    const q = e.target.dataset.quick;
    if (q) $("addText").value = $("addText").value ? `${$("addText").value}, ${q}` : q;
  });
  $("addDialog").addEventListener("close", async () => {
    if ($("addDialog").returnValue !== "ok") return;
    const text = $("addText").value.trim();
    if (!text) return toast("Describe what to add");
    const type = $("addType").value;
    await post("/api/request", { type, after: $("addAfter").value, screenId: type === "add-state" ? $("addAfter").value : null, text });
    toast("Trace will capture it");
  });

  function openApprove() {
    const L = live();
    const els = L.flatMap((s) => (s.elements || []).filter(meaningful));
    const n = (d) => els.filter((e) => e.decision === d).length;
    const removed = run().screens.length - L.length;
    const steps = new Set(L.map((s) => s.step)).size;
    const p = run().project || {};
    const links = run().edges.filter((e) => byId(e.from) && byId(e.to) && byId(e.from).status !== "removed" && byId(e.to).status !== "removed").length;
    $("approveBody").innerHTML = `
      <div class="sum-grid">
        <div class="stat"><div class="v">${steps}</div><div class="l">Steps</div></div>
        <div class="stat"><div class="v">${L.length}</div><div class="l">Frames (incl. states)</div></div>
        <div class="stat"><div class="v">${links}</div><div class="l">Prototype links</div></div>
      </div>
      ${
        matchingDone()
          ? `<div class="sum-grid">
        <div class="stat ok"><div class="v">${n("component")}</div><div class="l">Library components</div></div>
        <div class="stat warn"><div class="v">${n("detached") + n("undecided")}</div><div class="l">Detached nearest${n("undecided") ? ` (incl. ${n("undecided")} not decided)` : ""}</div></div>
        <div class="stat"><div class="v">${n("frames")}</div><div class="l">Plain frames</div></div></div>`
          : `<div class="warnbox">Components haven't been matched to the library yet. Trace will match them while building; anything without a match becomes the detached nearest component.</div>`
      }
      <ul class="sum-list">
        <li>Library: <b>${esc(p.library || "—")}</b>${p.scenario ? ` · Scenario: <b>${esc(p.scenario)}</b>` : ""}</li>
        <li>Destination: <b>${run().figma?.fileUrl ? "the linked Figma file" : "a new Figma file in your drafts"}</b>, on a page named after the flow</li>
        ${removed ? `<li>${removed} removed screen${removed > 1 ? "s are" : " is"} left out</li>` : ""}
        ${n("skip") ? `<li>${n("skip")} skipped element${n("skip") > 1 ? "s" : ""} won't be placed</li>` : ""}
        <li>Each frame gets its handoff note. You can compare every screen here afterwards.</li>
      </ul>`;
    $("approveDialog").showModal();
  }
  $("deleteDialog").addEventListener("close", async () => {
    if ($("deleteDialog").returnValue !== "ok") return;
    const name = S.project?.name;
    await post("/api/project/delete", { id: S.projectId, withRuns: !$("keepRuns").checked });
    S.project = null;
    toast(`Deleted “${name}”`);
    announce("Project deleted");
    location.hash = "#/";
  });
  $("approveDialog").addEventListener("close", async () => {
    if ($("approveDialog").returnValue !== "ok") return;
    await post("/api/approve", {});
    toast("Approved. Trace will start building");
    announce("Flow approved");
  });

  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest("[data-act], .card, #approveBtn, #approveWhy, #todoBtn, [data-zoom]");
    if (!t) return;
    if (t.id === "approveBtn") return openApprove();
    if (t.id === "approveWhy") {
      S.todoOpen = true;
      return S.tab !== "flow" || S.screenId ? routeTo("flow") : render();
    }
    if (t.id === "todoBtn") {
      const showing = S.todoOpen && S.tab === "flow" && !S.screenId;
      S.todoOpen = !showing;
      if (S.tab !== "flow" || S.screenId) {
        S.todoOpen = true;
        return routeTo("flow");
      }
      return render();
    }
    if (t.dataset.zoom) {
      const z = t.dataset.zoom;
      if (z === "fit") fit();
      else if (z === "reset") setZoom(1);
      else setZoom(S.zoom + (z === "in" ? 0.1 : -0.1));
      return;
    }
    if (t.classList.contains("card")) return routeTo("flow", t.dataset.screen);
    const act = t.dataset.act;
    const s = S.screenId && byId(S.screenId);
    switch (act) {
      case "open":
        return routeTo("flow", t.dataset.id);
      case "back":
        return routeTo("flow");
      case "prev":
      case "next": {
        const o = flatOrder();
        const i = o.findIndex((x) => x.id === S.screenId) + (act === "next" ? 1 : -1);
        if (o[i]) routeTo("flow", o[i].id);
        return;
      }
      case "add-state":
        return openAdd("add-state", t.dataset.id);
      case "add-screen":
        return openAdd("add-screen", flatOrder().at(-1)?.id);
      case "answer":
      case "answer-free": {
        const qid = t.closest("[data-q]").dataset.q;
        const answer = act === "answer" ? t.dataset.answer : prompt("Your answer");
        if (!answer) return;
        await post("/api/answer", { id: qid, answer });
        return toast("Answer sent to Trace");
      }
      case "sg-add":
      case "sg-dismiss":
        await post("/api/suggestion", { id: t.closest("[data-g]").dataset.g, action: act === "sg-add" ? "add" : "dismiss" });
        return toast(act === "sg-add" ? "Trace will capture it" : "Dismissed");
      case "close-todo":
        S.todoOpen = false;
        return render();
      case "approve":
        return openApprove();
      case "shot-fit":
      case "shot-100":
        S.fitShot = act === "shot-fit";
        return renderDetail();
      case "overlays":
        S.overlays = !S.overlays;
        return renderDetail();
      case "show-all":
        S.showAll = !S.showAll;
        return renderDetail();
      case "remove":
        await post("/api/request", { type: "remove", screenId: s.id });
        return toast("Removed from the flow. You can restore it");
      case "restore":
        await post("/api/request", { type: "restore", screenId: s.id });
        return toast("Restored");
      case "move-up":
      case "move-down": {
        const col = columns().find((c) => c.step === s.step);
        const i = col.screens.findIndex((x) => x.id === s.id);
        return moveScreen(s.id, s.step, i + (act === "move-up" ? -1 : 1));
      }
      case "make-main": {
        const col = columns().find((c) => c.step === s.step);
        const rest = col.screens.filter((x) => x.id !== s.id);
        return arrange([{ id: s.id, step: s.step, order: 0, main: true }, ...rest.map((x, i) => ({ id: x.id, step: s.step, order: (i + 1) * 10 }))]);
      }
      case "cfilter":
        S.compFilter = t.dataset.v;
        return renderComponents();
      case "cmp-mode":
        S.cmpMode = t.dataset.v;
        return renderBuild();
      case "verdict-ok":
      case "verdict-fix": {
        const id = S.compareId;
        await post("/api/validate", { screenId: id, verdict: act === "verdict-ok" ? "ok" : "fix", note: $("fixNote")?.value || "" });
        toast(act === "verdict-ok" ? "Marked as looking right" : "Sent to Trace to fix");
        const o = flatOrder().filter((x) => x.status !== "removed");
        const next = o[o.findIndex((x) => x.id === id) + 1];
        if (next && act === "verdict-ok") routeTo("build", next.id);
        return;
      }
      case "copy-prompt":
        navigator.clipboard?.writeText($("examplePrompt").textContent);
        return toast("Copied");
    }
  });

  document.addEventListener("change", async (ev) => {
    const t = ev.target;
    if (t.dataset.decide) {
      await post("/api/decide", { screenId: t.dataset.screen, elementId: t.dataset.decide, decision: t.value });
      return announce("Decision saved");
    }
    if (t.dataset.multi) {
      const items = JSON.parse(t.dataset.multi);
      await post("/api/decide", { decision: t.value, items });
      return toast(`Applied to ${items.length} screens`);
    }
    if (t.dataset.groupDecide) {
      const rows = groupsFor().get(t.dataset.groupDecide) || [];
      await post("/api/decide", { decision: t.value, items: rows.map(({ s, e }) => ({ screenId: s.id, elementId: e.id })) });
      return toast(`${rows.length} elements set to “${DECISIONS.find(([v]) => v === t.value)[1]}”`);
    }
    if (t.dataset.act === "comp-all") {
      S.compShowAll = t.checked;
      return renderComponents();
    }
    if (!S.screenId) return;
    if (t.id === "fName") return post("/api/screen", { id: S.screenId, name: t.value });
    if (t.id === "fState") return post("/api/screen", { id: S.screenId, state: t.value.trim() || "default" });
    if (t.id === "fNotes") {
      await post("/api/screen", { id: S.screenId, notes: t.value });
      return toast("Handoff note saved");
    }
    if (t.id === "fStep") {
      const step = t.value === "__new" ? newStepName(byId(S.screenId).name) : t.value;
      const col = columns().find((c) => c.step === step);
      return moveScreen(S.screenId, step, col ? col.screens.length : 0);
    }
  });
  document.addEventListener("input", (ev) => {
    if (ev.target.dataset.act === "cmp-opacity") {
      S.cmpOpacity = Number(ev.target.value);
      const img = document.querySelector(".cmp-overlay img + img");
      if (img) img.style.opacity = S.cmpOpacity / 100;
    }
  });
  document.addEventListener(
    "toggle",
    (ev) => {
      const g = ev.target.dataset?.group;
      if (!g) return;
      if (ev.target.open) S.openGroups.add(g);
      else S.openGroups.delete(g);
    },
    true
  );
  document.addEventListener("focusout", () => setTimeout(() => S.pending && !$("detail").contains(document.activeElement) && renderDetail(), 0));

  // Highlight an element on the screenshot while hovering / focusing its row.
  const highlight = (id) => document.querySelectorAll(".ov").forEach((o) => o.classList.toggle("hl", !!id && o.dataset.ov === id));
  document.addEventListener("mouseover", (ev) => highlight(ev.target.closest(".el")?.dataset.el));
  document.addEventListener("focusin", (ev) => highlight(ev.target.closest(".el")?.dataset.el));

  // ---------------- drag & drop on the canvas
  const board = $("board");
  const clearDnD = () => {
    board.querySelectorAll(".drop-target, .drag-over").forEach((x) => x.classList.remove("drop-target", "drag-over"));
    board.querySelectorAll(".drop-line").forEach((x) => x.remove());
  };
  board.addEventListener("dragstart", (ev) => {
    const c = ev.target.closest(".card");
    const h = ev.target.closest("[data-step-head]");
    if (c) {
      S.dragId = c.dataset.screen;
      c.classList.add("dragging");
    } else if (h) S.dragStep = h.dataset.stepHead;
    ev.dataTransfer.setData("text/plain", S.dragId || S.dragStep || "");
    ev.dataTransfer.effectAllowed = "move";
  });
  board.addEventListener("dragend", () => {
    S.dragId = S.dragStep = null;
    board.querySelectorAll(".dragging").forEach((x) => x.classList.remove("dragging"));
    clearDnD();
  });
  const dropIndex = (col, y) => {
    const cards = [...col.querySelectorAll(".card")].filter((c) => c.dataset.screen !== S.dragId);
    const i = cards.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return { i: i < 0 ? cards.length : i, cards };
  };
  board.addEventListener("dragover", (ev) => {
    const col = ev.target.closest(".column");
    if (!col || (!S.dragId && !S.dragStep)) return;
    ev.preventDefault();
    clearDnD();
    if (S.dragStep) return col.querySelector(".col-head")?.classList.add("drag-over");
    if (col.classList.contains("ghost")) return col.querySelector(".add-tile").classList.add("drop-target");
    col.classList.add("drop-target");
    const { i, cards } = dropIndex(col, ev.clientY);
    const line = document.createElement("div");
    line.className = "drop-line";
    (cards[i] || col.querySelector(".add-tile")).before(line);
  });
  board.addEventListener("drop", async (ev) => {
    const col = ev.target.closest(".column");
    if (!col) return;
    ev.preventDefault();
    const dragId = S.dragId, dragStep = S.dragStep;
    const idx = dragId ? dropIndex(col, ev.clientY).i : 0;
    clearDnD();
    if (dragStep) {
      const target = col.dataset.step;
      if (!target || target === dragStep) return;
      const order = columns().map((c) => c.step).filter((x) => x !== dragStep);
      order.splice(order.indexOf(target), 0, dragStep);
      return arrange([], order);
    }
    if (!dragId) return;
    if (col.classList.contains("ghost")) return moveScreen(dragId, newStepName(byId(dragId).name), 0);
    await moveScreen(dragId, col.dataset.step, idx);
  });

  // ---------------- keyboard
  document.addEventListener("keydown", (ev) => {
    if (document.querySelector("dialog[open]")) return;
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (ev.key === "Escape") {
      if (S.compareId) return routeTo("build");
      if (S.screenId) return routeTo("flow");
      if (S.todoOpen && window.innerWidth <= 900) {
        S.todoOpen = false;
        return render();
      }
    }
    if (typing || !S.run || S.route !== "run") return;
    if (S.screenId && (ev.key === "ArrowRight" || ev.key === "ArrowLeft")) {
      ev.preventDefault();
      return document.querySelector(`[data-act="${ev.key === "ArrowRight" ? "next" : "prev"}"]`)?.click();
    }
    if (S.tab === "flow" && !S.screenId) {
      if (ev.key === "+" || ev.key === "=") return setZoom(S.zoom + 0.1);
      if (ev.key === "-") return setZoom(S.zoom - 0.1);
      if (ev.key === "0") return setZoom(1);
      if (ev.key === "!" || (ev.shiftKey && ev.code === "Digit1")) return fit();
      const cardEl = document.activeElement?.closest?.(".card");
      if (cardEl && ev.key.startsWith("Arrow")) {
        ev.preventDefault();
        const cols = columns();
        const ci = cols.findIndex((c) => c.screens.some((x) => x.id === cardEl.dataset.screen));
        const ri = cols[ci].screens.findIndex((x) => x.id === cardEl.dataset.screen);
        let tc = ci, tr = ri;
        if (ev.key === "ArrowRight") (tc = Math.min(cols.length - 1, ci + 1)), (tr = 0);
        if (ev.key === "ArrowLeft") (tc = Math.max(0, ci - 1)), (tr = 0);
        if (ev.key === "ArrowDown") tr = Math.min(cols[ci].screens.length - 1, ri + 1);
        if (ev.key === "ArrowUp") tr = Math.max(0, ri - 1);
        const el = document.querySelector(`.card[data-screen="${cols[tc].screens[tr].id}"]`);
        el?.focus();
        el?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
  });
  $("boardScroll").addEventListener(
    "wheel",
    (ev) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      setZoom(S.zoom * (ev.deltaY < 0 ? 1.08 : 0.93));
    },
    { passive: false }
  );
  window.addEventListener("resize", () => S.tab === "flow" && S.run && (applyZoom(), drawEdges()));
  window.addEventListener("hashchange", onRoute);

  onRoute().then(connect);
  // Keep the AI-tool status fresh everywhere (the heartbeat file changes every few seconds).
  setInterval(async () => {
    try {
      S.engine = await api("/api/engine");
    } catch {
      return;
    }
    renderEngine();
  }, 4000);
  setInterval(async () => {
    if (S.route !== "home" && S.route !== "project") return;
    const was = S.engine?.connected;
    if (S.route === "home") await loadHome().catch(() => {});
    else await loadProject().catch(() => {});
    if (S.engine?.connected !== was) {
      announce(S.engine?.connected ? "AI tool connected" : "AI tool disconnected");
      render();
    }
  }, 5000);
})();
