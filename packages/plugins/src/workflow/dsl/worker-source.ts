/**
 * dsl/worker-source.ts — Ultra-thin dumb RPC worker (~185L inline JS, eval:true).
 *
 * All option/schema/boundary validation lives in Host TypeScript (`boundary.ts`).
 * The worker only provides:
 * - Terminability via worker_threads (`worker.terminate()`);
 * - Determinism via a single root VM context with `DETERMINISM_PRELUDE` (never re-wrapped on nested workflow());
 * - Stable tree coordinates `(workflowRootPath, scopePath, scopeCallIndex)` via AsyncLocalStorage;
 * - `parallel` / `pipeline` / nested `workflow()` drivers + uniform `realmParse` on Host returns.
 */
import { DETERMINISM_PRELUDE } from './meta.js'

/** Root workflow is depth 0; nested workflow() may nest up to 2 levels deep (0 -> 1 -> 2). */
export const MAX_WORKFLOW_NESTING_DEPTH = 2

export function buildWorkerSource(): string {
  return `"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { AsyncLocalStorage } = require("node:async_hooks");

const port = parentPort;
const ITEM_CAP = workerData.itemCap;
const PRELUDE = ${JSON.stringify(DETERMINISM_PRELUDE)};
const MAX_NESTING = ${MAX_WORKFLOW_NESTING_DEPTH};
const journalCtx = new AsyncLocalStorage();

let nextCallId = 1;
let nextPhaseIndex = 0;
let nestedCount = 0;
const pendingCalls = new Map();
let progressQueue = [];
let flushTimer = null;
let realmObjectPrototype = null;
let realmNewArray = null;
let realmPush = null;
let realmParse = null;
let realmContext = null;

function flushProgress() {
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  if (progressQueue.length === 0) return;
  const entries = progressQueue;
  progressQueue = [];
  port.postMessage({ type: "progress", entries });
}

function emit(entry) {
  progressQueue.push(entry);
  if (flushTimer === null) flushTimer = setTimeout(flushProgress, 0);
}

function callHost(method, payload) {
  flushProgress();
  return new Promise((resolve, reject) => {
    const callId = nextCallId++;
    pendingCalls.set(callId, { resolve, reject });
    port.postMessage({ type: "call", callId, method, payload });
  });
}

port.on("message", (msg) => {
  if (!msg || msg.type !== "response") return;
  const waiter = pendingCalls.get(msg.callId);
  if (!waiter) return;
  pendingCalls.delete(msg.callId);
  if (msg.ok) { waiter.resolve(msg.value); return; }
  const err = new Error(msg.error || "The workflow host rejected the call.");
  if (msg.fatal) err.workflowFatal = true;
  waiter.reject(err);
});

const isFatal = (e) => !!(e && typeof e === "object" && e.workflowFatal === true);

function toRealmValue(value) {
  if (value === undefined || value === null || typeof value !== "object") return value;
  return realmParse(JSON.stringify(value));
}

function toRealmArray(items) {
  const arr = realmNewArray();
  for (let i = 0; i < items.length; i++) realmPush(arr, items[i]);
  return arr;
}

function boundaryError(what, path) {
  return new Error("Cannot pass " + what + " across the workflow VM boundary (at " + path + ").");
}

function checkBoundary(value, path, allowUndefined, seen) {
  if (value === null) return value;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "number") { if (!Number.isFinite(value)) throw boundaryError("a non-finite number", path); return value; }
  if (kind === "undefined") { if (allowUndefined) return value; throw boundaryError("undefined", path); }
  if (kind === "bigint") throw boundaryError("a BigInt", path);
  if (kind === "symbol") throw boundaryError("a symbol", path);
  if (kind === "function") throw boundaryError("a function", path);
  if (kind !== "object") throw boundaryError("a " + kind, path);
  const visited = seen || new Set();
  if (visited.has(value)) throw boundaryError("a circular structure", path);
  visited.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) throw boundaryError("an object with symbol keys", path);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw boundaryError("a sparse array", path + "[" + i + "]");
      checkBoundary(value[i], path + "[" + i + "]", false, visited);
    }
    visited.delete(value);
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== realmObjectPrototype && proto !== Object.prototype) throw boundaryError("a non-plain object", path);
  for (const k of Object.keys(value)) checkBoundary(value[k], path + "." + k, false, visited);
  visited.delete(value);
  return value;
}

function describe(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.message === "string" && typeof v.stack === "string") return v.message;
  try { const j = JSON.stringify(v); if (j !== undefined) return j; } catch {}
  return String(v);
}

function toList(value, what) {
  if (!Array.isArray(value)) throw new Error(what + " expects an array.");
  const len = value.length >>> 0;
  if (len > ITEM_CAP) throw new Error(what + " was given " + len + " items, over the limit of " + ITEM_CAP + ".");
  const out = [];
  for (let i = 0; i < len; i++) out.push(value[i]);
  return out;
}

function makeScope(name, depth, rootPath) {
  const scope = {
    rootPath,
    path: rootPath,
    nextJournalCallIndex: 0,
    nextChildIndex: 0,
    name,
    depth,
    prefix: name === undefined ? "" : "\\u25b8 " + name,
    ambientPhaseIndex: undefined,
    ambientPhaseTitle: undefined,
    phaseIndexByTitle: new Map(),
  };
  const activeState = () => {
    const active = journalCtx.getStore();
    return active && active.rootPath === scope.rootPath ? active.state : scope;
  };
  const scopedTitle = (title) => (scope.prefix === "" ? title : title === undefined ? scope.prefix : scope.prefix + " \\u203a " + title);
  const definePhase = (title) => {
    let idx = scope.phaseIndexByTitle.get(title);
    if (idx !== undefined) return idx;
    idx = nextPhaseIndex++;
    scope.phaseIndexByTitle.set(title, idx);
    emit({ type: "workflow_phase", index: idx, title: scopedTitle(title) });
    return idx;
  };
  const resolvePhase = (explicit) => {
    if (typeof explicit === "string" && explicit.trim() !== "") {
      return { phaseIndex: definePhase(explicit), phaseTitle: scopedTitle(explicit) };
    }
    return { phaseIndex: scope.ambientPhaseIndex, phaseTitle: scope.ambientPhaseTitle };
  };
  const log = (message) => emit({ type: "workflow_log", message: (scope.prefix === "" ? "" : scope.prefix + ": ") + describe(message) });
  const writeConsole = function () {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) parts.push(describe(arguments[i]));
    log(parts.join(" "));
  };

  async function invokeAgent(prompt, opts, withMeta, goalMode) {
    if (opts !== undefined && opts !== null && typeof opts === "object" && !Array.isArray(opts)) {
      if (opts.schema !== undefined && typeof opts.schema === "object" && opts.schema !== null) {
        checkBoundary(opts.schema, "agent() opts.schema", false);
      }
    }
    const st = activeState();
    const explicitPhase = opts && typeof opts === "object" && !Array.isArray(opts) ? opts.phase : undefined;
    const ph = resolvePhase(explicitPhase);
    const value = await callHost("agent", {
      workflowRootPath: scope.rootPath,
      scopePath: st.path,
      scopeCallIndex: st.nextJournalCallIndex++,
      prompt,
      opts,
      ...(withMeta ? { withMeta: true } : {}),
      ...(goalMode ? { goalMode: true } : {}),
      ambientPhaseIndex: ph.phaseIndex,
      ambientPhaseTitle: ph.phaseTitle,
      scopePrefix: scope.prefix,
    });
    return toRealmValue(value);
  }

  scope.agent = (prompt, opts) => invokeAgent(prompt, opts, false, false);
  scope.agent.withMeta = (prompt, opts) => invokeAgent(prompt, opts, true, false);
  scope.goal = (spec) => invokeAgent(undefined, spec, true, true);
  scope.phase = (title) => {
    if (typeof title !== "string" || title.trim() === "") throw new Error("phase(title) requires a non-empty string.");
    scope.ambientPhaseIndex = definePhase(title);
    scope.ambientPhaseTitle = scopedTitle(title);
  };
  scope.log = log;
  scope.console = { log: writeConsole, info: writeConsole, warn: writeConsole, error: writeConsole, debug: writeConsole };
  scope.action = async (actionId, input, opts) => {
    if (input !== undefined && typeof input === "object" && input !== null && !Array.isArray(input)) {
      checkBoundary(input, "action('" + String(actionId) + "') input", false);
    }
    const st = activeState();
    const explicitPhase = opts && typeof opts === "object" && !Array.isArray(opts) ? opts.phase : undefined;
    const ph = resolvePhase(explicitPhase);
    const value = await callHost("action", {
      scopePath: st.path,
      scopeCallIndex: st.nextJournalCallIndex++,
      actionId,
      input,
      opts,
      ambientPhaseIndex: ph.phaseIndex,
      ambientPhaseTitle: ph.phaseTitle,
      scopePrefix: scope.prefix,
    });
    return toRealmValue(value);
  };
  scope.workflow = async (nameOrRef, args) => {
    if (scope.depth >= MAX_NESTING) {
      throw new Error("workflow() cannot be nested more than " + MAX_NESTING + " levels deep — you are already inside the workflow '" + scope.name + "'. Call the agents inline instead.");
    }
    let ref;
    if (typeof nameOrRef === "string") {
      if (nameOrRef.trim() === "") throw new Error("workflow(nameOrRef) expects a non-empty name.");
      ref = { name: nameOrRef };
    } else if (nameOrRef && typeof nameOrRef === "object" && !Array.isArray(nameOrRef)) {
      const sp = nameOrRef.scriptPath !== undefined && nameOrRef.scriptPath !== null ? String(nameOrRef.scriptPath) : undefined;
      const nm = nameOrRef.name !== undefined && nameOrRef.name !== null ? String(nameOrRef.name) : undefined;
      if ((sp === undefined || sp.trim() === "") && (nm === undefined || nm.trim() === "")) {
        throw new Error("workflow({ ... }) expects a \`name\` or a \`scriptPath\`.");
      }
      ref = { ...(nm !== undefined ? { name: nm } : {}), ...(sp !== undefined ? { scriptPath: sp } : {}) };
    } else {
      throw new Error("workflow(nameOrRef) expects a saved workflow name or { scriptPath }.");
    }
    const label = ref.name !== undefined ? ref.name : ref.scriptPath;
    if (args !== undefined) checkBoundary(args, 'workflow("' + label + '") args', false);
    if (nestedCount >= workerData.nestedCap) {
      const err = new Error("Workflow exceeded its cap of " + workerData.nestedCap + " nested workflow() calls.");
      err.workflowFatal = true;
      throw err;
    }
    nestedCount++;
    const parentState = activeState();
    const childPath = parentState.path + "/" + parentState.nextChildIndex++;
    let loaded;
    try {
      loaded = await callHost("workflow", ref);
    } catch (error) {
      if (isFatal(error)) throw error;
      throw new Error('workflow("' + label + '"): ' + describe(error));
    }
    const child = makeScope(loaded.name, scope.depth + 1, childPath);
    child.ambientPhaseIndex = nextPhaseIndex++;
    child.ambientPhaseTitle = child.prefix;
    emit({ type: "workflow_phase", index: child.ambientPhaseIndex, title: child.prefix });

    let fn;
    try {
      fn = new vm.Script("(async (agent, phase, log, workflow, action, console, args, goal) => {\\n" + loaded.body + "\\n})", {
        filename: "workflow:" + loaded.name + ".js",
        lineOffset: -1,
      }).runInContext(realmContext);
    } catch (error) {
      throw new Error('workflow("' + label + '"): ' + describe(error));
    }
    const value = await journalCtx.run({ rootPath: child.rootPath, state: child }, () =>
      fn(child.agent, child.phase, child.log, child.workflow, child.action, child.console, toRealmValue(args), child.goal)
    );
    checkBoundary(value, 'the result of workflow("' + label + '")', true);
    return value;
  };
  return scope;
}

function branchRunner() {
  const active = journalCtx.getStore();
  if (!active) throw new Error("Workflow journal context is unavailable.");
  const basePath = active.state.path + "/" + active.state.nextChildIndex++;
  return (index, fn) => {
    const state = { path: basePath + "/" + index, nextJournalCallIndex: 0, nextChildIndex: 0 };
    return journalCtx.run({ rootPath: active.rootPath, state }, fn);
  };
}

async function parallel(thunks) {
  const list = toList(thunks, "parallel(thunks)");
  for (let i = 0; i < list.length; i++) {
    if (typeof list[i] !== "function") throw new Error("parallel(thunks) expects an array of functions; item " + i + " is not one.");
  }
  const inBranch = branchRunner();
  const settled = await Promise.all(list.map((thunk, i) => inBranch(i, async () => {
    try { return await thunk(); } catch (err) { if (isFatal(err)) throw err; return null; }
  })));
  return toRealmArray(settled);
}

async function pipeline(items, ...stages) {
  const list = toList(items, "pipeline(items, ...stages)");
  for (let i = 0; i < stages.length; i++) {
    if (typeof stages[i] !== "function") throw new Error("pipeline(items, ...stages) expects stages to be functions; stage " + i + " is not one.");
  }
  const inBranch = branchRunner();
  const settled = await Promise.all(list.map((item, i) => inBranch(i, async () => {
    let val = item;
    for (let s = 0; s < stages.length; s++) {
      try { val = await stages[s](val, item, i); } catch (err) { if (isFatal(err)) throw err; return null; }
    }
    return val;
  })));
  return toRealmArray(settled);
}

async function main() {
  const root = makeScope(undefined, 0, "root");
  const sandbox = {
    agent: root.agent,
    goal: root.goal,
    parallel,
    pipeline,
    phase: root.phase,
    log: root.log,
    workflow: root.workflow,
    action: root.action,
    console: root.console,
  };
  realmContext = vm.createContext(sandbox, { name: "workflow", codeGeneration: { strings: false, wasm: false } });
  realmObjectPrototype = vm.runInContext("Object.prototype", realmContext);
  realmNewArray = vm.runInContext("(function () { return []; })", realmContext);
  realmPush = vm.runInContext("(function (a, v) { a.push(v); })", realmContext);
  realmParse = vm.runInContext("JSON.parse", realmContext);
  // Install determinism prelude once on the root realm (shared by root and all nested workflows).
  new vm.Script(PRELUDE, { filename: "workflow-prelude.js" }).runInContext(realmContext);
  sandbox.args = workerData.argsJson === undefined ? undefined : realmParse(workerData.argsJson);

  const script = new vm.Script("(async () => {\\n" + workerData.body + "\\n})()", {
    filename: "workflow.js",
    lineOffset: -1,
  });
  const value = await journalCtx.run({ rootPath: root.rootPath, state: root }, () => script.runInContext(realmContext));
  checkBoundary(value, "the workflow result", true);
  flushProgress();
  port.postMessage({ type: "complete", resultJson: value === undefined ? undefined : JSON.stringify(value) });
}

main().catch((err) => {
  flushProgress();
  port.postMessage({
    type: "error",
    message: err && err.message ? String(err.message) : String(err),
    stack: err && err.stack ? String(err.stack) : undefined,
  });
});
`
}

export const WORKER_SOURCE = buildWorkerSource()
