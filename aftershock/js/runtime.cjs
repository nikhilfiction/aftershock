"use strict";
/**
 * The tracing runtime for JavaScript/TypeScript tests. The test process loads
 * it first (NODE_OPTIONS=--require runtime.cjs); the instrumented code calls
 * run() at the start of every function (see instrument() in scanner.cjs).
 *
 * Who called whom is tracked with AsyncLocalStorage, which Node carries across
 * awaits, promises, timers and event emitters. So when createOrder emits an
 * event and a listener runs, the listener's caller is createOrder, even though
 * no line of code shows that call.
 *
 * Each new (caller, callee) pair is appended to AFTERSHOCK_TRACE_OUT at once,
 * so nothing is lost if a test worker is killed; call counts are added at exit.
 */

const { AsyncLocalStorage } = require("node:async_hooks");
const asyncHooks = require("node:async_hooks");
const fs = require("node:fs");

const OUT = process.env.AFTERSHOCK_TRACE_OUT;
const storage = new AsyncLocalStorage();
const counts = new Map();
let currentTest = null;      // the test case that started last, for calls with no caller (see below)

function record(caller, callee) {
  const key = `${caller}\t${callee}`;
  const n = counts.get(key);
  if (n === undefined) {
    counts.set(key, 1);
    if (OUT) {
      try { fs.appendFileSync(OUT, `${key}\n`); } catch { /* tracing must never break a test */ }
    }
  } else {
    counts.set(key, n + 1);
  }
}

/**
 * Runs one function's body as `name`. A call that comes in with no caller at
 * all, such as an HTTP request a test sent to a server it started earlier, is
 * credited to the test that is running.
 */
function run(name, body, isTest) {
  const caller = storage.getStore() ?? (isTest ? null : currentTest);
  if (caller && caller !== name) record(caller, name);
  if (isTest) currentTest = name;
  return storage.run(name, body);
}

process.on("exit", () => {
  if (!OUT) return;
  const lines = [];
  for (const [key, n] of counts) if (n > 1) lines.push(`#count\t${key}\t${n}\n`);
  try { if (lines.length) fs.appendFileSync(OUT, lines.join("")); } catch { /* ignore */ }
});

const runtime = { run };
globalThis.__aftershockRuntime = runtime;
// Jest runs tests in a separate global scope, but built-in modules are shared:
// the instrumented code finds the runtime here when globalThis does not have it.
asyncHooks.__aftershockRuntime = runtime;

module.exports = runtime;
