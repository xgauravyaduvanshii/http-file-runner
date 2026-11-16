/**
 * Executes requests with the built-in `fetch` (Node 18+), in order,
 * carrying captured variables from one request to the next.
 *
 * Request headers are templated with `{{VAR}}` but their *values* are
 * never written to the JSON report or to stdout by this module — the
 * CLI prints method, URL, status and body only. A `curl` export is the
 * one place a header value appears, and only because the user asked
 * for that exact command.
 */
import { runAssertions, type AssertionResult } from "./assert.js";
import { extractCaptures } from "./capture.js";
import { substitute, type Vars } from "./env.js";
import type { RequestSpec } from "./parse.js";

export interface RunResult {
  name: string;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  passed: boolean;
  assertions: AssertionResult[];
  /** Pretty-printed body (JSON) or raw text, for display. */
  body: string;
  error?: string;
}

export interface ExecutedResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson: unknown;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function shellQuote(value: string): string {
  // POSIX single-quote escaping: ' -> '\'' 
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Build the `curl` equivalent of a request (after `{{VAR}}` substitution). */
export function buildCurl(spec: RequestSpec, vars: Vars): string {
  const url = substitute(spec.url, vars);
  const parts = ["curl", "-X", spec.method.toUpperCase(), shellQuote(url)];
  for (const [name, raw] of Object.entries(spec.headers ?? {})) {
    parts.push("-H", shellQuote(`${name}: ${substitute(raw, vars)}`));
  }
  if (spec.body !== undefined) {
    parts.push("--data", shellQuote(substitute(spec.body, vars)));
  }
  return parts.join(" ");
}

/** Execute one request. Throws on network errors, timeouts, and missing vars. */
export async function executeRequest(
  spec: RequestSpec,
  vars: Vars,
): Promise<ExecutedResponse> {
  const url = substitute(spec.url, vars);
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(spec.headers ?? {})) {
    headers[name] = substitute(raw, vars);
  }
  const body = spec.body !== undefined ? substitute(spec.body, vars) : undefined;
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: spec.method,
      headers,
      body: spec.method === "GET" || spec.method === "HEAD" ? undefined : body,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    let bodyJson: unknown = null;
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      bodyJson = null;
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    return {
      status: response.status,
      headers: responseHeaders,
      bodyText,
      bodyJson,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request "${spec.name}" timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Run one request, apply assertions and captures, and return its result. */
export async function runOne(
  spec: RequestSpec,
  vars: Vars,
): Promise<{ result: RunResult; captures: Vars }> {
  const started = performance.now();
  try {
    const response = await executeRequest(spec, vars);
    const assertions = runAssertions(spec.expect, response);
    const passed = assertions.every((a) => a.passed);
    let captures: Vars = {};
    if (spec.capture) {
      const bodyForCapture = response.bodyJson ?? response.bodyText;
      captures = extractCaptures(bodyForCapture, spec.capture);
    }
    const body = response.bodyJson !== null
      ? JSON.stringify(response.bodyJson, null, 2)
      : response.bodyText;
    return {
      result: {
        name: spec.name,
        method: spec.method,
        url: substitute(spec.url, vars),
        status: response.status,
        durationMs: response.durationMs,
        passed,
        assertions,
        body,
      },
      captures,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: {
        name: spec.name,
        method: spec.method,
        url: spec.url,
        status: null,
        durationMs: Math.round(performance.now() - started),
        passed: false,
        assertions: [],
        body: "",
        error: message,
      },
      captures: {},
    };
  }
}

export interface CollectionRun {
  results: RunResult[];
  passed: boolean;
  /** Final variable set, including captures (values are NOT logged by the CLI). */
  vars: Vars;
}

/**
 * Run requests in file order. A failed request does not stop the run —
 * later requests still execute — but a failed *capture* does stop it,
 * because the next request would be sent with a missing variable.
 */
export async function runCollection(
  specs: RequestSpec[],
  initialVars: Vars,
): Promise<CollectionRun> {
  const vars: Vars = { ...initialVars };
  const results: RunResult[] = [];
  for (const spec of specs) {
    const { result, captures } = await runOne(spec, vars);
    results.push(result);
    if (result.error && spec.capture) {
      break;
    }
    Object.assign(vars, captures);
  }
  return { results, passed: results.every((r) => r.passed), vars };
}
