/**
 * Mock server for frontend development (v0.2.0): `http-run serve`.
 *
 * Serves the `mock:` example response of each request in the
 * collection, matched by method + path. The path comes from the
 * request URL after `{{VAR}}` substitution (so `{{BASE_URL}}/users/1`
 * serves `/users/1`). Requests without a `mock:` return 404 with a
 * JSON error naming the available mock routes.
 *
 * Mock bodies are templated with the same `{{VAR}}` vars as `run`,
 * so a mock can echo a captured-looking token placeholder without
 * ever containing a real secret.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { substitute, type Vars } from "./env.js";
import type { Collection, RequestSpec } from "./parse.js";

export interface MockRoute {
  name: string;
  method: string;
  path: string;
}

export interface MockServer {
  server: Server;
  port: number;
  url: string;
  routes: MockRoute[];
}

function requestPath(spec: RequestSpec, vars: Vars): string {
  const substituted = substitute(spec.url, vars);
  try {
    return new URL(substituted, "http://localhost").pathname;
  } catch {
    return substituted;
  }
}

function mockBodyText(spec: RequestSpec, vars: Vars): { text: string; contentType: string } {
  const body = spec.mock?.body;
  if (body === undefined || body === null) return { text: "", contentType: "application/json" };
  if (typeof body === "string") {
    const text = substitute(body, vars);
    const trimmed = text.trim();
    const contentType = trimmed.startsWith("{") || trimmed.startsWith("[")
      ? "application/json"
      : "text/plain";
    return { text, contentType };
  }
  return { text: JSON.stringify(body), contentType: "application/json" };
}

export function buildMockRoutes(collection: Collection, vars: Vars): MockRoute[] {
  return collection.requests
    .filter((r) => r.mock !== undefined)
    .map((r) => ({ name: r.name, method: r.method.toUpperCase(), path: requestPath(r, vars) }));
}

/** Start the mock server on an ephemeral port when `port` is 0. */
export async function startMockServer(
  collection: Collection,
  vars: Vars,
  options: { port?: number; host?: string } = {},
): Promise<MockServer> {
  const host = options.host ?? "127.0.0.1";
  const routes = buildMockRoutes(collection, vars);
  const byKey = new Map<string, RequestSpec>();
  for (const spec of collection.requests) {
    if (spec.mock === undefined) continue;
    byKey.set(`${spec.method.toUpperCase()} ${requestPath(spec, vars)}`, spec);
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Drain the request body (a mock does not need it) so the client
    // does not hang on a POST with a body.
    req.resume();
    const path = (req.url ?? "/").split("?")[0];
    const spec = byKey.get(`${(req.method ?? "GET").toUpperCase()} ${path}`);
    if (!spec) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no mock defined for ${req.method} ${path}` }));
      return;
    }
    const { text, contentType } = mockBodyText(spec, vars);
    const headers: Record<string, string> = { "content-type": contentType };
    for (const [name, raw] of Object.entries(spec.mock?.headers ?? {})) {
      headers[name.toLowerCase()] = substitute(raw, vars);
    }
    res.writeHead(spec.mock?.status ?? 200, headers);
    res.end(text);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3000, host, () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("Mock server did not start");
  return { server, port: address.port, url: `http://${host}:${address.port}`, routes };
}

export async function stopMockServer(mock: MockServer): Promise<void> {
  await new Promise<void>((resolve) => mock.server.close(() => resolve()));
}
