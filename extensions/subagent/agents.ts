import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./types.js";

export function parseAgentConfig(filePath: string): AgentConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter<{
    description?: string;
    model?: string;
  }>(content);
  return {
    name: path.basename(filePath, path.extname(filePath)),
    description: frontmatter.description ?? "",
    model: frontmatter.model,
    systemPrompt: body.trim(),
  };
}

export function getDefaultAgentsDir(moduleUrl: string): string {
  return path.join(path.dirname(new URL(moduleUrl).pathname), "../../agents");
}

export function loadAgentConfigs(agentsDir: string): Map<string, AgentConfig> {
  const agentConfigs = new Map<string, AgentConfig>();
  if (!fs.existsSync(agentsDir)) return agentConfigs;
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const config = parseAgentConfig(path.join(agentsDir, file));
    agentConfigs.set(config.name, config);
  }
  return agentConfigs;
}
