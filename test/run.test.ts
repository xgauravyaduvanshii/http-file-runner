import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCollection } from "../src/parse.js";
import { buildCurl, runCollection } from "../src/run.js";

/**
 * Local test server only — no external network. It mimics a tiny API:
 * POST /login -> { token }, GET /users/1 -> { user }, GET /users -> list.
 */
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/login") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        if (parsed.username === "demo") {
          res.writeHead(200);
          res.end(JSON.stringify({ token: "tok-123" }));
        } else {
          res.writeHead(401);
          res.end(JSON.stringify({ error: "unauthorised" }));
        }
      });
      return;
    }
    if (req.method === "GET" && req.url === "/users/1") {
      if (req.headers.authorization !== "Bearer tok-123") {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorised" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ user: { id: 1, name: "Ada Lovelace" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/users") {
      res.writeHead(200);
      res.end(JSON.stringify({ users: [{ id: 1, name: "Ada Lovelace" }] }));
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

const COLLECTION = `
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
  - name: list-users
    method: GET
    url: "{{BASE_URL}}/users"
    expect:
      status: 200
      json:
        contains: "Ada Lovelace"
`;

describe("run against a local server", () => {
  it("runs login -> get-user with chaining: the captured token authorises the next request", async () => {
    const col = parseCollection(COLLECTION);
    const { results, passed, vars } = await runCollection(col.requests, { BASE_URL: baseUrl });
    expect(passed).toBe(true);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.name)).toEqual(["login", "get-user", "list-users"]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.durationMs >= 0)).toBe(true);
    expect(vars.token).toBe("tok-123");
    expect(results[1].body).toContain("Ada Lovelace");
  });

  it("reports a failed assertion without stopping the whole run", async () => {
    const col = parseCollection(`
requests:
  - name: wrong-status
    method: GET
    url: "{{BASE_URL}}/users/1"
    expect:
      status: 404
  - name: list-users
    method: GET
    url: "{{BASE_URL}}/users"
    expect:
      status: 200
`);
    const { results, passed } = await runCollection(col.requests, { BASE_URL: baseUrl });
    expect(passed).toBe(false);
    expect(results[0].passed).toBe(false);
    expect(results[0].assertions[0].actual).toBe("401");
    expect(results[1].passed).toBe(true);
  });

  it("returns an error result (not a throw) for a missing variable or unreachable host", async () => {
    const col = parseCollection("requests:\n  - name: bad\n    url: \"{{MISSING}}/x\"\n");
    const { results, passed } = await runCollection(col.requests, {});
    expect(passed).toBe(false);
    expect(results[0].status).toBeNull();
    expect(results[0].error).toMatch(/Missing environment variable: MISSING/);
  });

  it("builds a curl equivalent with substituted vars and quoted args", () => {
    const col = parseCollection(COLLECTION);
    const curl = buildCurl(col.requests[0], { BASE_URL: baseUrl });
    expect(curl).toContain(`curl -X POST '${baseUrl}/login'`);
    expect(curl).toContain("-H 'Content-Type: application/json'");
    expect(curl).toContain("--data");
  });
});
