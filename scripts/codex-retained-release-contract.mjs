function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evidenceRecords(markdown) {
  const matches = [...markdown.matchAll(/^###\s+(.+)$/gm)];
  return matches.map((match, index) => ({
    heading: match[1].trim(),
    body: markdown.slice(
      match.index + match[0].length,
      matches[index + 1]?.index ?? markdown.length,
    ),
  }));
}

function field(body, name) {
  const normalized = body.replaceAll("`", "");
  const match = normalized.match(
    new RegExp(`^- ${escapeRegExp(name)}:[ \\t]*(.*)$`, "mi"),
  );
  return match?.[1]?.trim();
}

function hasEvidence(value, status) {
  return new RegExp(`^${status}\\s+[—-]\\s+\\S`, "i").test(value ?? "");
}

function isComplete(record) {
  const present = (name) => {
    const value = field(record.body, name);
    return (
      !!value && !/^(?:PASS\/FAIL|YES\/NO|evidence|path|TBD)$/i.test(value)
    );
  };
  return (
    present("Operator") &&
    present("OS") &&
    present("Codex Desktop version") &&
    present("Smoke log") &&
    hasEvidence(field(record.body, "Desktop before smoke"), "PASS") &&
    hasEvidence(
      field(record.body, "Desktop during retained-idle prompt"),
      "PASS",
    ) &&
    hasEvidence(field(record.body, "Desktop during active Turn 2"), "PASS") &&
    hasEvidence(field(record.body, "CODEX_RESUME_LIVE_SMOKE_PASS"), "PASS") &&
    present("Descendant cleanup") &&
    hasEvidence(field(record.body, "Desktop after Session cleanup"), "PASS") &&
    hasEvidence(
      field(record.body, "Rollout-writer/storage conflict observed"),
      "NO",
    ) &&
    /^PASS$/i.test(field(record.body, "Release conclusion") ?? "")
  );
}

/** Require one preserved, complete human/authenticated record for this CLI. */
export function assertRetainedReleaseEvidence(markdown, cliVersion) {
  const records = evidenceRecords(markdown).filter((record) =>
    record.heading.includes(cliVersion),
  );
  const complete = records.find(isComplete);
  if (!complete) {
    throw new Error(
      `Codex retained lifecycle: no complete evidence record for ${cliVersion}`,
    );
  }
  return {
    heading: complete.heading,
    smokeLog: field(complete.body, "Smoke log"),
  };
}
