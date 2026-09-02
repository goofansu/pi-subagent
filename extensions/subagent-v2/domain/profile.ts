/**
 * v2 Profile parsing: pure, deterministic, and total.
 *
 * A Profile is a Markdown file whose frontmatter names the specialist and
 * whose body is its system prompt. The parser understands exactly three
 * things — `description`, `backend`, and the body — and collects every other
 * frontmatter field unchanged for the named backend to validate. That split is
 * what keeps backend vocabulary out of the core: a field the core has never
 * heard of is not an error here, it is the backend's business, and a field the
 * *backend* has never heard of becomes a diagnostic rather than a silent
 * pass-through.
 *
 * The frontmatter reader is a documented YAML subset rather than a YAML
 * library, because the domain module imports nothing. The subset covers what
 * Profiles are: scalars, inline lists, and block lists. Anything outside it —
 * a nested map, a block scalar — is reported as an unsupported field rather
 * than misread, so a Profile author is told what happened instead of getting
 * surprising behaviour. v1 accepted arbitrary YAML through the host's parser;
 * this is the one deliberate narrowing, and it is visible to whoever writes an
 * unsupported Profile.
 *
 * Discovery — finding Profile files on disk — is a separate module, because
 * reading a directory is not a pure function.
 */

import { type BackendId, backendId, DEFAULT_BACKEND_ID } from "./ids.ts";

