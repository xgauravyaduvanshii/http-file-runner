import { describe, expect, it } from "vitest";
import { generateHtmlReport } from "../src/report.js";
import type { RunResult } from "../src/run.js";

const RESULTS: RunResult[] = [
  {
    name: "login",
    method: "POST",
    url: "http://localhost:3000/login",
    status: 200,
    durationMs: 12,
    passed: true,
    assertions: [{ name: "status", passed: true, expected: "200", actual: "200" }],
    body: JSON.stringify({ token: "tok-123" }),
    attempts: 1,
    attemptStatuses: [200],
  },
  {
    name: "flaky",
    method: "GET",
    url: "http://localhost:3000/flaky",
    status: 500,
    durationMs: 230,
    passed: false,
    assertions: [{ name: "status", passed: false, expected: "200", actual: "500" }],
    body: JSON.stringify({ error: "boom", token: "tok-123" }),
    attempts: 3,
    attemptStatuses: [500, 500, 500],
    error: "boom",
  },
];

describe("generateHtmlReport", () => {
  it("is a self-contained HTML document with a summary and per-request sections", () => {
    const html = generateHtmlReport({ passed: false, results: RESULTS, version: "0.2.0" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("1/2 passed");
    expect(html).toContain("login");
    expect(html).toContain("flaky");
    expect(html).toContain("3 attempts (500 → 500 → 500)");
    expect(html).toContain("http-file-runner 0.2.0");
  });

  it("never includes response bodies or secret values", () => {
    const html = generateHtmlReport({ passed: false, results: RESULTS });
    expect(html).not.toContain("tok-123");
    expect(html).not.toContain('"token"');
    // The error line ("boom") is shown — it is a server error message,
    // not a response body — but the body that carried it is not.
    expect(html).not.toContain('{"error": "boom"');
  });

  it("escapes HTML in request names and URLs", () => {
    const html = generateHtmlReport({
      passed: true,
      results: [
        {
          name: "<script>alert(1)</script>",
          method: "GET",
          url: "http://x/?a=<b>",
          status: 200,
          durationMs: 1,
          passed: true,
          assertions: [],
          body: "",
          attempts: 1,
          attemptStatuses: [200],
        },
      ],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("http://x/?a=&lt;b&gt;");
  });
});
