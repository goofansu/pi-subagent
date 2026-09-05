import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  computeTally,
  formatTally,
  parseArguments,
  readProfileBackends,
} from "./soak-tally.mjs";

/**
 * Two synthetic Sessions in one working directory on one day.
 *
 * Session A starts four Subagents — two on a Profile that names `pi`, one on a
 * Profile that names no backend at all, one on a Profile that names `claude` —
 * then resumes the first, steers the fourth, cancels one Run of each backend in
 * a single call, and resumes a Subagent id that no start in this Session
 * produced. Session B starts two Pi Subagents and, between them, a Profile that
 * has been deleted and a steer of a Run id belonging to Session A — so Claude
 * is open in Session A and nowhere else, which is what tells the switch rule
 * apart from one that counted the union of both Sessions.
 *
 * Every timestamp sits between 12:00Z and 13:00Z on one UTC day, so the local
 * day the script derives is the same day for every entry in every time zone.
 */
const FIXTURES = path.join(import.meta.dirname, "fixtures", "soak-tally");
const SESSIONS = path.join(FIXTURES, "sessions");
const PROFILES = path.join(FIXTURES, "profiles");
const MALFORMED = path.join(FIXTURES, "malformed");
const REWORDED = path.join(FIXTURES, "reworded");

function fixtureTally(since = "2026-09-05") {
  return computeTally({
    sessionsDir: SESSIONS,
    profilesDir: PROFILES,
    since,
  });
}

function row(tally, backend, operation) {
  const found = tally.rows.get(backend)?.get(operation);
  assert.ok(found, `no ${operation} row for ${backend}`);
  return found;
}

test("a Profile's frontmatter names its backend, and a Profile that names none inherits pi", () => {
  const backends = readProfileBackends(PROFILES);
  assert.equal(backends.get("explore"), "pi");
  assert.equal(backends.get("reviewer"), "claude");
  assert.equal(backends.get("implementer"), "pi");
  assert.equal(backends.get("inherited"), "pi");
  assert.equal(backends.has("not-a-profile"), false);
});

test("a start is counted under its Profile's backend, and a resume or a steer under the backend of what produced its id", () => {
  const tally = fixtureTally();

  assert.deepEqual(row(tally, "pi", "agent_start"), {
    occurrences: 5,
    days: 1,
  });
  assert.deepEqual(row(tally, "pi", "agent_resume"), {
    occurrences: 1,
    days: 1,
  });
  assert.deepEqual(row(tally, "pi", "agent_steer"), {
    occurrences: 0,
    days: 0,
  });

  assert.deepEqual(row(tally, "claude", "agent_start"), {
    occurrences: 1,
    days: 1,
  });
  assert.deepEqual(row(tally, "claude", "agent_steer"), {
    occurrences: 1,
    days: 1,
  });
});

test("one cancel call naming Runs of two backends counts once under each", () => {
  const tally = fixtureTally();
  assert.deepEqual(row(tally, "pi", "agent_cancel"), {
    occurrences: 1,
    days: 1,
  });
  assert.deepEqual(row(tally, "claude", "agent_cancel"), {
    occurrences: 1,
    days: 1,
  });
});

test("an id no start in the same Session produced is listed rather than counted", () => {
  const tally = fixtureTally();

  const resume = tally.unattributed.find(
    (entry) => entry.id === "subagent-zz-9",
  );
  assert.ok(resume, "the unresolvable resume is not listed");
  assert.equal(resume.operation, "agent_resume");
  assert.equal(resume.line, 13);
  assert.match(resume.file, /session-a\.jsonl$/);

  // Resolution is per Session: Session B steers a Run that Session A started.
  const steer = tally.unattributed.find((entry) => entry.id === "run-aa-1");
  assert.ok(steer, "the cross-Session steer is not listed");
  assert.equal(steer.operation, "agent_steer");
  assert.equal(steer.line, 6);
  assert.match(steer.file, /session-b\.jsonl$/);

  // A start naming a Profile that is no longer on disk is listed too, so the
  // tally never reads fuller than the usage was.
  const start = tally.unattributed.find((entry) => entry.id === "ghost");
  assert.ok(start, "the start on a missing Profile is not listed");
  assert.equal(start.operation, "agent_start");

  assert.equal(tally.unattributed.length, 3);

  // Nothing listed is also counted.
  const counted = ["pi", "claude"].reduce(
    (total, backend) =>
      total +
      row(tally, backend, "agent_start").occurrences +
      row(tally, backend, "agent_resume").occurrences +
      row(tally, backend, "agent_steer").occurrences,
    0,
  );
  assert.equal(counted, 5 + 1 + 1 + 1);
});