/** A resolved Profile. Every reader treats it as immutable. */
export interface Profile {
  /** The file's base name, which is what a caller names in `agent_start`. */
  readonly name: string;
  readonly description: string;
  readonly backend: BackendId;
  /** Every frontmatter field other than `description` and `backend`. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly systemPrompt: string;
}

export interface ProfileDiagnostic {
  readonly filePath: string;
  readonly reason: string;
}

export type ProfileParse =
  | { readonly outcome: "profile"; readonly profile: Profile }
  | {
      readonly outcome: "diagnostics";
      readonly diagnostics: readonly ProfileDiagnostic[];
    };

/** The extension a Profile file has. */
export const PROFILE_FILE_EXTENSION = ".md";

/**
 * The Profile's name: the file's base name without its extension.
 *
 * Both separators are handled because a path is a string here, not a
 * platform-resolved object, and the domain module cannot ask a `node:path`
 * which separator this machine uses.
 */
export function profileNameFromPath(filePath: string): string {
  const lastSlash = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  const base = filePath.slice(lastSlash + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

/** How a diagnostic names the type of a value the parser rejected. */
function describeType(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (value === null) return "empty";
  if (typeof value === "object") return "a map";
  return `a ${typeof value}`;
}

interface Frontmatter {
  readonly fields: Record<string, unknown>;
  readonly body: string;
  readonly problems: readonly string[];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** A plain scalar: quoted string, boolean, null, number, or bare text. */
function readScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.length === 0) return null;
  const quote = value[0];
  if (
    (quote === '"' || quote === "'") &&
    value.endsWith(quote) &&
    value.length > 1
  ) {
    const inner = value.slice(1, -1);
    return quote === '"'
      ? inner.replace(/\\"/g, '"')
      : inner.replace(/''/g, "'");
  }
  // A plain scalar ends at an unquoted comment, exactly as YAML says.
  const commented = value.replace(/\s+#.*$/, "").trim();
  if (commented === "true") return true;
  if (commented === "false") return false;
  if (commented === "null" || commented === "~") return null;
  if (commented !== "" && Number.isFinite(Number(commented))) {
    return Number(commented);
  }
  return commented;
}

function readInlineList(raw: string): unknown[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(",").map((item) => readScalar(item));
}

const KEY_LINE = /^([A-Za-z0-9_.$-]+):(.*)$/;

/**
 * Split a Profile file into frontmatter fields, a body, and the problems the
 * reader found. The reader never throws: a malformed line becomes a problem
 * the caller reports as a diagnostic.
 */
function readFrontmatter(text: string): Frontmatter {
  const normalized = stripBom(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return { fields: {}, body: normalized, problems: [] };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) {
    return {
      fields: {},
      body: normalized,
      problems: ["frontmatter is opened with '---' but never closed"],
    };
  }
  const block = normalized.slice(4, end);
  const body = normalized.slice(end + 4).trim();

  const fields: Record<string, unknown> = {};
  const problems: string[] = [];
  const lines = block.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      problems.push(`indented frontmatter is not supported: '${line.trim()}'`);
      continue;
    }
    const match = KEY_LINE.exec(line);
    if (!match) {
      problems.push(`frontmatter line is not 'key: value': '${line.trim()}'`);
      continue;
    }
    const [, key, rest] = match;
    if (Object.hasOwn(fields, key)) {
      problems.push(`frontmatter field '${key}' appears more than once`);
      continue;
    }
    const value = rest.trim();
    if (
      value === "|" ||
      value === ">" ||
      value.startsWith("|") ||
      value.startsWith(">")
    ) {
      problems.push(
        `frontmatter field '${key}' uses an unsupported block scalar`,
      );
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      fields[key] = readInlineList(value);
      continue;
    }
    if (value !== "") {
      fields[key] = readScalar(value);
      continue;
    }
    // An empty value is either a block list or nothing at all.
    const items: unknown[] = [];
    while (index < lines.length && /^\s*-\s+/.test(lines[index])) {
      items.push(readScalar(lines[index].replace(/^\s*-\s+/, "")));
      index += 1;
    }
    if (items.length > 0) {
      fields[key] = items;
      continue;
    }
    if (index < lines.length && /^\s+\S/.test(lines[index])) {
      problems.push(
        `frontmatter field '${key}' uses an unsupported nested map`,
      );
      while (index < lines.length && /^\s+\S/.test(lines[index])) index += 1;
      continue;
    }
    fields[key] = null;
  }
  return { fields, body, problems };
}

/**
 * Parse one Profile file.
 *
 * Every problem is collected rather than the first one thrown, so a Profile
 * with two mistakes reports both and its author fixes them in one pass.
 */
export function parseProfile(text: string, filePath: string): ProfileParse {
  const { fields, body, problems } = readFrontmatter(text);
  const diagnostics: ProfileDiagnostic[] = problems.map((reason) => ({
    filePath,
    reason,
  }));
  const reject = (reason: string): void => {
    diagnostics.push({ filePath, reason });
  };

  const rawDescription = fields.description;
  let description = "";
  if (
    rawDescription === undefined ||
    rawDescription === null ||
    rawDescription === ""
  ) {
    reject("missing required description frontmatter");
  } else if (typeof rawDescription !== "string") {
    reject(`description must be a string, not ${describeType(rawDescription)}`);
  } else if (rawDescription.trim() === "") {
    reject("missing required description frontmatter");
  } else {
    description = rawDescription.trim();
  }

  const rawBackend = fields.backend;
  let backend: BackendId = DEFAULT_BACKEND_ID;
  if (rawBackend !== undefined && rawBackend !== null) {
    if (typeof rawBackend !== "string" || rawBackend.trim() === "") {
      reject("backend must be a non-empty string");
    } else {
      try {
        backend = backendId(rawBackend.trim());
      } catch {
        reject(`backend '${rawBackend.trim()}' is not a usable backend name`);
      }
    }
  }

  const systemPrompt = body.trim();
  if (systemPrompt === "") reject("missing required prompt body");

  if (diagnostics.length > 0) return { outcome: "diagnostics", diagnostics };

  const backendFields: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (field === "description" || field === "backend") continue;
    backendFields[field] = value;
  }

  return {
    outcome: "profile",
    profile: {
      name: profileNameFromPath(filePath),
      description,
      backend,
      fields: backendFields,
      systemPrompt,
    },
  };
}
