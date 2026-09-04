/**
 * The soak tally, computed from Pi's session logs rather than remembered.
 *
 * Two soak windows closed with an empty log, and the reason was not
 * forgetfulness: the tally was a hand-kept record of things the maintainer had
 * already done, reconstructed after the fact, and nothing made writing it
 * cheaper than not writing it. Pi already writes one JSONL file per Session
 * carrying every tool call with its arguments and its timestamp, which is all
 * three of the things a tally row needs — operation, backend, day. So the
 * tally is read out of that, and what stays manual is only what the logs
 * cannot know: the probe readings at each shutdown, and anything that went
 * wrong. See [the 2.0 close](../docs/v2/release-close.md) item E1 and
 * [the soak record](../docs/v2/soak.md).
 *
 * **Attribution.** An `agent_start` names a Profile and a Profile's
 * frontmatter names its backend, so a start attributes itself. Nothing else
 * does: `agent_resume` names a Subagent id, and `agent_steer` and
 * `agent_cancel` name Run ids, all of which are minted by the Session that
 * issued them and carry a per-Session nonce. So resolution is per Session and
 * runs forward through the tool *results*, which are where the ids appear. An
 * id that no start or resume in the same Session produced is listed as
 * unattributed rather than guessed at or dropped — a tally that read fuller
 * than the usage was would be worse than no tally.
 *
 * **Failing loudly.** Pi's on-disk format is Pi's to change. When it changes,
 * this script throws on the field it cannot find, naming the file and the
 * line, rather than printing a smaller number: a quiet undercount would be
 * indistinguishable from a quiet week, and the whole point of the tally is
 * that a soak day counts whether or not anyone wrote it down.
 *
 * This is tooling for a process, not product. It has no dependencies, it is
 * not in `check` or `release:check`, and it is not an operator command.
 *
 * Usage: `node scripts/soak-tally.mjs <since-date> [--sessions <dir>] [--profiles <dir>]`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The four tool calls the tally counts, in the order the record lists them. */
const AGENT_OPERATIONS = [
  "agent_start",
  "agent_resume",
  "agent_steer",
  "agent_cancel",
];

/** Every row of a backend's table, in the record's order. */
const OPERATIONS = [...AGENT_OPERATIONS, "Session shutdown", "Session switch"];

/**
 * The backends that always get a table, with the record's headings.
 *
 * All three are printed whether or not they were used, because a zero row is
 * the finding the per-backend gate exists to make: a tally that omitted the
 * backend nobody ran would read as full.
 */
const KNOWN_BACKENDS = [
  ["pi", "Pi"],
  ["claude", "Claude"],
  ["codex", "Codex"],
];

/** The backend a Profile gets when it names none — `domain/ids.ts`. */
const DEFAULT_BACKEND = "pi";

/** What every row of the record's table says it wants. */
const EXIT_GATE_WANTS = "several, across distinct days";

/** Pi's own environment override for the agent directory. */
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

class SoakTallyError extends Error {
  constructor(message) {
    super(message);
    this.name = "SoakTallyError";
  }
}

/** A failure that names the file and the line it was found on. */
function fail(file, line, what) {
  return new SoakTallyError(`${file}:${line} — ${what}`);
}

