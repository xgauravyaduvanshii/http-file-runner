# http-file-runner

**Run named HTTP requests from a `requests.yaml` file — with environments, assertions, chaining and CI mode. Zero runtime dependencies, Node 18+.**

```bash
npx http-file-runner run --all
# PASS login — POST http://localhost:3000/login — 200 (12ms)
#   ✓ status: expected 200, got 200
#   ✓ json $.token exists: expected present, got "tok-123"
# PASS get-user — GET http://localhost:3000/users/1 — 200 (4ms)
#   ✓ json $.user.id equals: expected 1, got 1
# 2/2 passed
```

The idea is simple: an API collection that lives in git next to your code, runs with one command, and fails CI when an assertion fails — instead of a request history that only exists in one person's app.

## Why this exists

Checking an API by hand usually means re-typing a request, re-pasting a token, and eyeballing the response. That works once. It stops working when a teammate needs the same request, or when you want the same check to run in CI.

`http-file-runner` is the file-first version of that workflow: requests, environments and assertions are plain text, so they can be reviewed, diffed and versioned like code.

## How it compares

Honest note: this does not replace the tools below — it covers a narrower job, and for some jobs those tools are the better choice.

| Tool | Good at | http-file-runner instead when… |
|---|---|---|
| `curl` | One-off requests, scripting, available everywhere | You want named, reusable requests with assertions and chaining, without writing a shell script per request |
| Postman | Exploring APIs interactively, large teams, cloud sync, mock servers | You want the collection in git as plain text, runnable in CI with no account and no GUI |
| Bruno | File-based collections with a GUI, offline-first | You want a zero-dependency CLI only — no app to install — and a `requests.yaml` you can run with `npm test`-style tooling |

If you already use Postman or Bruno happily, especially for exploratory testing or team workspaces, you probably do not need this too. If your need is "a checked-in smoke test for our API that CI runs", this is the smaller tool for that job.

## Features

- **Named requests in `requests.yaml`** — method, URL, headers, body, all in one file.
- **Environments** — `dev` / `staging` / `prod` (or any name) via `--env`, plus values from a local `.env` file that is never committed.
- **`{{VAR}}` templating** — `{{BASE_URL}}`, `{{TOKEN}}`, with `{{VAR:-default}}` fallbacks. A missing variable fails with its name, not a confusing 404.
- **Assertions** — `expect.status`, `expect.json.path` (+ `equals`), `expect.json.contains`, `expect.contains`, `expect.header`.
- **Chaining** — `capture: { token: "$.token" }` saves a value from one response for the next request.
- **Pretty JSON output** — response bodies are pretty-printed; status and timing are shown per request.
- **`init`** — scaffold a sample collection and `.env.example`.
- **`export`** — print the `curl` equivalent of any request.
- **CI mode** — `--ci` / `--report out.json` (exit `1` on any failed assertion, `2` on usage or collection errors). JSON report included.
- **Zero runtime dependencies** — Node 18+ built-in `fetch` only. The YAML parser is a small built-in subset parser (see Limitations).

## Install

```bash
npm install -g http-file-runner
# or, per project:
npm install --save-dev http-file-runner
```

Requires Node.js 18 or later.

## Quick start

```bash
http-run init
cp .env.example .env   # set BASE_URL to your API
http-run run --all
```

## `requests.yaml` format

```yaml
environments:
  dev:
    BASE_URL: http://localhost:3000
  staging:
    BASE_URL: https://staging.example.com
  prod:
    BASE_URL: https://api.example.com

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
```

### Assertions

| Key | Meaning |
|---|---|
| `expect.status` | Exact HTTP status code, e.g. `200` |
| `expect.contains` | Substring that must appear in the raw response body |
| `expect.json.path` | JSON path that must exist, e.g. `$.user.id` |
| `expect.json.path` + `expect.json.equals` | Value at that path must deep-equal the given value |
| `expect.json.contains` | Substring/value inside the value at `json.path`, or inside the whole JSON body when no path is given |
| `expect.header.<name>` | Substring match on a response header (name case-insensitive) |

JSON paths look like `$.user.id`, `$.items[0].name`, or `$.items.0.name`.

### Chaining

`capture` runs after a request and stores values for later requests in the same run:

```yaml
capture:
  token: "$.token"
  userId: "$.user.id"
```

The next request can then use `{{token}}` and `{{userId}}`. A capture whose path is missing fails the run with the path name — it does not silently store an empty value. Captures happen even if that request's assertions failed, so a token can still be reused for debugging; the run still reports the failed assertion.

## Environments and secrets

Variable resolution order (later wins):

1. `process.env`
2. The named environment from the collection's `environments:` block (`--env dev`)
3. `.env`, then `.env.<env>` in the working directory, if present
4. `--env-file <path>` (repeatable; `.env` or `.yaml` by extension)

Real values belong in a local `.env` file. `.env` is in `.gitignore` — never commit it. Only placeholders go in `.env.example` and `examples/env.*.yaml`. The CLI never prints a variable value in run output or the JSON report; the one exception is `export`, which prints the exact `curl` command you asked for, header values included — do not paste that output into a shared log.

```bash
# dev is the default environment
http-run run --all
http-run run --all --env staging
http-run run get-user --env prod --env-file examples/env.prod.yaml
```

## Usage

```bash
http-run run <name> [--file requests.yaml] [--env dev] [--env-file .env] [--ci] [--report out.json]
http-run run --all [--file requests.yaml] [--env dev] [--ci]
http-run list [--file requests.yaml]
http-run export <name> [--file requests.yaml] [--env dev]
http-run init [dir] [--force]
http-run --help
http-run --version
```

Exit codes: `0` = all requests passed; `1` = an assertion failed or a request errored; `2` = usage or collection error (bad file, unknown request, missing variable).

A failed request does not stop a `--all` run — later requests still execute, so one report shows every failure. A failed *capture* does stop the run, because the next request would be sent with a missing variable.

### CI

```yaml
- run: npm ci
- run: npm test
- run: npx http-run run --all --env staging --ci --report http-report.json
```

See `.github/workflows/ci.yml` for the workflow that runs the test suite on Node 18, 20 and 22.

### Export to curl

```bash
http-run export get-user --env dev
# curl -X GET 'http://localhost:3000/users/1' -H 'Authorization: Bearer tok-123'
```

## Limitations

- **YAML subset.** The built-in parser supports nested maps, sequences, quoted/plain scalars, numbers, booleans, null, and literal block scalars (`|`) for bodies. It does not support anchors, tags, flow collections (`[a, b]`, `{k: v}`), or multi-document files. Files using those fail loudly instead of being mis-parsed.
- **Blank lines in block scalars.** Blank lines inside a `|` body are dropped (JSON bodies are unaffected).
- **No request history, GUI, or cloud sync** — that is the point, but it means exploratory testing is better done in Postman/Bruno and then copied here as a checked-in test.
- **No retries, no parallel runs.** Requests run sequentially, in file order, with a 10s default timeout (`timeoutMs` per request overrides it).
- **Secrets in URLs.** Do not put a token in a URL — it will appear in run output. Put it in a header via `{{TOKEN}}` instead.

## Development

```bash
npm install
npm test
npm run build
node dist/cli.js --help
```

Tests use a local Node HTTP server only — no external network.

## License

MIT — Copyright (c) 2026 Gaurav Kumar Yadav. See [LICENSE](LICENSE).
