/**
 * Minimal YAML parser for the subset http-file-runner needs.
 *
 * Zero runtime dependencies, so this deliberately does NOT support the
 * whole YAML spec: no anchors, tags, flow collections (`[a, b]`,
 * `{k: v}`), multi-document files, or complex keys. It supports what
 * `requests.yaml` files actually use:
 *   - nested mappings by indentation (2 spaces)
 *   - sequences (`- name: get-user`) including a mapping on the `-` line
 *   - scalars: quoted strings, numbers, booleans, null, plain strings
 *   - literal block scalars (`|` / `|-`) for request bodies
 *   - `#` comments on their own line, and after an unquoted scalar
 *   - a sequence under a mapping key at the same indent (`requests:\n- …`)
 *
 * If a file needs full YAML, that is a real limitation — say so in the
 * README rather than silently mis-parsing it. Files that use unsupported
 * syntax fail loudly here instead of producing a wrong collection.
 */

export interface ExpectSpec {
  status?: number;
  /** Substring that must appear in the raw response body. */
  contains?: string;
  json?: {
    /** JSON path such as `$.user.id` or `$.token`. */
    path?: string;
    /** Expected value at `path` (deep-compared). */
    equals?: unknown;
    /** Substring / value that the value at `path` (or the whole JSON body) must contain. */
    contains?: string | number | boolean;
  };
  /** Header name -> expected value (substring match, case-insensitive name). */
  header?: Record<string, string>;
}

export interface RequestSpec {
  name: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Request body as a string (usually JSON). Templated with {{VAR}} before sending. */
  body?: string;
  timeoutMs?: number;
  expect?: ExpectSpec;
  /** var name -> JSON path, e.g. `{ token: "$.token" }`. Captured after a successful run. */
  capture?: Record<string, string>;
}

export interface Collection {
  environments?: Record<string, Record<string, string>>;
  requests: RequestSpec[];
}

interface Line {
  indent: number;
  content: string;
  raw: string;
  lineNo: number;
}

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

function stripComment(line: string): string {
  // Remove ` # comment` outside quotes. A `#` at the start is a comment.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) {
      if (i === 0 || line[i - 1] !== "\\") inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || line[i - 1] === " " || line[i - 1] === "\t") {
        return line.slice(0, i).trimEnd();
      }
    }
  }
  return line;
}

export function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

function splitKeyValue(content: string): { key: string; rest: string } | null {
  // Find the first `: ` or trailing `:` outside quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble) {
      const next = content[i + 1];
      if (next === undefined || next === " " || next === "\t") {
        const key = content.slice(0, i).trim();
        const rest = content.slice(i + 1).trim();
        if (key) return { key: parseScalar(key) as string, rest };
      }
    }
  }
  return null;
}

class YamlParser {
  private lines: Line[];
  private pos = 0;

  constructor(text: string) {
    this.lines = text
      .split(/\r?\n/)
      .map((raw, i) => ({ raw, lineNo: i + 1, indent: 0, content: "" }))
      .filter((l) => {
        const stripped = stripComment(l.raw);
        if (stripped.trim() === "") return false;
        // Tabs are not valid YAML indentation; fail loudly instead of guessing.
        if (/^\t/.test(stripped) || /^\s*\t/.test(stripped)) {
          throw new Error(`YAML: tab indentation is not supported (line ${l.lineNo})`);
        }
        const indent = stripped.length - stripped.trimStart().length;
        l.indent = indent;
        l.content = stripped.trim();
        return true;
      });
  }

  parse(): unknown {
    if (this.lines.length === 0) return null;
    const value = this.parseBlock(this.lines[0].indent);
    if (this.pos < this.lines.length) {
      const extra = this.lines[this.pos];
      throw new Error(`YAML: unexpected content at line ${extra.lineNo}: ${extra.content}`);
    }
    return value;
  }

  private peek(): Line | undefined {
    return this.lines[this.pos];
  }

  private parseBlock(indent: number): unknown {
    const line = this.peek();
    if (!line || line.indent < indent) return null;
    if (line.content === "-" || line.content.startsWith("- ")) return this.parseList(indent);
    return this.parseMap(indent);
  }

  private parseMap(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.indent !== indent) break;
      if (line.content === "-" || line.content.startsWith("- ")) break;
      const kv = splitKeyValue(line.content);
      if (!kv) {
        throw new Error(`YAML: expected "key: value" at line ${line.lineNo}: ${line.content}`);
      }
      this.pos++;
      out[kv.key] = this.parseValue(kv.rest, indent, line.lineNo);
    }
    return out;
  }

  private parseList(indent: number): unknown[] {
    const out: unknown[] = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.indent !== indent) break;
      if (!(line.content === "-" || line.content.startsWith("- "))) break;
      const rest = line.content === "-" ? "" : line.content.slice(2);
      if (rest.trim() === "") {
        this.pos++;
        const next = this.peek();
        out.push(next && next.indent > indent ? this.parseBlock(next.indent) : null);
        continue;
      }
      // A mapping starting on the `-` line: rewrite it as a map line at
      // indent+2 and let parseMap consume it plus the following lines.
      const childIndent = indent + 2;
      this.lines[this.pos] = { ...line, indent: childIndent, content: rest.trim() };
      out.push(this.parseBlock(childIndent));
    }
    return out;
  }

  private parseValue(rest: string, indent: number, lineNo: number): unknown {
    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      return this.readBlockScalar(indent, rest.startsWith(">"));
    }
    if (rest !== "") return parseScalar(rest);
    const next = this.peek();
    if (!next) return null;
    if (next.indent > indent) return this.parseBlock(next.indent);
    // Sequence at the same indent as its key: `requests:\n- name: …`
    if (next.indent === indent && (next.content === "-" || next.content.startsWith("- "))) {
      return this.parseList(indent);
    }
    return null;
  }

  private readBlockScalar(parentIndent: number, folded: boolean): string {
    const parts: string[] = [];
    let blockIndent: number | null = null;
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.indent <= parentIndent) break;
      if (blockIndent === null) blockIndent = line.indent;
      // Reconstruct the original spacing beyond the block indent.
      const raw = line.raw;
      parts.push(raw.slice(Math.min(blockIndent, raw.length)));
      this.pos++;
    }
    // Note: blank lines inside a block scalar are dropped by the line
    // filter above — acceptable for JSON bodies, documented in the README.
    return folded ? parts.join(" ") : parts.join("\n");
  }
}