/** Where Pi keeps its agent directory, by the same rule Pi uses. */
export function defaultAgentDir() {
  const fromEnvironment = process.env[ENV_AGENT_DIR];
  if (fromEnvironment) {
    return fromEnvironment.startsWith("~")
      ? path.join(os.homedir(), fromEnvironment.slice(1))
      : fromEnvironment;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * The local day an instant falls on, as `YYYY-MM-DD`.
 *
 * Local rather than UTC because a soak day is a day of the maintainer's work,
 * and a session that ran until one in the morning was that day's usage.
 */
function localDay(instant, file, line) {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime()))
    throw fail(file, line, `'${instant}' is not a readable timestamp`);
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * Read each Profile's backend out of its frontmatter.
 *
 * Deliberately a smaller parser than the extension's: it wants one field, and
 * a Profile it cannot read is not an error here — a start naming it is listed
 * as unattributed, which is the honest outcome for a Profile that has been
 * edited or deleted since the Session that used it.
 */
export function readProfileBackends(profilesDir) {
  const backends = new Map();
  if (!fs.existsSync(profilesDir)) return backends;
  for (const entry of fs.readdirSync(profilesDir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const file = path.join(profilesDir, entry);
    if (!fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!frontmatter) continue;
    const named = /^backend:[ \t]*(.+)$/m.exec(frontmatter[1]);
    const backend = named?.[1].trim().replace(/^["']|["']$/g, "");
    backends.set(
      entry.slice(0, -".md".length),
      backend && backend.length > 0 ? backend : DEFAULT_BACKEND,
    );
  }
  return backends;
}

/** Every `*.jsonl` under a sessions directory, in path order. */
function sessionFiles(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const here = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(here);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        found.push(here);
    }
  };
  walk(sessionsDir);
  return found.sort();
}

/**
 * Read one Session file into its header and its numbered entries.
 *
 * The line numbers are carried through everything below, because both things
 * this script reports — an unattributable id and a format change — are only
 * useful if a person can open the line.
 */
function readSessionFile(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const entries = [];
  let header;
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (raw.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      throw fail(file, line, "is not a JSON object");
    }
    if (entry?.type === "session" && header === undefined) {
      if (typeof entry.timestamp !== "string")
        throw fail(file, line, "the session header has no timestamp");
      if (typeof entry.cwd !== "string")
        throw fail(file, line, "the session header has no cwd");
      header = { timestamp: entry.timestamp, cwd: entry.cwd, line };
    }
    entries.push({ entry, line });
  }
  if (header === undefined)
    throw fail(file, 1, "has no session header, so it is not a Session file");
  return { header, entries };
}

/** The text parts of a tool result, joined. */
function resultText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function requireString(value, file, line, what) {
  if (typeof value !== "string" || value.trim().length === 0)
    throw fail(file, line, what);
  return value.trim();
}

/** Add one occurrence of an operation, on a day, to a backend's row. */
function record(rows, backend, operation, day) {
  let backendRows = rows.get(backend);
  if (backendRows === undefined) {
    backendRows = new Map(
      OPERATIONS.map((name) => [name, { occurrences: 0, days: new Set() }]),
    );
    rows.set(backend, backendRows);
  }
  const row = backendRows.get(operation);
  row.occurrences += 1;
  row.days.add(day);
}

/**
 * Count one Session, and report which backends it had open.
 *
 * The pass is single and forward: a tool call is counted where it is found and
 * remembered by its call id, and the tool result that follows is what supplies
 * the ids a later call in the same Session will name.
 */
function tallySession({ file, session, profileBackends, rows, unattributed }) {
  const subagentBackends = new Map();
  const runBackends = new Map();
  const awaitingResult = new Map();
  const used = new Set();
  let lastInstant = session.header.timestamp;

  const listUnattributed = (line, operation, id, why) => {
    unattributed.push({ file, line, operation, id, why });
  };

  for (const { entry, line } of session.entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message === null || typeof message !== "object") continue;
    if (typeof entry.timestamp === "string") lastInstant = entry.timestamp;

    if (message.role === "toolResult") {
      const pending = awaitingResult.get(message.toolCallId);
      if (pending === undefined) continue;
      awaitingResult.delete(message.toolCallId);
      if (message.isError === true) continue;
      const text = resultText(message.content);
      const subagentId = /(?:^|\n)subagent id (\S+)/.exec(text)?.[1];
      const runId = /(?:^|\n)run id (\S+)/.exec(text)?.[1];
      if (pending.backend === undefined) continue;
      if (subagentId !== undefined)
        subagentBackends.set(subagentId, pending.backend);
      if (runId !== undefined) runBackends.set(runId, pending.backend);
      continue;
    }

    if (!Array.isArray(message.content)) continue;
    for (const item of message.content) {
      if (item === null || typeof item !== "object") continue;
      if (item.type !== "toolCall") continue;
      // Every toolCall is checked, not only the four this script counts: a
      // format change that renamed the field would otherwise look like a
      // Session in which nobody delegated anything.
      const name = requireString(
        item.name,
        file,
        line,
        "a toolCall entry has no name field",
      );
      if (!AGENT_OPERATIONS.includes(name)) continue;

      const callId = requireString(
        item.id,
        file,
        line,
        `${name} has no toolCall id, so its result cannot be read`,
      );
      const args = item.arguments;
      if (args === null || typeof args !== "object" || Array.isArray(args))
        throw fail(file, line, `${name} has no arguments object`);
      const instant = requireString(
        entry.timestamp,
        file,
        line,
        `the entry carrying ${name} has no timestamp`,
      );
      const day = localDay(instant, file, line);

      if (name === "agent_start") {
        const profile = requireString(
          args.agent,
          file,
          line,
          "agent_start has no agent argument",
        );
        const backend = profileBackends.get(profile);
        if (backend === undefined)
          listUnattributed(
            line,
            name,
            profile,
            "no Profile of that name is on disk, so its backend cannot be read",
          );
        else {
          record(rows, backend, name, day);
          used.add(backend);
        }
        awaitingResult.set(callId, { backend });
        continue;
      }

      if (name === "agent_resume") {
        const subagentId = requireString(
          args.id,
          file,
          line,
          "agent_resume has no id argument",
        );
        const backend = subagentBackends.get(subagentId);
        if (backend === undefined)
          listUnattributed(
            line,
            name,
            subagentId,
            "no agent_start in this Session produced that Subagent id",
          );
        else {
          record(rows, backend, name, day);
          used.add(backend);
        }
        awaitingResult.set(callId, { backend });
        continue;
      }

      if (name === "agent_steer") {
        const runId = requireString(
          args.id,
          file,
          line,
          "agent_steer has no id argument",
        );
        const backend = runBackends.get(runId);
        if (backend === undefined)
          listUnattributed(
            line,
            name,
            runId,
            "no agent_start or agent_resume in this Session produced that Run id",
          );
        else {
          record(rows, backend, name, day);
          used.add(backend);
        }
        continue;
      }

      // agent_cancel names a list. One call is one operation, so it counts
      // once per backend it reached rather than once per Run id — three Pi
      // Runs stopped together were one cancel.
      const ids = args.ids;
      if (!Array.isArray(ids))
        throw fail(file, line, "agent_cancel has no ids array");
      if (ids.length === 0) {
        listUnattributed(line, name, "", "the call named no Run ids");
        continue;
      }
      const reached = new Set();
      for (const raw of ids) {
        const runId = requireString(
          raw,
          file,
          line,
          "agent_cancel names an id that is not a string",
        );
        const backend = runBackends.get(runId);
        if (backend === undefined)
          listUnattributed(
            line,
            name,
            runId,
            "no agent_start or agent_resume in this Session produced that Run id",
          );
        else reached.add(backend);
      }
      for (const backend of reached) {
        record(rows, backend, name, day);
        used.add(backend);
      }
    }
  }

  // One shutdown per Session, under every backend that Session had open, on
  // the day the Session's last entry falls on rather than its first: a Session
  // that ran past midnight shut down on the later day.
  const shutdownDay = localDay(lastInstant, file, session.header.line);
  for (const backend of used)
    record(rows, backend, "Session shutdown", shutdownDay);

  return {
    cwd: session.header.cwd,
    startedAt: session.header.timestamp,
    startDay: localDay(session.header.timestamp, file, session.header.line),
    used,
  };
}

