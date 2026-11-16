import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCollection } from "../src/parse.js";
import { runCollection, runOne } from "../src/run.js";

/** Local server only — no external network. /flaky fails twice, then recovers. */
let server: Server;
let baseUrl: string;
let flakyHits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/flaky") {
      flakyHits++;
      if (flakyHits <= 2) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/always500") {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "boom" }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("Test server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("retries", () => {
  it("retries a 500 twice with backoff and passes on the third attempt", async () => {
    flakyHits = 0;
    const col = parseCollection(`
requests:
  - name: flaky
    url: "{{BASE_URL}}/flaky"
    retry:
      count: 3
      delayMs: 10
      on:
        - 500
    expect:
      status: 200
`);
    const { result } = await runOne(col.requests[0], { BASE_URL: baseUrl });
    expect(result.passed).toBe(true);
    expect(result.status).toBe(200);
    expect(result.attempts).toBe(3);
    expect(result.attemptStatuses).toEqual([500, 500, 200]);
    expect(flakyHits).toBe(3);
  });

  it("gives up after the retry count and reports every attempt", async () => {
    const col = parseCollection(`
requests:
  - name: always500
    url: "{{BASE_URL}}/always500"
    retry:
      count: 2
      delayMs: 10
      on:
        - 500
    expect:
      status: 200
`);
    const { result } = await runOne(col.requests[0], { BASE_URL: baseUrl });
    expect(result.passed).toBe(false);
    expect(result.status).toBe(500);
    expect(result.attempts).toBe(3);
    expect(result.attemptStatuses).toEqual([500, 500, 500]);
  });

  it("does not retry a status that is not in retry.on", async () => {
    const col = parseCollection(`
requests:
  - name: missing
    url: "{{BASE_URL}}/nope"
    retry:
      count: 3
      delayMs: 10
      on:
        - 500
    expect:
      status: 200
`);
    const { result } = await runOne(col.requests[0], { BASE_URL: baseUrl });
    expect(result.status).toBe(404);
    expect(result.attempts).toBe(1);
    expect(result.attemptStatuses).toEqual([404]);
  });

  it("does not retry a missing-variable error", async () => {
    const col = parseCollection(`
requests:
  - name: bad
    url: "{{MISSING}}/x"
    retry:
      count: 3
      delayMs: 10
`);
    const { result } = await runOne(col.requests[0], {});
    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error).toMatch(/Missing environment variable: MISSING/);
  });

  it("runs a retried request inside a collection and keeps chaining working", async () => {
    flakyHits = 0;
    const col = parseCollection(`
requests:
  - name: flaky
    url: "{{BASE_URL}}/flaky"
    retry:
      count: 3
      delayMs: 10
      on:
        - 500
    expect:
      status: 200
`);
    const { results, passed } = await runCollection(col.requests, { BASE_URL: baseUrl });
    expect(passed).toBe(true);
    expect(results[0].attempts).toBe(3);
  });
});
