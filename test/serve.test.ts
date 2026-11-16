import { describe, expect, it } from "vitest";
import { parseCollection } from "../src/parse.js";
import { startMockServer, stopMockServer } from "../src/serve.js";

const COLLECTION = `
environments:
  dev:
    BASE_URL: http://localhost:3000
requests:
  - name: get-user
    method: GET
    url: "{{BASE_URL}}/users/1"
    mock:
      status: 200
      body:
        user:
          id: 1
          name: Ada Lovelace
  - name: login
    method: POST
    url: "{{BASE_URL}}/login"
    mock:
      status: 200
      body: |
        {"token": "mock-token"}
  - name: plain
    method: GET
    url: "{{BASE_URL}}/hello"
    mock:
      status: 200
      body: "hello world"
  - name: no-mock
    method: GET
    url: "{{BASE_URL}}/real"
`;

describe("mock server (serve)", () => {
  it("serves mock JSON bodies by method + path, with templated URLs", async () => {
    const col = parseCollection(COLLECTION);
    const mock = await startMockServer(col, { BASE_URL: "http://localhost:3000" }, { port: 0 });
    try {
      expect(mock.routes).toHaveLength(3);
      const user = await fetch(`${mock.url}/users/1`);
      expect(user.status).toBe(200);
      expect(user.headers.get("content-type")).toContain("application/json");
      expect(await user.json()).toEqual({ user: { id: 1, name: "Ada Lovelace" } });

      const login = await fetch(`${mock.url}/login`, { method: "POST", body: "{}" });
      expect(login.status).toBe(200);
      expect(await login.json()).toEqual({ token: "mock-token" });

      const hello = await fetch(`${mock.url}/hello`);
      expect(hello.status).toBe(200);
      expect(await hello.text()).toBe("hello world");
    } finally {
      await stopMockServer(mock);
    }
  });

  it("returns 404 JSON for paths with no mock, including requests without one", async () => {
    const col = parseCollection(COLLECTION);
    const mock = await startMockServer(col, { BASE_URL: "http://localhost:3000" }, { port: 0 });
    try {
      const res = await fetch(`${mock.url}/real`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "no mock defined for GET /real" });
      const unknown = await fetch(`${mock.url}/nope`);
      expect(unknown.status).toBe(404);
    } finally {
      await stopMockServer(mock);
    }
  });

  it("respects a mock status and custom headers", async () => {
    const col = parseCollection(`
requests:
  - name: created
    method: POST
    url: "{{BASE_URL}}/items"
    mock:
      status: 201
      headers:
        X-Mock: "yes"
      body:
        id: 7
`);
    const mock = await startMockServer(col, { BASE_URL: "http://localhost:3000" }, { port: 0 });
    try {
      const res = await fetch(`${mock.url}/items`, { method: "POST", body: "{}" });
      expect(res.status).toBe(201);
      expect(res.headers.get("x-mock")).toBe("yes");
      expect(await res.json()).toEqual({ id: 7 });
    } finally {
      await stopMockServer(mock);
    }
  });
});
