// Agent template discovery, parsing, and rendering.
// Templates are markdown files with YAML frontmatter + prompt body.
// Locations: ~/.open-cockpit/agents/ (global), <project>/.open-cockpit/agents/ (local overrides global)

const fs = require("fs");
const path = require("path");
const os = require("os");
const GLOBAL_AGENTS_DIR = path.join(os.homedir(), ".open-cockpit", "agents");

/**
 * Parse a single agent template file.
 * Returns { name, description, cwd, flags, prompt } or null on error.
 */
function parseAgentFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const name = path.basename(filePath, ".md");
  let description = "";
  let cwd = "";
  let flags = "";
  let prompt = content;

  // Parse YAML frontmatter (--- delimited)
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fmMatch) {
    const frontmatter = fmMatch[1];
    prompt = fmMatch[2].trim();

    for (const line of frontmatter.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      switch (key) {
        case "description":
          description = val;
          break;
        case "cwd":
          cwd = val;
          break;
        case "flags":
          flags = val;
          break;
      }
    }
  }

  return { name, description, cwd, flags, prompt, filePath };
}

/**
 * Discover all agent templates. Project-local agents override global ones by name.
 * @param {string} [projectDir] - Optional project directory for local agents
 * @returns {Array<{name, description, cwd, flags, prompt, filePath}>}
 */
function discoverAgents(projectDir) {
  const agents = new Map();

  // Global agents
  scanDir(GLOBAL_AGENTS_DIR, agents);

  // Project-local agents (override global by name)
  if (projectDir) {
    const localDir = path.join(projectDir, ".open-cockpit", "agents");
    scanDir(localDir, agents);
  }

  return Array.from(agents.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function scanDir(dir, agents) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const agent = parseAgentFile(path.join(dir, entry));
    if (agent) agents.set(agent.name, agent);
  }
}

/**
 * Render a template prompt with args substitution.
 * Replaces {{args}} with the provided args string.
 */
function renderPrompt(template, args) {
  let prompt = template.prompt;
  if (args) {
    prompt = prompt.replace(/\{\{args\}\}/g, args);
  } else {
    // Remove {{args}} placeholder if no args provided
    prompt = prompt.replace(/\{\{args\}\}/g, "").trim();
  }
  return prompt;
}

/**
 * Resolve the cwd for an agent template.
 * "." = callerCwd, "~" = home, absolute = as-is, relative = from callerCwd
 */
function resolveCwd(templateCwd, callerCwd) {
  if (!templateCwd || templateCwd === ".") return callerCwd || os.homedir();
  if (templateCwd.startsWith("~")) {
    return path.join(os.homedir(), templateCwd.slice(1));
  }
  if (path.isAbsolute(templateCwd)) return templateCwd;
  return callerCwd
    ? path.join(callerCwd, templateCwd)
    : path.join(os.homedir(), templateCwd);
}

module.exports = {
  GLOBAL_AGENTS_DIR,
  parseAgentFile,
  discoverAgents,
  renderPrompt,
  resolveCwd,
};
