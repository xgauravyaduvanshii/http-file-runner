/**
 * Environment variables: `.env` files, YAML env files, and `{{VAR}}`
 * template substitution.
 *
 * Security rule, enforced by convention and by `.gitignore`: real values
 * live in a local `.env` / `.env.<name>` file that is never committed.
 * Only placeholders go in `.env.example` and `examples/env.*.yaml`.
 * This module never prints a variable value — callers log names only.
 */
import { readFileSync, existsSync } from "node:fs";
import { parseYaml } from "./parse.js";

export type Vars = Record<string, string>;

/** Parse `.env` text. Supports `export KEY=value`, quotes, and `#` comments. */
export function parseDotEnv(text: string): Vars {
  const out: Vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    // Strip an inline comment only for unquoted values.
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Read a `.env` file if it exists, otherwise return `{}`. */
export function loadDotEnvFile(path: string): Vars {
  if (!existsSync(path)) return {};
  return parseDotEnv(readFileSync(path, "utf8"));
}

/**
 * Read a flat YAML env file (`KEY: value` per line). Used for
 * `examples/env.dev.yaml` / `env.prod.yaml` and `--env-file *.yaml`.
 */
export function loadEnvYamlFile(path: string): Vars {
  const doc = parseYaml(readFileSync(path, "utf8"));
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`Env file ${path} must be a flat mapping of KEY: value`);
  }
  const out: Vars = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    out[k] = v === null || v === undefined ? "" : String(v);
  }
  return out;
}

/** Load an env file, choosing the parser by extension (`.yaml`/`.yml` vs `.env`). */
export function loadEnvFile(path: string): Vars {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return loadEnvYamlFile(path);
  return loadDotEnvFile(path);
}

/**
 * Replace `{{VAR}}` placeholders. Supports a default: `{{VAR:-fallback}}`.
 * Throws listing the missing variable name — never the values of others.
 */
export function substitute(template: string, vars: Vars): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\s*\}\}/g, (_m, name: string, fallback?: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable: ${name}`);
  });
}

/** Names of `{{VAR}}` placeholders in a template that have no value. */
export function missingVars(template: string, vars: Vars): string[] {
  const missing: string[] = [];
  for (const m of template.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\s*\}\}/g)) {
    const name = m[1];
    if (!Object.prototype.hasOwnProperty.call(vars, name) && m[2] === undefined && !missing.includes(name)) {
      missing.push(name);
    }
  }
  return missing;
}

/** Merge variable sources in order; later sources win. */
export function mergeVars(...sources: Vars[]): Vars {
  return Object.assign({}, ...sources);
}
