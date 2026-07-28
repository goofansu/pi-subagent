import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.ts";

/**
 * Build the ordered list of skill paths matching pi's discovery priority:
 * project .pi > project .agents > user .pi > user .agents.
 */
export function buildSkillPaths(
  cwd: string,
  agentDir = getAgentDir(),
): string[] {
  return [
    path.join(cwd, ".pi", "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(agentDir, "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
}

export function resolveSkillPaths(
  skillNames: string[],
  cwd: string,
  agentDir = getAgentDir(),
): { resolved: Array<{ name: string; path: string }>; missing: string[] } {
  const skillPaths = buildSkillPaths(cwd, agentDir);
  const { skills: discovered } = loadSkills({
    cwd,
    agentDir,
    skillPaths,
    includeDefaults: false,
  });
  const skillMap = new Map(discovered.map((s) => [s.name, s.filePath]));

  const resolved: Array<{ name: string; path: string }> = [];
  const missing: string[] = [];

  for (const name of skillNames) {
    const filePath = skillMap.get(name);
    if (filePath) {
      resolved.push({ name, path: filePath });
    } else {
      missing.push(name);
    }
  }

  return { resolved, missing };
}

/**
 * Resolve an agent's declared skills to SKILL.md paths. `undefined` means the
 * agent declared no skills and the backend should fall back to its own
 * discovery; an array — including an empty one — means this extension owns the
 * skill set exactly.
 */
export function resolveAgentSkillPaths(
  config: AgentConfig,
  configCwd: string,
  agentDir = getAgentDir(),
): string[] | undefined {
  if (!config.skills) return undefined;

  const result = resolveSkillPaths(config.skills, configCwd, agentDir);
  if (result.missing.length > 0) {
    throw new Error(
      `Agent '${config.name}': unknown skills: ${result.missing.join(", ")}`,
    );
  }
  return result.resolved.map((s) => s.path);
}
