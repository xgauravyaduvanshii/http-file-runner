/**
 * JSON-path lookup and capture extraction for request chaining.
 *
 * Paths look like `$.user.id`, `$.items[0].name`, or `$.items.0.name`.
 * A path that points at an object/array captures its JSON string, so the
 * next request can send it as a `{{VAR}}` value.
 */

export function getJsonPath(
  value: unknown,
  path: string,
): { found: boolean; value?: unknown } {
  if (path === "$") return { found: true, value };
  if (!path.startsWith("$")) return { found: false };
  const rest = path.slice(1);
  // Split on `.` and `[n]`, ignoring empty segments from a leading `.`.
  const segments: string[] = [];
  const re = /(?:\.([A-Za-z0-9_-]+))|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(rest)) !== null) {
    if (m.index !== consumed) return { found: false };
    segments.push(m[1] ?? m[2]);
    consumed = m.index + m[0].length;
  }
  if (consumed !== rest.length) return { found: false };

  let current: unknown = value;
  for (const seg of segments) {
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return { found: false };
      current = current[idx];
    } else if (typeof current === "object" && current !== null) {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, seg)) return { found: false };
      current = record[seg];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

/** Stringify a captured value so it can be used as a `{{VAR}}`. */
export function stringifyCaptured(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Extract captures from a response body. `body` is the parsed JSON when
 * available, otherwise the raw text. Missing paths are reported as an
 * error — a silent empty capture would make the next request fail in a
 * confusing way further down the chain.
 */
export function extractCaptures(
  body: unknown,
  capture: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, path] of Object.entries(capture)) {
    const { found, value } = getJsonPath(body, path);
    if (!found) throw new Error(`Capture failed: path "${path}" not found for variable "${name}"`);
    out[name] = stringifyCaptured(value);
  }
  return out;
}