test("a second Session in the same working directory on the same day is a switch, counted under the backends that Session had open", () => {
  const tally = fixtureTally();

  // Session B is the switch, and it had only pi open. Claude was open in
  // Session A only, so it gets no switch: counting the union of the two
  // Sessions would let a backend record more switches than it had Sessions.
  assert.deepEqual(row(tally, "pi", "Session switch"), {
    occurrences: 1,
    days: 1,
  });
  assert.deepEqual(row(tally, "claude", "Session switch"), {
    occurrences: 0,
    days: 0,
  });

  // A shutdown is per Session, under the backends that Session used: Session A
  // used pi and claude, Session B used pi alone.
  assert.deepEqual(row(tally, "pi", "Session shutdown"), {
    occurrences: 2,
    days: 1,
  });
  assert.deepEqual(row(tally, "claude", "Session shutdown"), {
    occurrences: 1,
    days: 1,
  });

  assert.equal(tally.sessionsRead, 2);
});

test("a Session that started before the since date is not read", () => {
  const tally = fixtureTally("2027-01-01");
  assert.equal(tally.sessionsRead, 0);
  assert.equal(tally.unattributed.length, 0);
  assert.deepEqual(row(tally, "pi", "agent_start"), {
    occurrences: 0,
    days: 0,
  });
});

test("a toolCall entry with no name fails loudly, naming the file and the line", () => {
  assert.throws(
    () =>
      computeTally({
        sessionsDir: MALFORMED,
        profilesDir: PROFILES,
        since: "2026-09-05",
      }),
    (error) => {
      assert.match(error.message, /session-c\.jsonl/);
      assert.match(error.message, /:2\b/);
      assert.match(error.message, /name/);
      return true;
    },
  );
});

test("the printed tables carry soak.md's headings and columns, so they can be pasted over the old ones", () => {
  const printed = formatTally(fixtureTally());

  for (const heading of ["### Pi", "### Claude"]) {
    assert.ok(printed.includes(`${heading}\n`), `no ${heading} table`);
  }
  assert.ok(
    printed.includes(
      "| Operation | Occurrences | Distinct days | Exit gate wants |",
    ),
  );
  assert.ok(printed.includes("| --- | --- | --- | --- |"));
  assert.ok(
    printed.includes(
      "| `agent_start` | 5 | 1 | several, across distinct days |",
    ),
  );
  assert.ok(
    printed.includes(
      "| Session switch | 1 | 1 | several, across distinct days |",
    ),
  );
  assert.ok(printed.includes("subagent-zz-9"));
  assert.ok(printed.includes("Sessions read: 2"));
});

test("a result whose wording has changed fails loudly, naming the file and the line", () => {
  // The ids are read out of the tool result's prose, so the prose is a format
  // this script depends on. A start that no longer says "Started …" would
  // otherwise leave every later resume, steer and cancel unresolvable — which
  // reaches the record as a smaller tally rather than as an error.
  assert.throws(
    () =>
      computeTally({
        sessionsDir: REWORDED,
        profilesDir: PROFILES,
        since: "2026-09-05",
      }),
    (error) => {
      assert.match(error.message, /session-d\.jsonl/);
      assert.match(error.message, /:3\b/);
      assert.match(error.message, /agent_start/);
      assert.match(error.message, /presentation\/prose\.ts/);
      return true;
    },
  );
});

test("a directory flag with nothing usable after it is refused rather than quietly defaulted", () => {
  // A tally of the wrong tree is the one wrong answer this script can give
  // without saying so, so neither of these may fall back to Pi's own home.
  assert.throws(
    () => parseArguments(["2026-09-05", "--sessions"]),
    /--sessions needs a directory after it/,
  );
  assert.throws(
    () => parseArguments(["2026-09-05", "--sessions", "--profiles", "/p"]),
    /--sessions needs a directory after it/,
  );
  assert.throws(
    () => parseArguments(["2026-09-05", "--session", "/s"]),
    /unknown option '--session'/,
  );
  assert.throws(
    () => parseArguments(["2026-09-05", "2026-09-06"]),
    /unexpected argument '2026-09-06'/,
  );
});

test("both directories default under Pi's agent directory, and either flag overrides its own", () => {
  const defaults = parseArguments(["2026-09-05"]);
  assert.equal(defaults.since, "2026-09-05");
  assert.equal(path.basename(defaults.sessionsDir), "sessions");
  assert.equal(path.basename(defaults.profilesDir), "agents");
  assert.equal(
    path.dirname(defaults.sessionsDir),
    path.dirname(defaults.profilesDir),
  );

  const given = parseArguments([
    "2026-09-05",
    "--sessions",
    SESSIONS,
    "--profiles",
    PROFILES,
  ]);
  assert.equal(given.sessionsDir, SESSIONS);
  assert.equal(given.profilesDir, PROFILES);

  const onlyOne = parseArguments(["2026-09-05", "--profiles", PROFILES]);
  assert.equal(onlyOne.profilesDir, PROFILES);
  assert.equal(path.basename(onlyOne.sessionsDir), "sessions");
});