/**
 * Count the switches between the Sessions that were read.
 *
 * A switch is a second Session file in the same working directory on the same
 * day — the maintainer reloaded. The switch *is* that second Session, and the
 * record says a switch is a property of the Session rather than of a backend,
 * counted under each backend that Session had open. So it is attributed to the
 * Session that was switched to and not to the one before it: what a switch
 * exercises is a Session whose ids start again while the previous Session's
 * report unknown, and that is the new Session's to show. The old Session's
 * side of it is already counted as that Session's shutdown, and counting the
 * union of the two would let a backend record more switches than it ever had
 * Sessions.
 */
function tallySwitches(sessions, rows) {
  const byDirectoryAndDay = new Map();
  for (const session of sessions) {
    const key = `${session.cwd}\n${session.startDay}`;
    const group = byDirectoryAndDay.get(key);
    if (group === undefined) byDirectoryAndDay.set(key, [session]);
    else group.push(session);
  }
  for (const group of byDirectoryAndDay.values()) {
    group.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    for (const switched of group.slice(1))
      for (const backend of switched.used)
        record(rows, backend, "Session switch", switched.startDay);
  }
}

/**
 * The tally: operation rows per backend, what could not be attributed, and how
 * many Sessions were read.
 */
export function computeTally({ sessionsDir, profilesDir, since }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? ""))
    throw new SoakTallyError(
      `'${since}' is not a since-date; give one as YYYY-MM-DD`,
    );
  const profileBackends = readProfileBackends(profilesDir);
  const rows = new Map(
    KNOWN_BACKENDS.map(([id]) => [
      id,
      new Map(
        OPERATIONS.map((name) => [name, { occurrences: 0, days: new Set() }]),
      ),
    ]),
  );
  const unattributed = [];
  const counted = [];

  for (const file of sessionFiles(sessionsDir)) {
    const session = readSessionFile(file);
    const startDay = localDay(
      session.header.timestamp,
      file,
      session.header.line,
    );
    if (startDay < since) continue;
    counted.push(
      tallySession({ file, session, profileBackends, rows, unattributed }),
    );
  }
  tallySwitches(counted, rows);

  return {
    since,
    sessionsDir,
    profilesDir,
    rows: new Map(
      [...rows].map(([backend, backendRows]) => [
        backend,
        new Map(
          [...backendRows].map(([operation, row]) => [
            operation,
            { occurrences: row.occurrences, days: row.days.size },
          ]),
        ),
      ]),
    ),
    unattributed,
    sessionsRead: counted.length,
  };
}

