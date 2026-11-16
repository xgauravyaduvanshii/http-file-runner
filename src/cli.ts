#!/usr/bin/env node
/**
 * http-run — run named HTTP requests from a requests.yaml file.
 *
 *   http-run run <name> [--file requests.yaml] [--env dev] [--ci] [--report out.json]
 *   http-run run --all [--file requests.yaml] [--env dev] [--ci]
 *   http-run list [--file requests.yaml]
 *   http-run export <name> [--file requests.yaml] [--env dev]
 *   http-run init [dir] [--force]
 *
 * Env resolution order (later wins): process.env, then the named
 * environment from the collection's `environments:` block, then
 * `.env` / `.env.<env>` in the working directory, then `--env-file`.
 * Captured variables from earlier requests win over all of those
 * for later requests in the same run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCollection, type Collection } from "./parse.js";
import { loadEnvFile, mergeVars, type Vars } from "./env.js";
import { buildCurl, runCollection, type RunResult } from "./run.js";

const VERSION = "0.1.0";

const SAMPLE_REQUESTS = `# http-file-runner sample collection.
# Copy this file, change BASE_URL, and run: http-run run --all
# Real values go in a local .env file (never committed) — see .env.example.
environments:
  dev:
    BASE_URL: http://localhost:3000
  staging:
    BASE_URL: https://staging.example.com
  prod:
    BASE_URL: https://api.example.com

requests:
  - name: login
    method: POST
    url: "{{BASE_URL}}/login"
    headers:
      Content-Type: application/json
    body: |
      {"username": "demo", "password": "demo"}
    capture:
      token: "$.token"
    expect:
      status: 200
      json:
        path: "$.token"

  - name: get-user
    method: GET
    url: "{{BASE_URL}}/users/1"
    headers:
      Authorization: "Bearer {{token}}"
    expect:
      status: 200
      json:
        path: "$.user.id"
        equals: 1
      header:
        content-type: "application/json"
`;

const SAMPLE_ENV_EXAMPLE = `# Copy to .env and fill in real values. Never commit .env.
BASE_URL=http://localhost:3000
TOKEN=
`;

interface Options {
  file?: string;
  env?: string;
  envFile?: string[];
  ci?: boolean;
  report?: string;
  json?: boolean;
  force?: boolean;
  all?: boolean;
}

function printHelp(): void {
  console.log(`http-run ${VERSION} — run named HTTP requests from requests.yaml

Usage:
  http-run run <name> [--file requests.yaml] [--env dev] [--env-file .env] [--ci] [--report out.json]
  http-run run --all [--file requests.yaml] [--env dev] [--ci]
  http-run list [--file requests.yaml]
  http-run export <name> [--file requests.yaml] [--env dev]
  http-run init [dir] [--force]
  http-run --help | --version

Options:
  --file <path>     Collection file (default: requests.yaml in the working directory)
  --env <name>      Environment: dev, staging, prod, or any name in environments:
  --env-file <path> Extra env file (.env or .yaml); repeatable, later files win
  --ci              Exit non-zero when any assertion fails (default in CI: same behaviour)
  --report <path>   Write a JSON report of the run to this file
  --json            Print the JSON report to stdout instead of the pretty output
  --force           init: overwrite existing files

Exit codes: 0 = all requests passed, 1 = an assertion failed / request errored,
2 = usage or collection error (bad file, unknown request, missing variable).`);
}

function parseArgs(argv: string[]): { command: string; positional: string[]; opts: Options } {
  const positional: string[] = [];
  const opts: Options = { envFile: [] };
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { command: "help", positional: [], opts };
    if (arg === "--version" || arg === "-v") return { command: "version", positional: [], opts };
    if (arg === "--all") { opts.all = true; continue; }
    if (arg === "--ci") { opts.ci = true; continue; }
    if (arg === "--json") { opts.json = true; continue; }
    if (arg === "--force") { opts.force = true; continue; }
    if (arg === "--file" || arg === "--env" || arg === "--env-file" || arg === "--report") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      if (arg === "--file") opts.file = value;
      if (arg === "--env") opts.env = value;
      if (arg === "--env-file") opts.envFile!.push(value);
      if (arg === "--report") opts.report = value;
      continue;
    }
    if (arg.startsWith("--file=")) { opts.file = arg.slice("--file=".length); continue; }
    if (arg.startsWith("--env=")) { opts.env = arg.slice("--env=".length); continue; }
    if (arg.startsWith("--env-file=")) { opts.envFile!.push(arg.slice("--env-file=".length)); continue; }
    if (arg.startsWith("--report=")) { opts.report = arg.slice("--report=".length); continue; }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    if (!command) command = arg;
    else positional.push(arg);
  }
  return { command, positional, opts };
}

function loadCollection(fileArg: string | undefined): { collection: Collection; file: string } {
  const file = fileArg ?? (existsSync("requests.yaml") ? "requests.yaml" : "requests.yaml");
  if (!existsSync(file)) {
    throw new Error(
      `Collection file not found: ${file}\nRun "http-run init" to create a sample requests.yaml, or pass --file <path>.`,
    );
  }
  return { collection: parseCollection(readFileSync(file, "utf8")), file };
}

function buildVars(collection: Collection, opts: Options): Vars {
  const envName = opts.env ?? "dev";
  const sources: Vars[] = [process.env as Vars];
  if (collection.environments?.[envName]) sources.push(collection.environments[envName]);
  const dotEnv = existsSync(".env") ? loadEnvFile(".env") : {};
  sources.push(dotEnv);
  const namedDotEnv = `.env.${envName}`;
  if (existsSync(namedDotEnv)) sources.push(loadEnvFile(namedDotEnv));
  for (const f of opts.envFile ?? []) sources.push(loadEnvFile(f));
  return mergeVars(...sources);
}

function printResult(result: RunResult): void {
  const status = result.status === null ? "ERROR" : String(result.status);
  const verdict = result.passed ? "PASS" : "FAIL";
  console.log(`\n${verdict} ${result.name} — ${result.method} ${result.url} — ${status} (${result.durationMs}ms)`);
  if (result.error) console.log(`  error: ${result.error}`);
  for (const a of result.assertions) {
    console.log(`  ${a.passed ? "✓" : "✗"} ${a.name}: expected ${a.expected}, got ${a.actual}`);
  }
  if (result.body) {
    console.log("  body:");
    for (const line of result.body.split("\n")) console.log(`    ${line}`);
  }
}

async function cmdRun(positional: string[], opts: Options): Promise<number> {
  const { collection } = loadCollection(opts.file);
  const vars = buildVars(collection, opts);
  let specs = collection.requests;
  if (!opts.all) {
    const name = positional[0];
    if (!name) throw new Error('Usage: http-run run <name>  or  http-run run --all');
    const found = collection.requests.find((r) => r.name === name);
    if (!found) {
      const names = collection.requests.map((r) => r.name).join(", ");
      throw new Error(`Unknown request "${name}". Available: ${names}`);
    }
    specs = [found];
  }
  const { results, passed } = await runCollection(specs, vars);
  if (opts.json) {
    console.log(JSON.stringify({ passed, results }, null, 2));
  } else {
    for (const r of results) printResult(r);
    const failed = results.filter((r) => !r.passed).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} failed` : ""}`);
  }
  if (opts.report) {
    writeFileSync(opts.report, JSON.stringify({ passed, results }, null, 2) + "\n");
    console.log(`Report written to ${opts.report}`);
  }
  // --ci makes failures fail the process; without it, a failed assertion
  // still exits 1 so scripts cannot silently ignore it. Use --json/--report
  // to inspect the details.
  return passed ? 0 : 1;
}

function cmdList(opts: Options): number {
  const { collection } = loadCollection(opts.file);
  for (const r of collection.requests) console.log(`${r.name}\t${r.method}\t${r.url}`);
  return 0;
}

function cmdExport(positional: string[], opts: Options): number {
  const name = positional[0];
  if (!name) throw new Error("Usage: http-run export <name>");
  const { collection } = loadCollection(opts.file);
  const spec = collection.requests.find((r) => r.name === name);
  if (!spec) throw new Error(`Unknown request "${name}".`);
  const vars = buildVars(collection, opts);
  console.log(buildCurl(spec, vars));
  return 0;
}

function cmdInit(positional: string[], opts: Options): number {
  const dir = resolve(positional[0] ?? ".");
  mkdirSync(dir, { recursive: true });
  const targets: Array<[string, string]> = [
    [join(dir, "requests.yaml"), SAMPLE_REQUESTS],
    [join(dir, ".env.example"), SAMPLE_ENV_EXAMPLE],
  ];
  for (const [path, contents] of targets) {
    if (existsSync(path) && !opts.force) {
      throw new Error(`${path} already exists — pass --force to overwrite it.`);
    }
    writeFileSync(path, contents);
    console.log(`Wrote ${path}`);
  }
  console.log('Next: copy .env.example to .env, set BASE_URL, then run "http-run run --all".');
  return 0;
}

async function main(): Promise<number> {
  const { command, positional, opts } = parseArgs(process.argv.slice(2));
  try {
    switch (command) {
      case "help":
      case "":
        printHelp();
        return 0;
      case "version":
        console.log(VERSION);
        return 0;
      case "run":
        return await cmdRun(positional, opts);
      case "list":
        return cmdList(opts);
      case "export":
        return cmdExport(positional, opts);
      case "init":
        return cmdInit(positional, opts);
      default:
        throw new Error(`Unknown command: ${command}\nRun "http-run --help" for usage.`);
    }
  } catch (err) {
    console.error(`http-run: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

process.exitCode = await main();
