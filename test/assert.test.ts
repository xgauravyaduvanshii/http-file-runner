import { describe, expect, it } from "vitest";
import { runAssertions, type HttpResponseLike } from "../src/assert.js";
import { extractCaptures, getJsonPath } from "../src/capture.js";
import { missingVars, parseDotEnv, substitute } from "../src/env.js";

function response(overrides: Partial<HttpResponseLike> = {}): HttpResponseLike {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify({ user: { id: 1, name: "Ada Lovelace" }, token: "abc" }),
    bodyJson: { user: { id: 1, name: "Ada Lovelace" }, token: "abc" },
    ...overrides,
  };
}

describe("assertions", () => {
  it("passes when status, json path/equals and header all match", () => {
    const results = runAssertions(
      {
        status: 200,
        json: { path: "$.user.id", equals: 1 },
        header: { "content-type": "application/json" },
      },
      response(),
    );
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("fails with a clear actual value when status or json value differ", () => {
    const results = runAssertions(
      { status: 404, json: { path: "$.user.id", equals: 2 } },
      response(),
    );
    expect(results.map((r) => r.passed)).toEqual([false, false]);
    expect(results[0].actual).toBe("200");
    expect(results[0].expected).toBe("404");
    expect(results[1].actual).toBe("1");
    expect(results[1].expected).toBe("2");
  });

  it("checks existence when expect.json.path has no equals", () => {
    expect(runAssertions({ json: { path: "$.token" } }, response())[0].passed).toBe(true);
    expect(runAssertions({ json: { path: "$.missing" } }, response())[0].passed).toBe(false);
  });

  it("checks expect.json.contains against a path value and against the whole body", () => {
    expect(runAssertions({ json: { path: "$.user.name", contains: "Ada" } }, response())[0].passed).toBe(true);
    expect(runAssertions({ json: { path: "$.user.name", contains: "Grace" } }, response())[0].passed).toBe(false);
    expect(runAssertions({ json: { contains: "Lovelace" } }, response())[0].passed).toBe(true);
  });

  it("checks expect.contains against the raw body text", () => {
    expect(runAssertions({ contains: "Ada Lovelace" }, response())[0].passed).toBe(true);
    expect(runAssertions({ contains: "nope" }, response())[0].passed).toBe(false);
  });

  it("matches headers case-insensitively by name and value", () => {
    const results = runAssertions({ header: { "Content-Type": "JSON" } }, response());
    expect(results[0].passed).toBe(true);
    expect(runAssertions({ header: { "x-missing": "1" } }, response())[0].passed).toBe(false);
  });

  it("returns no assertions when there is no expect block", () => {
    expect(runAssertions(undefined, response())).toEqual([]);
  });
});

describe("JSON paths and captures", () => {
  it("reads nested paths and array indexes", () => {
    const body = { user: { id: 1 }, items: [{ name: "a" }, { name: "b" }] };
    expect(getJsonPath(body, "$.user.id")).toEqual({ found: true, value: 1 });
    expect(getJsonPath(body, "$.items[1].name")).toEqual({ found: true, value: "b" });
    expect(getJsonPath(body, "$.items.0.name")).toEqual({ found: true, value: "a" });
    expect(getJsonPath(body, "$.nope")).toEqual({ found: false });
    expect(getJsonPath(body, "$.user.id.x")).toEqual({ found: false });
  });

  it("extracts captures and stringifies objects", () => {
    expect(extractCaptures({ token: "abc", user: { id: 1 } }, { token: "$.token", user: "$.user" })).toEqual({
      token: "abc",
      user: '{"id":1}',
    });
  });

  it("throws on a missing capture path instead of silently capturing empty", () => {
    expect(() => extractCaptures({ token: "abc" }, { token: "$.missing" })).toThrow(/Capture failed/);
  });
});

describe("env substitution", () => {
  it("substitutes {{VAR}} and supports {{VAR:-default}}", () => {
    expect(substitute("{{BASE_URL}}/users/{{ID}}", { BASE_URL: "http://x", ID: "1" })).toBe("http://x/users/1");
    expect(substitute("{{MISSING:-fallback}}", {})).toBe("fallback");
  });

  it("throws naming the missing variable", () => {
    expect(() => substitute("{{TOKEN}}", {})).toThrow(/Missing environment variable: TOKEN/);
    expect(missingVars("{{A}} and {{B}}", { A: "1" })).toEqual(["B"]);
  });

  it("parses .env files with quotes, export and comments", () => {
    const vars = parseDotEnv('export BASE_URL=http://localhost:3000 # local\nTOKEN="abc 123"\nEMPTY=\n# comment\n');
    expect(vars).toEqual({ BASE_URL: "http://localhost:3000", TOKEN: "abc 123", EMPTY: "" });
  });
});
