/**
 * Self-contained HTML report for a run (v0.2.0).
 *
 * Deliberately omits response bodies and assertion `actual` values:
 * a body can contain a token or other secret, and a shareable HTML
 * file must never be the place one leaks. The report shows names,
 * methods, URLs, statuses, timings, attempt counts and whether each
 * assertion passed — everything needed to triage, nothing secret.
 */
import type { RunResult } from "./run.js";

export interface HtmlReportInput {
  passed: boolean;
  results: RunResult[];
  generatedAt?: Date;
  version?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function generateHtmlReport(input: HtmlReportInput): string {
  const { passed, results } = input;
  const generatedAt = input.generatedAt ?? new Date();
  const version = input.version ?? "0.2.0";
  const total = results.length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  const rows = results
    .map((r) => {
      const status = r.status === null ? "ERROR" : String(r.status);
      const verdict = r.passed ? "PASS" : "FAIL";
      const attempts = r.attempts > 1
        ? `${r.attempts} attempts (${r.attemptStatuses.join(" → ")})`
        : "1 attempt";
      const assertions = r.assertions.length === 0
        ? `<li class="muted">no assertions</li>`
        : r.assertions
            .map(
              (a) =>
                `<li class="${a.passed ? "pass" : "fail"}">${a.passed ? "✓" : "✗"} ${escapeHtml(a.name)} — expected ${escapeHtml(a.expected)}</li>`,
            )
            .join("\n");
      const error = r.error ? `<p class="error">error: ${escapeHtml(r.error)}</p>` : "";
      return `<section class="request ${r.passed ? "pass" : "fail"}">
  <h2><span class="verdict">${verdict}</span> ${escapeHtml(r.name)} <span class="muted">${escapeHtml(r.method)} ${escapeHtml(r.url)}</span></h2>
  <p>Status <strong>${escapeHtml(status)}</strong> · ${r.durationMs}ms · ${escapeHtml(attempts)}</p>
  ${error}
  <ul>${assertions}</ul>
</section>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>http-file-runner report — ${passed ? "PASS" : "FAIL"}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#111}
.muted{color:#666;font-weight:normal}
.pass{color:#0a7a2f}.fail{color:#b00020}
section.request{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}
section.request.fail{border-color:#b00020}
h1{font-size:1.4rem}h2{font-size:1.1rem}
.error{color:#b00020}
ul{margin:.5rem 0}
</style>
</head>
<body>
<h1>http-file-runner report — ${passed ? "PASS" : "FAIL"}</h1>
<p>${total - failed}/${total} passed · ${totalMs}ms total · generated ${escapeHtml(generatedAt.toISOString())} · http-file-runner ${escapeHtml(version)}</p>
<p class="muted">Response bodies and assertion values are intentionally omitted from this report so secrets never land in a shareable file.</p>
${rows}
</body>
</html>
`;
}
