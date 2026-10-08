#!/usr/bin/env node
// Runs Trace Studio and keeps it up to date with GitHub: every 30 seconds it
// checks the current branch on origin, pulls new commits, reinstalls packages
// if they changed, and restarts Studio. Open browser tabs reload by themselves.
//   npm run studio:live            (or: node bin/studio-live.mjs [studio args])
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVERY = Number(process.env.TRACE_LIVE_SECONDS || 30) * 1000;
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const time = () => new Date().toLocaleTimeString();
const log = (msg) => console.log(`  [${time()}] ${msg}`);

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
let child = null;
let fetchFailed = false;

function start() {
  child = spawn(process.execPath, [path.join(ROOT, "bin/trace.js"), "studio", ...process.argv.slice(2)], { cwd: ROOT, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (!stopping && !restarting) log(`Studio stopped (${signal || code}). Restarting…`), setTimeout(start, 1000);
  });
}
let restarting = false;
let stopping = false;
function restart() {
  restarting = true;
  child.once("exit", () => {
    restarting = false;
    start();
  });
  child.kill();
}

function check() {
  try {
    git("fetch", "--quiet", "origin", branch);
    if (fetchFailed) log("Reaching GitHub again.");
    fetchFailed = false;
  } catch (e) {
    // Say it once (not every 30s): offline, signed out of GitHub, or the branch is gone.
    if (!fetchFailed) log(`Can't check GitHub for updates: ${String(e.stderr || e.message).trim().split("\n")[0]}. Will keep trying.`);
    fetchFailed = true;
    return;
  }
  const local = git("rev-parse", "HEAD");
  const remote = git("rev-parse", "FETCH_HEAD");
  if (local === remote || git("merge-base", local, remote) === remote) return; // up to date (or ahead)
  const changed = git("diff", "--name-only", local, remote).split("\n");
  try {
    git("merge", "--ff-only", "--quiet", remote);
  } catch (e) {
    log(`New changes on GitHub, but they can't be pulled automatically: ${String(e.stderr || e.message).trim().split("\n")[0]}`);
    log("Commit or discard your local edits (git status), or pull by hand.");
    return;
  }
  log(`Updated to ${git("log", "-1", "--format=%h %s")}`);
  if (changed.some((f) => /^package(-lock)?\.json$/.test(f))) {
    log("Packages changed, running npm install…");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
  }
  restart();
}

start();
if (branch === "HEAD") log("Not on a branch (detached HEAD), so live updates are off. Run: git switch <branch>");
else {
  console.log(`  ▲ Trace Studio (live) — following origin/${branch}, checking every ${EVERY / 1000}s. Ctrl+C to stop.`);
  log(`On ${git("log", "-1", "--format=%h %s")}`);
  check();
  setInterval(check, EVERY);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => ((stopping = true), child?.kill(), process.exit(0)));
