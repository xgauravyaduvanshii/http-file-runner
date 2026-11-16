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
});
