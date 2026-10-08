// A Trace session = one flow walked through one prototype.
// Owns the headless browser, the recorded actions, and the captured screens.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { extractInPage, describeTargetInPage } from "./extract.js";
import { extractLayout } from "./layout.js";
import { loadMapping } from "./mapping.js";

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "item";

export class TraceSession {
  constructor({ flowName, url, viewport, outDir, mappingFile, headless }) {
    this.id = `${slug(flowName)}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    this.flowName = flowName;
    this.startUrl = url;
    this.viewport = viewport;
    this.headless = headless;
    this.dir = path.resolve(outDir, this.id);
    this.mapping = loadMapping(mappingFile);
    this.screens = [];
    this.pendingActions = []; // actions since the last capture -> become prototype links
    this.mocks = [];
    this.log = [];
  }

  async start() {
    fs.mkdirSync(path.join(this.dir, "screens"), { recursive: true });
    this.browser = await chromium.launch({ headless: this.headless });
    this.context = await this.browser.newContext({ viewport: this.viewport, deviceScaleFactor: 2 });
    this.page = await this.context.newPage();
    this.consoleErrors = [];
    this.page.on("console", (m) => m.type() === "error" && this.consoleErrors.push(m.text()));
    this.inflight = new Set(); // fetch/xhr requests still pending (excluding deliberately hung mocks)
    this.hung = new Set();
    const isData = (req) => ["fetch", "xhr"].includes(req.resourceType());
    this.page.on("request", (req) => isData(req) && this.inflight.add(req));
    this.page.on("requestfinished", (req) => this.inflight.delete(req));
    this.page.on("requestfailed", (req) => this.inflight.delete(req));
    this.network = new Map(); // "GET /api/x" -> last status, used to pick endpoints to mock
    this.page.on("response", (r) => {
      const req = r.request();
      if (!["fetch", "xhr"].includes(req.resourceType())) return;
      const u = new URL(req.url());
      this.network.set(`${req.method()} ${u.origin}${u.pathname}`, r.status());
    });
    await this.page.goto(this.startUrl, { waitUntil: "networkidle" }).catch(() =>
      this.page.goto(this.startUrl, { waitUntil: "load" })
    );
    this.record({ type: "goto", url: this.startUrl });
    return this;
  }

  // Wait until the UI has finished reacting: no pending data requests (other
  // than mocks we deliberately hang) for a short quiet window, then let
  // animations/rendering catch up.
  async settle({ quietMs = 300, maxMs = 8000 } = {}) {
    const start = Date.now();
    let quietSince = null;
    while (Date.now() - start < maxMs) {
      const pending = [...this.inflight].filter((r) => !this.hung.has(r)).length;
      if (pending === 0) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= quietMs) break;
      } else quietSince = null;
      await new Promise((r) => setTimeout(r, 50));
    }
    await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  }

  record(entry) {
    this.log.push({ at: new Date().toISOString(), ...entry });
  }

  locator({ selector, text, role, name }) {
    if (selector) return this.page.locator(selector).first();
    if (role) return this.page.getByRole(role, name ? { name } : {}).first();
    if (text) return this.page.getByText(text, { exact: false }).first();
    throw new Error("Provide one of: selector, text, or role(+name).");
  }

  async act({ action, selector, text, role, name, value, url, key, ms }) {
    const page = this.page;
    let target = null;
    const needsTarget = ["click", "fill", "hover", "select", "check"].includes(action);
    const loc = needsTarget ? this.locator({ selector, text, role, name }) : null;
    if (loc) {
      await loc.waitFor({ state: "visible", timeout: 10000 });
      target = await loc.evaluate(describeTargetInPage);
    }
    switch (action) {
      case "goto":
        await page.goto(new URL(url, page.url()).href, { waitUntil: "networkidle" }).catch(() => {});
        break;
      case "click":
        await loc.click();
        break;
      case "fill":
        await loc.fill(value ?? "");
        break;
      case "hover":
        await loc.hover();
        break;
      case "select":
        await loc.selectOption(value);
        break;
      case "check":
        await loc.check();
        break;
      case "press":
        await page.keyboard.press(key || "Enter");
        break;
      case "scroll":
        await page.mouse.wheel(0, Number(value) || 600);
        break;
      case "wait":
        if (text) await page.getByText(text).first().waitFor({ timeout: ms || 10000 });
        else if (selector) await page.locator(selector).first().waitFor({ timeout: ms || 10000 });
        else await page.waitForTimeout(ms || 500);
        break;
      case "back":
        await page.goBack();
        break;
      case "reload":
        await page.reload({ waitUntil: "networkidle" }).catch(() => {});
        break;
      default:
        throw new Error(`Unknown action "${action}"`);
    }
    if (!["wait", "scroll"].includes(action)) await this.settle();
    const entry = { type: action, selector, text, role, name, value, url, key, target, pageUrl: page.url() };
    this.record(entry);
    if (["click", "press", "goto", "select", "check"].includes(action)) this.pendingActions.push(entry);
    return entry;
  }

  // Force UI states the happy path never shows: loading, empty, error.
  async mock({ urlPattern, status = 200, body, delayMs = 0, contentType = "application/json", hang = false }) {
    const handler = async (route) => {
      if (hang) {
        this.hung.add(route.request()); // never resolves -> loading state stays on screen
        return;
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      await route.fulfill({
        status,
        contentType,
        body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
      });
    };
    await this.page.route(urlPattern, handler);
    const m = { id: "m" + (this.mocks.length + 1), urlPattern, status, delayMs, hang, handler, active: true };
    this.mocks.push(m);
    this.record({ type: "mock", urlPattern, status, delayMs, hang });
    return m;
  }

  async clearMocks() {
    for (const m of this.mocks.filter((m) => m.active)) {
      await this.page.unroute(m.urlPattern, m.handler);
      m.active = false;
    }
    this.record({ type: "clear-mocks" });
  }

  async capture({ name, state = "default", notes = "", fullPage = true, fromScreen }) {
    await this.settle({ quietMs: 150, maxMs: 4000 });
    const index = this.screens.length + 1;
    const fileBase = `${String(index).padStart(2, "0")}-${slug(name)}-${slug(state)}`;
    const shotPath = path.join(this.dir, "screens", fileBase + ".png");
    await this.page.screenshot({ path: shotPath, fullPage });
    const extracted = await this.page.evaluate(extractInPage, {
      components: this.mapping.components,
      minArea: 64,
    });
    const layout = await this.page.evaluate(extractLayout, { fullPage });
    const layoutPath = path.join(this.dir, "screens", fileBase + ".layout.json");
    fs.writeFileSync(layoutPath, JSON.stringify(layout));
    const screen = {
      layout: path.relative(this.dir, layoutPath),
      id: "s" + index,
      index,
      name,
      state,
      notes,
      url: this.page.url(),
      screenshot: path.relative(this.dir, shotPath),
      viewport: this.viewport,
      size: { w: this.viewport.width, h: fullPage ? extracted.page.height : this.viewport.height },
      background: extracted.page.background,
      activeMocks: this.mocks.filter((m) => m.active).map(({ urlPattern, status, delayMs, hang }) => ({ urlPattern, status, delayMs, hang })),
      arrivedVia: this.pendingActions.splice(0),
      fromScreen: fromScreen || null,
      components: extracted.components,
      texts: extracted.texts,
      unmatched: extracted.unmatched,
      consoleErrors: this.consoleErrors.splice(0),
    };
    this.screens.push(screen);
    fs.writeFileSync(path.join(this.dir, "screens", fileBase + ".json"), JSON.stringify(screen, null, 2));
    this.record({ type: "capture", screen: screen.id, name, state });
    this.save();
    return { screen, shotPath };
  }

  async inspect() {
    const extracted = await this.page.evaluate(extractInPage, { components: this.mapping.components, minArea: 64 });
    const counts = {};
    for (const c of extracted.components) counts[c.component] = (counts[c.component] || 0) + 1;
    const unmatchedReact = {};
    const elements = extracted.unmatched.filter((u) => u.kind !== "container");
    for (const u of elements) {
      const k = u.reactComponent || "<" + u.tag + ">";
      unmatchedReact[k] = (unmatchedReact[k] || 0) + 1;
    }
    return {
      url: this.page.url(),
      title: extracted.page.title,
      mappingFile: this.mapping.file,
      mappingEntries: this.mapping.components.length,
      matched: counts,
      matchedDetail: extracted.components.slice(0, 40).map((c) => ({
        component: c.component,
        via: c.matchedVia,
        props: c.props,
        codeProps: c.codeProps,
        text: c.texts[0],
      })),
      unmatchedByType: unmatchedReact,
      layoutContainers: extracted.unmatched.length - elements.length,
      unmatched: elements.slice(0, 40).map((u) => ({ tag: u.tag, reactComponent: u.reactComponent, text: u.text, selector: u.selector, box: u.box })),
      network: [...this.network].map(([k, status]) => `${k} → ${status}`),
    };
  }

  reloadMapping() {
    this.mapping = loadMapping(this.mapping.file || undefined);
  }

  summaryOf(screen) {
    const counts = {};
    for (const c of screen.components) counts[c.component] = (counts[c.component] || 0) + 1;
    return {
      id: screen.id,
      name: screen.name,
      state: screen.state,
      url: screen.url,
      matchedComponents: counts,
      looseTextLayers: screen.texts.length,
      unmatched: screen.unmatched.filter((u) => u.kind !== "container").map((u) => ({
        id: u.id,
        tag: u.tag,
        reactComponent: u.reactComponent,
        text: u.text,
        box: u.box,
      })),
      arrivedVia: screen.arrivedVia.map((a) => `${a.type} ${a.target?.text || a.selector || a.url || ""}`.trim()),
      consoleErrors: screen.consoleErrors,
    };
  }

  save() {
    const data = {
      id: this.id,
      flowName: this.flowName,
      startUrl: this.startUrl,
      viewport: this.viewport,
      mappingFile: this.mapping.file,
      figmaFileKey: this.mapping.figmaFileKey,
      screens: this.screens,
      log: this.log,
    };
    fs.writeFileSync(path.join(this.dir, "session.json"), JSON.stringify(data, null, 2));
  }

  async close() {
    this.save();
    await this.browser?.close().catch(() => {});
  }
}
