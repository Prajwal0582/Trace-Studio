// One shared data folder for every AI tool and Trace Studio, so it doesn't
// matter which folder a tool runs Trace from. Override with TRACE_HOME.
import os from "node:os";
import path from "node:path";

export const TRACE_HOME = path.resolve(process.env.TRACE_HOME || process.env.TRACE_OUT_DIR || path.join(os.homedir(), ".trace"));