/** The heading a backend's table gets, capitalised as the record has it. */
function headingFor(backend) {
  const known = KNOWN_BACKENDS.find(([id]) => id === backend);
  return known ? known[1] : backend;
}

/** The record's row label: a tool call in code font, a Session event in prose. */
function rowLabel(operation) {
  return AGENT_OPERATIONS.includes(operation) ? `\`${operation}\`` : operation;
}

/**
 * The three tables in the record's format, then what could not be attributed,
 * then how many Sessions were read.
 *
 * The tables are printed to be pasted over the record's, so their headings and
 * their four columns are the record's exactly. What follows the tables is for
 * reading rather than pasting.
 */
export function formatTally(tally) {
  const lines = [];
  const backends = [
    ...KNOWN_BACKENDS.map(([id]) => id),
    ...[...tally.rows.keys()]
      .filter((id) => !KNOWN_BACKENDS.some(([known]) => known === id))
      .sort(),
  ];

  for (const backend of backends) {
    lines.push(`### ${headingFor(backend)}`, "");
    lines.push("| Operation | Occurrences | Distinct days | Exit gate wants |");
    lines.push("| --- | --- | --- | --- |");
    for (const operation of OPERATIONS) {
      const row = tally.rows.get(backend)?.get(operation) ?? {
        occurrences: 0,
        days: 0,
      };
      lines.push(
        `| ${rowLabel(operation)} | ${row.occurrences} | ${row.days} | ${EXIT_GATE_WANTS} |`,
      );
    }
    lines.push("");
  }

  lines.push("### Unattributed", "");
  if (tally.unattributed.length === 0) lines.push("_Nothing._");
  else
    for (const entry of tally.unattributed) {
      const where = path.relative(tally.sessionsDir, entry.file) || entry.file;
      const id = entry.id ? ` \`${entry.id}\`` : "";
      lines.push(
        `- \`${entry.operation}\`${id} — ${where}:${entry.line} — ${entry.why}`,
      );
    }
  lines.push("");
  lines.push(`Sessions read: ${tally.sessionsRead}`);
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  const options = { since: undefined };
  const rest = [...argv];
  const valueFor = (flag) => {
    const value = rest.shift();
    if (value === undefined || value.startsWith("--"))
      throw new SoakTallyError(`${flag} needs a directory after it`);
    return value;
  };
  while (rest.length > 0) {
    const argument = rest.shift();
    if (argument === "--sessions") options.sessionsDir = valueFor(argument);
    else if (argument === "--profiles")
      options.profilesDir = valueFor(argument);
    else if (argument.startsWith("--"))
      throw new SoakTallyError(`unknown option '${argument}'`);
    else if (options.since === undefined) options.since = argument;
    else throw new SoakTallyError(`unexpected argument '${argument}'`);
  }
  const agentDir = defaultAgentDir();
  return {
    since: options.since,
    sessionsDir: options.sessionsDir ?? path.join(agentDir, "sessions"),
    profilesDir: options.profilesDir ?? path.join(agentDir, "agents"),
  };
}

const USAGE =
  "usage: node scripts/soak-tally.mjs <since-date> [--sessions <dir>] [--profiles <dir>]";

function main(argv) {
  if (argv.length === 0 || argv.includes("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parseArguments(argv);
  process.stdout.write(formatTally(computeTally(options)));
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `soak-tally: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
  }
}
