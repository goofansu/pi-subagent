import type { Profile } from "../domain/index.ts";

/**
 * The Profile catalog exposed to the parent model.
 *
 * Descriptions are context pointers: each says what an agent does and when the
 * parent should delegate to it. Execution fields stay out of the prompt because
 * `agent_start` resolves those from the Profile after the parent chooses a name.
 */
export function formatAvailableAgents(profiles: readonly Profile[]): string {
  const lines = [
    "The following agents are available for delegated tasks.",
    "Use agent_start when a task matches an agent's description.",
    "",
    "<available_agents>",
  ];

  for (const profile of profiles) {
    lines.push("  <agent>");
    lines.push(`    <name>${escapeXml(profile.name)}</name>`);
    lines.push(
      `    <description>${escapeXml(profile.description)}</description>`,
    );
    lines.push("  </agent>");
  }

  lines.push("</available_agents>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
