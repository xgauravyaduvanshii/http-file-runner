/**
 * Assertions on a finished HTTP response.
 *
 * Supported `expect` keys (see README for examples):
 *   - `status`: exact HTTP status code
 *   - `contains`: substring that must appear in the raw body
 *   - `json.path` (+ optional `json.equals`): value at a JSON path
 *   - `json.contains`: substring/value inside the JSON at `json.path`,
 *     or inside the whole JSON body when no path is given
 *   - `header.<name>`: substring match on a response header
 *     (header names are case-insensitive)
 */
import { getJsonPath } from "./capture.js";
import type { ExpectSpec } from "./parse.js";

export interface HttpResponseLike {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson: unknown;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function runAssertions(
  expect: ExpectSpec | undefined,
  response: HttpResponseLike,
): AssertionResult[] {
  const results: AssertionResult[] = [];
  if (!expect) return results;

  if (expect.status !== undefined) {
    results.push({
      name: "status",
      passed: response.status === expect.status,
      expected: String(expect.status),
      actual: String(response.status),
    });
  }

  if (expect.contains !== undefined) {
    results.push({
      name: "body contains",
      passed: response.bodyText.includes(expect.contains),
      expected: `body contains ${JSON.stringify(expect.contains)}`,
      actual: response.bodyText.length > 200 ? `${response.bodyText.slice(0, 200)}…` : response.bodyText,
    });
  }

  if (expect.json) {
    const { path, equals, contains } = expect.json;
    if (path !== undefined) {
      const { found, value } = getJsonPath(response.bodyJson, path);
      if (equals !== undefined) {
        results.push({
          name: `json ${path} equals`,
          passed: found && deepEqual(value, equals),
          expected: JSON.stringify(equals),
          actual: found ? JSON.stringify(value) : "<missing>",
        });
      } else if (contains === undefined) {
        results.push({
          name: `json ${path} exists`,
          passed: found,
          expected: "present",
          actual: found ? JSON.stringify(value) : "<missing>",
        });
      }
      if (contains !== undefined) {
        const haystack = found ? stringifyForContains(value) : "";
        results.push({
          name: `json ${path} contains`,
          passed: found && haystack.includes(String(contains)),
          expected: `contains ${JSON.stringify(contains)}`,
          actual: found ? haystack : "<missing>",
        });
      }
    } else if (contains !== undefined) {
      const haystack = stringifyForContains(response.bodyJson);
      results.push({
        name: "json contains",
        passed: haystack.includes(String(contains)),
        expected: `json contains ${JSON.stringify(contains)}`,
        actual: haystack.length > 200 ? `${haystack.slice(0, 200)}…` : haystack,
      });
    }
  }

  if (expect.header) {
    for (const [name, expected] of Object.entries(expect.header)) {
      const actual = headerValue(response.headers, name);
      results.push({
        name: `header ${name}`,
        passed: actual !== undefined && actual.toLowerCase().includes(expected.toLowerCase()),
        expected,
        actual: actual ?? "<missing>",
      });
    }
  }

  return results;
}

function stringifyForContains(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

export function allPassed(results: AssertionResult[]): boolean {
  return results.every((r) => r.passed);
}