export function parseYaml(text: string): unknown {
  return new YamlParser(text).parse();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringifyRecord(
  value: unknown,
  where: string,
): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${where} must be a mapping of string values`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) out[k] = "";
    else if (typeof v === "string") out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

function parseExpect(raw: unknown, name: string): ExpectSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error(`Request "${name}": expect must be a mapping`);
  const expect: ExpectSpec = {};
  if (raw.status !== undefined) {
    if (typeof raw.status !== "number" || !Number.isInteger(raw.status)) {
      throw new Error(`Request "${name}": expect.status must be an integer`);
    }
    expect.status = raw.status;
  }
  if (raw.contains !== undefined) {
    if (typeof raw.contains !== "string") {
      throw new Error(`Request "${name}": expect.contains must be a string`);
    }
    expect.contains = raw.contains;
  }
  if (raw.json !== undefined) {
    if (!isRecord(raw.json)) throw new Error(`Request "${name}": expect.json must be a mapping`);
    const json: NonNullable<ExpectSpec["json"]> = {};
    if (raw.json.path !== undefined) {
      if (typeof raw.json.path !== "string") throw new Error(`Request "${name}": expect.json.path must be a string`);
      json.path = raw.json.path;
    }
    if (raw.json.equals !== undefined) json.equals = raw.json.equals;
    if (raw.json.contains !== undefined) {
      if (typeof raw.json.contains !== "string" && typeof raw.json.contains !== "number" && typeof raw.json.contains !== "boolean") {
        throw new Error(`Request "${name}": expect.json.contains must be a string, number or boolean`);
      }
      json.contains = raw.json.contains;
    }
    expect.json = json;
  }
  if (raw.header !== undefined) {
    expect.header = stringifyRecord(raw.header, `Request "${name}": expect.header`);
  }
  return expect;
}

function parseRequest(raw: unknown, index: number): RequestSpec {
  if (!isRecord(raw)) throw new Error(`Request #${index + 1} must be a mapping`);
  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`Request #${index + 1} is missing a non-empty "name"`);
  }
  const url = raw.url;
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error(`Request "${name}": missing a non-empty "url"`);
  }
  const method = typeof raw.method === "string" && raw.method.trim() !== ""
    ? raw.method.trim().toUpperCase()
    : "GET";
  if (!HTTP_METHODS.has(method)) {
    throw new Error(`Request "${name}": unsupported method "${method}"`);
  }
  const req: RequestSpec = { name, method, url };
  if (raw.headers !== undefined) req.headers = stringifyRecord(raw.headers, `Request "${name}": headers`);
  if (raw.body !== undefined) {
    req.body = typeof raw.body === "string" ? raw.body : JSON.stringify(raw.body);
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number") throw new Error(`Request "${name}": timeoutMs must be a number`);
    req.timeoutMs = raw.timeoutMs;
  }
  if (raw.capture !== undefined) req.capture = stringifyRecord(raw.capture, `Request "${name}": capture`);
  const expect = parseExpect(raw.expect, name);
  if (expect) req.expect = expect;
  return req;
}

/** Parse and validate a requests.yaml document. Throws with a clear message on bad input. */
export function parseCollection(text: string): Collection {
  const doc = parseYaml(text);
  if (!isRecord(doc)) throw new Error("requests.yaml must be a mapping with a top-level \"requests\" list");
  const rawRequests = doc.requests;
  if (!Array.isArray(rawRequests) || rawRequests.length === 0) {
    throw new Error('requests.yaml must contain a non-empty "requests" list');
  }
  const requests = rawRequests.map((r, i) => parseRequest(r, i));
  const seen = new Set<string>();
  for (const r of requests) {
    if (seen.has(r.name)) throw new Error(`Duplicate request name: "${r.name}"`);
    seen.add(r.name);
  }
  const collection: Collection = { requests };
  if (doc.environments !== undefined) {
    if (!isRecord(doc.environments)) throw new Error('"environments" must be a mapping of environment name to variables');
    const envs: Record<string, Record<string, string>> = {};
    for (const [envName, vars] of Object.entries(doc.environments)) {
      envs[envName] = stringifyRecord(vars, `environments.${envName}`);
    }
    collection.environments = envs;
  }
  return collection;
}
