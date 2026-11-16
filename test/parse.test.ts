import { describe, expect, it } from "vitest";
import { parseCollection, parseYaml } from "../src/parse.js";

const SAMPLE = `
environments:
  dev:
    BASE_URL: http://localhost:3000
requests:
  - name: login
    method: POST
    url: "{{BASE_URL}}/login"
    headers:
      Content-Type: application/json
    body: |
      {"username": "demo"}
    capture:
      token: "$.token"
    expect:
      status: 200
      json:
        path: "$.token"
  - name: get-user
    method: GET
    url: "{{BASE_URL}}/users/1"
    expect:
      status: 200
      json:
        path: "$.user.id"
        equals: 1
`;

describe("parseYaml (minimal subset)", () => {
  it("parses nested maps, lists and scalars", () => {
    const doc = parseYaml("a: 1\nb:\n  c: hello\n  d: true\n") as Record<string, unknown>;
    expect(doc.a).toBe(1);
    expect((doc.b as Record<string, unknown>).c).toBe("hello");
    expect((doc.b as Record<string, unknown>).d).toBe(true);
  });

  it("parses quoted strings and numbers", () => {
    expect(parseYaml('x: "a b"\n')).toEqual({ x: "a b" });
    expect(parseYaml("x: 'it''s'\n")).toEqual({ x: "it's" });
    expect(parseYaml("x: 42\n")).toEqual({ x: 42 });
  });

  it("parses a list of scalars", () => {
    const doc = parseYaml("on:\n  - 500\n  - 502\n") as Record<string, unknown>;
    expect(doc.on).toEqual([500, 502]);
  });

  it("parses a list under a key at the same indent", () => {
    const doc = parseYaml("requests:\n- name: a\n- name: b\n") as Record<string, unknown>;
    expect(doc.requests).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("parses a literal block scalar for a body", () => {
    const doc = parseYaml("body: |\n  {\"a\": 1}\n  {\"b\": 2}\n") as Record<string, unknown>;
    expect(doc.body).toBe('{"a": 1}\n{"b": 2}');
  });

  it("rejects tab indentation instead of guessing", () => {
    expect(() => parseYaml("a:\n\tb: 1\n")).toThrow(/tab/);
  });
});

describe("parseCollection", () => {
  it("parses a full collection with environments, capture and expect", () => {
    const col = parseCollection(SAMPLE);
    expect(col.requests).toHaveLength(2);
    expect(col.requests[0].name).toBe("login");
    expect(col.requests[0].method).toBe("POST");
    expect(col.requests[0].capture).toEqual({ token: "$.token" });
    expect(col.requests[0].expect?.status).toBe(200);
    expect(col.requests[1].expect?.json?.equals).toBe(1);
    expect(col.environments?.dev.BASE_URL).toBe("http://localhost:3000");
  });

  it("defaults a missing method to GET", () => {
    const col = parseCollection("requests:\n  - name: ping\n    url: http://localhost:3000/ping\n");
    expect(col.requests[0].method).toBe("GET");
  });

  it("rejects a missing requests list", () => {
    expect(() => parseCollection("foo: bar\n")).toThrow(/requests/);
  });

  it("rejects a request with no name or no url", () => {
    expect(() => parseCollection("requests:\n  - method: GET\n    url: http://x/\n")).toThrow(/name/);
    expect(() => parseCollection("requests:\n  - name: a\n    method: GET\n")).toThrow(/url/);
  });

  it("rejects duplicate request names", () => {
    expect(() =>
      parseCollection("requests:\n  - name: a\n    url: http://x/\n  - name: a\n    url: http://x/\n"),
    ).toThrow(/Duplicate request name/);
  });

  it("rejects an unsupported method and a non-integer expect.status", () => {
    expect(() =>
      parseCollection("requests:\n  - name: a\n    method: FETCH\n    url: http://x/\n"),
    ).toThrow(/unsupported method/);
    expect(() =>
      parseCollection("requests:\n  - name: a\n    url: http://x/\n    expect:\n      status: ok\n"),
    ).toThrow(/expect\.status/);
  });

  it("parses retry with count, delayMs and a block list of statuses", () => {
    const col = parseCollection(
      "requests:\n  - name: flaky\n    url: http://x/flaky\n    retry:\n      count: 2\n      delayMs: 50\n      on:\n        - 500\n        - 502\n",
    );
    expect(col.requests[0].retry).toEqual({ count: 2, delayMs: 50, on: [500, 502] });
  });

  it("defaults retry delayMs to 100 and on to 500/502/503/504", () => {
    const col = parseCollection("requests:\n  - name: flaky\n    url: http://x/flaky\n    retry:\n      count: 1\n");
    expect(col.requests[0].retry).toEqual({ count: 1, delayMs: 100, on: [500, 502, 503, 504] });
  });

  it("rejects a negative retry count and a non-list retry.on", () => {
    expect(() =>
      parseCollection("requests:\n  - name: a\n    url: http://x/\n    retry:\n      count: -1\n"),
    ).toThrow(/retry\.count/);
    expect(() =>
      parseCollection("requests:\n  - name: a\n    url: http://x/\n    retry:\n      count: 1\n      on: 500\n"),
    ).toThrow(/retry\.on/);
  });

  it("parses a mock with status and a mapping body", () => {
    const col = parseCollection(
      "requests:\n  - name: get-user\n    url: http://x/users/1\n    mock:\n      status: 200\n      body:\n        user:\n          id: 1\n",
    );
    expect(col.requests[0].mock?.status).toBe(200);
    expect(col.requests[0].mock?.body).toEqual({ user: { id: 1 } });
  });

  it("rejects an out-of-range mock status", () => {
    expect(() =>
      parseCollection("requests:\n  - name: a\n    url: http://x/\n    mock:\n      status: 99\n"),
    ).toThrow(/mock\.status/);
  });
});
