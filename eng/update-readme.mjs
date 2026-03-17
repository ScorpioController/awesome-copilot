#!/usr/bin/env node

import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import {
    AGENTS_DIR,
    AKA_INSTALL_URLS,
    DOCS_DIR,
    HOOKS_DIR,
    INSTRUCTIONS_DIR,
    PLUGINS_DIR,
    repoBaseUrl,
    ROOT_FOLDER,
    SKILLS_DIR,
    TEMPLATES,
    vscodeInsidersInstallImage,
    vscodeInstallImage,
    WORKFLOWS_DIR,
} from "./constants.mjs";
import {
    extractMcpServerConfigs,
    parseFrontmatter,
    parseSkillMetadata,
    parseHookMetadata,
    parseWorkflowMetadata,
} from "./yaml-parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache of MCP registry server names (lower-cased) fetched from the API
let MCP_REGISTRY_SET = null;
/**
 * Loads and caches the set of MCP registry server names from the GitHub MCP registry API.
 *
 * Behavior:
 * - If a cached set already exists (MCP_REGISTRY_SET), it is returned immediately.
 * - Fetches all pages from https://api.mcp.github.com/v0.1/servers/ using cursor-based pagination
 * - Safely handles network errors or malformed JSON by returning an empty array.
 * - Extracts server names from: data[].server.name
 * - Normalizes names to lowercase for case-insensitive matching
 * - Only hits the API once per README build run (cached for subsequent calls)
 *
 * Side Effects:
 * - Mutates the module-scoped variable MCP_REGISTRY_SET.
 * - Logs a warning to console if fetching or parsing the registry fails.
 *
 * @returns {Promise<{ name: string, displayName: string }[]>} Array of server entries with name and lowercase displayName. May be empty if
 *          the API is unreachable or returns malformed data.
 *
 * @throws {none} All errors are caught internally; failures result in an empty array.
 */
async function loadMcpRegistryNames() {
  if (MCP_REGISTRY_SET) return MCP_REGISTRY_SET;

  try {
    console.log("Fetching MCP registry from API...");
    const allServers = [];
    let cursor = null;
    const apiUrl = "https://api.mcp.github.com/v0.1/servers/";

    // Fetch all pages using cursor-based pagination
    do {
      const url = cursor
        ? `${apiUrl}?cursor=${encodeURIComponent(cursor)}`
        : apiUrl;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`API returned status ${response.status}`);
      }

      const json = await response.json();
      const servers = json?.servers || [];

      // Extract server names and displayNames from the response
      for (const entry of servers) {
        const serverName = entry?.server?.name;
        if (serverName) {
          // Try to get displayName from GitHub metadata, fall back to server name
          const displayName =
            entry?.server?._meta?.[
              "io.modelcontextprotocol.registry/publisher-provided"
            ]?.github?.displayName || serverName;

          allServers.push({
            name: serverName,
            displayName: displayName.toLowerCase(),
            // Also store the original full name for matching
            fullName: serverName.toLowerCase(),
          });
        }
      }

      // Get next cursor for pagination
      cursor = json?.metadata?.nextCursor || null;
    } while (cursor);

    console.log(`Loaded ${allServers.length} servers from MCP registry`);
    MCP_REGISTRY_SET = allServers;
  } catch (e) {
    console.warn(`Failed to load MCP registry from API: ${e.message}`);
    MCP_REGISTRY_SET = [];
  }

  return MCP_REGISTRY_SET;
}

// Add error handling utility
/**
 * Safe file operation wrapper
 */
function safeFileOperation(operation, filePath, defaultValue = null) {
  try {
    return operation();
  } catch (error) {
    console.error(`Error processing file ${filePath}: ${error.message}`);
    return defaultValue;
  }
}

function extractTitle(filePath) {
  return safeFileOperation(
    () => {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");

      // Step 1: Try to get title from frontmatter using vfile-matter
      const frontmatter = parseFrontmatter(filePath);

      if (frontmatter) {
        // Check for name field
        if (frontmatter.name && typeof frontmatter.name === "string") {
          return frontmatter.name
            .split("-")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
        }
      }

      // Step 2: For prompt/agent/instructions files, look for heading after frontmatter
      if (
        filePath.includes(".prompt.md") ||
        filePath.includes(".agent.md") ||
        filePath.includes(".instructions.md")
      ) {
        // Look for first heading after frontmatter
        let inFrontmatter = false;
        let frontmatterEnded = false;
        let inCodeBlock = false;

        for (const line of lines) {
          if (line.trim() === "---") {
            if (!inFrontmatter) {
              inFrontmatter = true;
            } else if (inFrontmatter && !frontmatterEnded) {
              frontmatterEnded = true;
            }
            continue;
          }

          // Only look for headings after frontmatter ends
          if (frontmatterEnded || !inFrontmatter) {
            // Track code blocks to ignore headings inside them
            if (
              line.trim().startsWith("```") ||
              line.trim().startsWith("````")
            ) {
              inCodeBlock = !inCodeBlock;
              continue;
            }

            if (!inCodeBlock && line.startsWith("# ")) {
              return line.substring(2).trim();
            }
          }
        }

        // Step 3: Format filename for prompt/chatmode/instructions files if no heading found
        const basename = path.basename(
          filePath,
          filePath.includes(".prompt.md")
            ? ".prompt.md"
            : filePath.includes(".agent.md")
            ? ".agent.md"
            : ".instructions.md"
        );
        return basename
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, (l) => l.toUpperCase());
      }

      // Step 4: For other files, look for the first heading (but not in code blocks)
      let inCodeBlock = false;
      for (const line of lines) {
        if (line.trim().startsWith("```") || line.trim().startsWith("````")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }

        if (!inCodeBlock && line.startsWith("# ")) {
          return line.substring(2).trim();
        }
      }

      // Step 5: Fallback to filename
      const basename = path.basename(filePath, path.extname(filePath));
      return basename
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase());
    },
    filePath,
    path
      .basename(filePath, path.extname(filePath))
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase())
  );
}

function extractDescription(filePath) {
  return safeFileOperation(
    () => {
      // Use vfile-matter to parse frontmatter for all file types
      const frontmatter = parseFrontmatter(filePath);

      if (frontmatter && frontmatter.description) {
        return frontmatter.description;
      }

      return null;
    },
    filePath,
    null
  );
}

/**
 * Format arbitrary multiline text for safe rendering inside a markdown table cell.
 * - Preserves line breaks by converting to <br />
 * - Escapes pipe characters (|) to avoid breaking table columns
 * - Trims leading/trailing whitespace on each line
 * - Collapses multiple consecutive blank lines
 * This should be applied to descriptions across all file types when used in tables.
 *
 * @param {string|null|undefined} text
 * @returns {string} table-safe content
 */
function formatTableCell(text) {
  if (text === null || text === undefined) return "";
  let s = String(text);
  // Normalize line endings
  s = s.replace(/\r\n/g, "\n");
  // Split lines, trim, drop empty groups while preserving intentional breaks
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter((_, idx, arr) => {
      // Keep single blank lines, drop consecutive blanks
      if (arr[idx] !== "") return true;
      return arr[idx - 1] !== ""; // allow one blank, remove duplicates
    });
  s = lines.join("\n");
  // Escape table pipes
  s = s.replace(/\|/g, "&#124;");
  // Convert remaining newlines to <br /> for a single-cell rendering
  s = s.replace(/\n/g, "<br />");
  return s.trim();
}

const SKILL_CATEGORY_RULES = [
  {
    title: "规划与需求",
    description: "用于需求拆解、方案规划、规格编写和实施路线设计。",
    patterns: [
      /breakdown-/,
      /(^|-)prd($|-)/,
      /specification/,
      /implementation-plan/,
      /technical-spike/,
      /architectural-decision-record/,
      /workflow-specification/,
      /feature-from-specification/,
      /feature-from-implementation-plan/,
      /unmet-specification/,
      /gen-specs-as-issues/,
      /devops-rollout-plan/,
      /blueprint-generator/,
      /rollout-plan/,
    ],
  },
  {
    title: "文档与知识沉淀",
    description: "用于编写 README、教程、会议纪要、知识文档和说明材料。",
    patterns: [
      /documentation/,
      /readme/,
      /^create-llms$/,
      /^update-llms$/,
      /tldr/,
      /repo-story-time/,
      /comment-code-generate-a-tutorial/,
      /convert-plaintext-to-md/,
      /markdown-to-html/,
      /mkdocs/,
      /update-markdown-file-index/,
      /add-educational-comments/,
      /docs/,
      /oo-component-documentation/,
      /create-agentsmd/,
      /write-coding-standards-from-file/,
      /generate-custom-instructions-from-codebase/,
      /mentoring-juniors/,
    ],
  },
  {
    title: "上下文、记忆与协作交接",
    description: "用于整理任务上下文、沉淀经验记忆，并支持后续会话或协作者接续工作。",
    patterns: [
      /context-map/,
      /remember/,
      /memory-merger/,
      /what-context-needed/,
      /copilot-spaces/,
      /first-ask/,
      /meeting-minutes/,
    ],
  },
  {
    title: "代码生成与脚手架",
    description: "用于生成项目骨架、接口代码、MCP 服务、代理或其他可直接落地的模板。",
    patterns: [
      /create-spring-boot/,
      /openapi-to-application/,
      /mcp-server-generator/,
      /typespec-create/,
      /typespec-api-operations/,
      /mcp-create/,
      /power-apps-code-app-scaffold/,
      /make-skill-template/,
      /microsoft-skill-creator/,
      /automate-this/,
      /github-copilot-starter/,
    ],
  },
  {
    title: "代码审查、重构与质量",
    description: "用于代码审查、重构、设计模式检查和质量改进。",
    patterns: [
      /refactor/,
      /review/,
      /doublecheck/,
      /best-practices/,
      /design-pattern-review/,
      /code-review/,
      /code-exemplars/,
      /conventional-commit/,
      /cloud-design-patterns/,
      /agentic-eval/,
      /eval-driven-dev/,
    ],
  },
  {
    title: "测试与调试",
    description: "用于测试生成、测试规划、覆盖率提升、调试与故障定位。",
    patterns: [
      /playwright/,
      /pytest/,
      /junit/,
      /mstest/,
      /nunit/,
      /tunit/,
      /xunit/,
      /jest/,
      /webapp-testing/,
      /scoutqa-test/,
      /polyglot-test-agent/,
      /breakdown-test/,
      /debug/,
    ],
  },
  {
    title: "AI / Copilot / MCP / 提示工程",
    description: "用于 Copilot 能力扩展、代理治理、提示工程、MCP 生态与模型选型。",
    patterns: [
      /agent-governance/,
      /ai-prompt/,
      /boost-prompt/,
      /prompt-builder/,
      /finalize-agent-prompt/,
      /semantic-kernel/,
      /copilot-/,
      /declarative-agents/,
      /entra-agent-user/,
      /mcp-cli/,
      /mcp-deploy-manage-agents/,
      /microsoft-agent-framework/,
      /workiq-copilot/,
      /structured-autonomy/,
      /suggest-awesome-github-copilot/,
      /model-recommendation/,
      /noob-mode/,
      /quasi-coder/,
      /tldr-prompt/,
      /nano-banana-pro-openrouter/,
    ],
  },
  {
    title: "云平台与基础设施",
    description: "用于云资源、基础设施代码、部署验证、容器化和平台运维准备。",
    patterns: [
      /^az-/,
      /^azure-/,
      /appinsights/,
      /terraform/,
      /containerize/,
      /multi-stage-dockerfile/,
      /import-infrastructure-as-code/,
      /publish-to-pages/,
      /update-avm-modules-in-bicep/,
      /aspire/,
      /power-platform-mcp-connector-suite/,
      /flowstudio-power-automate/,
      /azure-static-web-apps/,
    ],
  },
  {
    title: "数据库、数据与迁移",
    description: "用于数据库优化、数据建模、分析场景和跨数据库迁移。",
    patterns: [
      /sql/,
      /postgres/,
      /oracle-to-postgres/,
      /cosmosdb/,
      /bigquery/,
      /fabric-lakehouse/,
      /power-bi/,
      /powerbi/,
      /snowflake/,
      /dataverse/,
      /datanalysis/,
      /shuffle-json-data/,
      /ef-core/,
    ],
  },
  {
    title: "开发工具、CLI 与协作平台",
    description: "用于 CLI、代码托管、问题协作、编辑器扩展和日常开发工具链。",
    patterns: [
      /cli/,
      /git-/,
      /github-issues/,
      /my-issues/,
      /my-pull-requests/,
      /sponsor-finder/,
      /make-repo-contribution/,
      /issue-fields-migration/,
      /winapp-cli/,
      /msstore-cli/,
      /chrome-devtools/,
      /vscode-ext/,
      /editorconfig/,
      /nuget-manager/,
      /microsoft-code-reference/,
      /winmd-api-search/,
      /pdftk-server/,
      /sandbox-npm-install/,
      /linux-triage/,
    ],
  },
  {
    title: "编程语言与框架专题",
    description: "面向特定语言、运行时或框架的开发实践与专项能力。",
    patterns: [
      /csharp-/,
      /java-/,
      /kotlin-/,
      /go-/,
      /php-/,
      /ruby-/,
      /rust-/,
      /swift-/,
      /typescript-/,
      /python-/,
      /aspnet-/,
      /fluentui-blazor/,
      /next-intl-add-language/,
      /web-coder/,
      /game-engine/,
      /finnish-humanizer/,
      /winui3-migration-guide/,
      /unit-test-vue-pinia/,
      /dotnet-upgrade/,
    ],
  },
  {
    title: "设计、可视化与多媒体",
    description: "用于图表设计、界面审阅、视觉表达和媒体处理。",
    patterns: [
      /excalidraw/,
      /penpot/,
      /napkin/,
      /plantuml/,
      /image-manipulation/,
      /transloadit/,
      /legacy-circuit-mockups/,
      /web-design-reviewer/,
    ],
  },
];

// These are the strongest session-handoff skills inside the
// “上下文、记忆与协作交接” category because they persist distilled context
// across sessions instead of only describing the current task state.
// The generator validates this assumption at runtime and warns if a listed
// folder no longer appears in that category.
const SESSION_HANDOFF_BEST_FIT_FOLDERS = ["remember", "memory-merger"];
// Insert a line break after every 8 skills to keep the generated markdown
// readable without making each category list too vertically verbose.
const SKILLS_PER_CHUNK = 8;

function groupSkillsByCategory(skillEntries) {
  const categories = [
    ...SKILL_CATEGORY_RULES.map((category) => ({
      ...category,
      skills: [],
    })),
    {
      title: "未归类",
      description: "暂未归入固定类别的技能。",
      patterns: [],
      skills: [],
    },
  ];
  const fallbackCategory = categories[categories.length - 1];

  for (const skill of skillEntries) {
    const matchingCategory = categories.find((category) =>
      category.patterns.some((pattern) => pattern.test(skill.folder))
    );

    if (matchingCategory) {
      matchingCategory.skills.push(skill);
      continue;
    }

    fallbackCategory.skills.push(skill);
  }

  return categories.filter((category) => category.skills.length > 0);
}

function formatSkillLinks(skills) {
  const links = skills.map(
    (skill) => `[${skill.name}](../skills/${skill.folder}/SKILL.md)`
  );
  const chunks = [];

  for (let i = 0; i < links.length; i += SKILLS_PER_CHUNK) {
    chunks.push(links.slice(i, i + SKILLS_PER_CHUNK).join("、"));
  }

  return chunks.join("<br />");
}

function generateChineseSkillCatalog(skillEntries) {
  const categories = groupSkillsByCategory(skillEntries);
  const handoffCategory =
    categories.find((category) => category.title === "上下文、记忆与协作交接")
      ?.skills ?? [];
  const handoffSkillMap = new Map(
    handoffCategory.map((skill) => [skill.folder, skill])
  );
  const bestFitSkills = SESSION_HANDOFF_BEST_FIT_FOLDERS.map((folder) => {
    const skill = handoffSkillMap.get(folder);
    if (!skill) {
      console.warn(
        `Expected handoff skill "${folder}" was not found in the "上下文、记忆与协作交接" category. Verify that the skill exists in skills/ and still matches that category's patterns.`
      );
    }
    return skill;
  }).filter(Boolean);
  const bestFitFolders = new Set(bestFitSkills.map((skill) => skill.folder));
  const supportingSkills = handoffCategory.filter(
    (skill) => !bestFitFolders.has(skill.folder)
  );

  let content = `### 中文分类技能清单

以下按用途对全部 **${skillEntries.length}** 个技能进行分类，技能名称保留仓库中的原始英文目录名，便于直接在 \`skills/\` 目录中定位。

`;

  categories.forEach((category, index) => {
    content += `#### ${index + 1}. ${category.title}（${category.skills.length}）\n\n`;
    content += `${category.description}\n\n`;
    content += `- ${formatSkillLinks(category.skills)}\n\n`;
  });

  const bestFitLinks = formatSkillLinks(bestFitSkills);
  const supportingLinks = formatSkillLinks(supportingSkills);

  content += `### 模型会话内容交接相关技能

- **最推荐**：${bestFitLinks}
  - \`remember\` 负责把阶段性经验沉淀成可复用的记忆指令。
  - \`memory-merger\` 负责把成熟经验并入长期指令文件，适合跨会话延续。
- **辅助交接**：${supportingLinks}
  - \`context-map\` 适合先输出任务相关文件地图，便于下一个模型快速接手。
  - \`what-context-needed\` 适合先确认下一个模型还缺哪些上下文。
  - \`meeting-minutes\` 和 \`copilot-spaces\` 更适合沉淀为可读摘要或共享知识库。
  - \`first-ask\` 适合在新会话一开始先澄清需求、补齐背景。

**结论**：仓库里已经有适合“模型会话内容交接”的技能，但它们更偏向于通过**结构化、可持久化的产物**来交接上下文，例如 memory instructions、instruction files、任务上下文图和会议纪要；目前没有专门用于完整传递原始聊天记录的单一技能。
`;

  return content;
}

function makeBadges(link, type) {
  const aka = AKA_INSTALL_URLS[type] || AKA_INSTALL_URLS.instructions;

  const vscodeUrl = `${aka}?url=${encodeURIComponent(
    `vscode:chat-${type}/install?url=${repoBaseUrl}/${link}`
  )}`;
  const insidersUrl = `${aka}?url=${encodeURIComponent(
    `vscode-insiders:chat-${type}/install?url=${repoBaseUrl}/${link}`
  )}`;

  return `[![Install in VS Code](${vscodeInstallImage})](${vscodeUrl})<br />[![Install in VS Code Insiders](${vscodeInsidersInstallImage})](${insidersUrl})`;
}

/**
 * Generate the instructions section with a table of all instructions
 */
function generateInstructionsSection(instructionsDir) {
  // Check if directory exists
  if (!fs.existsSync(instructionsDir)) {
    return "";
  }

  // Get all instruction files
  const instructionFiles = fs
    .readdirSync(instructionsDir)
    .filter((file) => file.endsWith(".instructions.md"));

  // Map instruction files to objects with title for sorting
  const instructionEntries = instructionFiles.map((file) => {
    const filePath = path.join(instructionsDir, file);
    const title = extractTitle(filePath);
    return { file, filePath, title };
  });

  // Sort by title alphabetically
  instructionEntries.sort((a, b) => a.title.localeCompare(b.title));

  console.log(`Found ${instructionEntries.length} instruction files`);

  // Return empty string if no files found
  if (instructionEntries.length === 0) {
    return "";
  }

  // Create table header
  let instructionsContent =
    "| Title | Description |\n| ----- | ----------- |\n";

  // Generate table rows for each instruction file
  for (const entry of instructionEntries) {
    const { file, filePath, title } = entry;
    const link = encodeURI(`instructions/${file}`);

    // Check if there's a description in the frontmatter
    const customDescription = extractDescription(filePath);

    // Create badges for installation links
    const badges = makeBadges(link, "instructions");

    if (customDescription && customDescription !== "null") {
      // Use the description from frontmatter, table-safe
      instructionsContent += `| [${title}](../${link})<br />${badges} | ${formatTableCell(
        customDescription
      )} |\n`;
    } else {
      // Fallback to the default approach - use last word of title for description, removing trailing 's' if present
      const topic = title.split(" ").pop().replace(/s$/, "");
      instructionsContent += `| [${title}](../${link})<br />${badges} | ${topic} specific coding standards and best practices |\n`;
    }
  }

  return `${TEMPLATES.instructionsSection}\n${TEMPLATES.instructionsUsage}\n\n${instructionsContent}`;
}

/**
 * Generate MCP server links for an agent
 * @param {string[]} servers - Array of MCP server names
 * @param {{ name: string, displayName: string }[]} registryNames - Pre-loaded registry names to avoid async calls
 * @returns {string} - Formatted MCP server links with badges
 */
function generateMcpServerLinks(servers, registryNames) {
  if (!servers || servers.length === 0) {
    return "";
  }

  const badges = [
    {
      type: "vscode",
      url: "https://img.shields.io/badge/Install-VS_Code-0098FF?style=flat-square",
      badgeUrl: (serverName) =>
        `https://aka.ms/awesome-copilot/install/mcp-vscode?vscode:mcp/by-name/${serverName}/mcp-server`,
    },
    {
      type: "insiders",
      url: "https://img.shields.io/badge/Install-VS_Code_Insiders-24bfa5?style=flat-square",
      badgeUrl: (serverName) =>
        `https://aka.ms/awesome-copilot/install/mcp-vscode?vscode-insiders:mcp/by-name/${serverName}/mcp-server`,
    },
    {
      type: "visualstudio",
      url: "https://img.shields.io/badge/Install-Visual_Studio-C16FDE?style=flat-square",
      badgeUrl: (serverName) =>
        `https://aka.ms/awesome-copilot/install/mcp-visualstudio?vscode:mcp/by-name/${serverName}/mcp-server`,
    },
  ];

  return servers
    .map((entry) => {
      // Support either a string name or an object with config
      const serverObj = typeof entry === "string" ? { name: entry } : entry;
      const serverName = String(serverObj.name).trim();

      // Build config-only JSON (no name/type for stdio; just command+args+env)
      let configPayload = {};
      if (serverObj.type && serverObj.type.toLowerCase() === "http") {
        // HTTP: url + headers
        configPayload = {
          url: serverObj.url || "",
          headers: serverObj.headers || {},
        };
      } else {
        // Local/stdio: command + args + env
        configPayload = {
          command: serverObj.command || "",
          args: Array.isArray(serverObj.args)
            ? serverObj.args.map(encodeURIComponent)
            : [],
          env: serverObj.env || {},
        };
      }

      const encodedConfig = encodeURIComponent(JSON.stringify(configPayload));

      const installBadgeUrls = [
        `[![Install MCP](${badges[0].url})](https://aka.ms/awesome-copilot/install/mcp-vscode?name=${serverName}&config=${encodedConfig})`,
        `[![Install MCP](${badges[1].url})](https://aka.ms/awesome-copilot/install/mcp-vscodeinsiders?name=${serverName}&config=${encodedConfig})`,
        `[![Install MCP](${badges[2].url})](https://aka.ms/awesome-copilot/install/mcp-visualstudio/mcp-install?${encodedConfig})`,
      ].join("<br />");

      // Match against both displayName and full name (case-insensitive)
      const serverNameLower = serverName.toLowerCase();
      const registryEntry = registryNames.find((entry) => {
        // Exact match on displayName or fullName
        if (
          entry.displayName === serverNameLower ||
          entry.fullName === serverNameLower
        ) {
          return true;
        }

        // Check if the serverName matches a part of the full name after a slash
        // e.g., "apify" matches "com.apify/apify-mcp-server"
        const nameParts = entry.fullName.split("/");
        if (nameParts.length > 1 && nameParts[1]) {
          // Check if it matches the second part (after the slash)
          const secondPart = nameParts[1]
            .replace("-mcp-server", "")
            .replace("-mcp", "");
          if (secondPart === serverNameLower) {
            return true;
          }
        }

        // Check if serverName matches the displayName ignoring case
        return entry.displayName === serverNameLower;
      });
      const serverLabel = registryEntry
        ? `[${serverName}](${`https://github.com/mcp/${registryEntry.name}`})`
        : serverName;
      return `${serverLabel}<br />${installBadgeUrls}`;
    })
    .join("<br />");
}

/**
 * Generate the agents section with a table of all agents
 * @param {string} agentsDir - Directory path
 * @param {{ name: string, displayName: string }[]} registryNames - Pre-loaded MCP registry names
 */
function generateAgentsSection(agentsDir, registryNames = []) {
  return generateUnifiedModeSection({
    dir: agentsDir,
    extension: ".agent.md",
    linkPrefix: "agents",
    badgeType: "agent",
    includeMcpServers: true,
    sectionTemplate: TEMPLATES.agentsSection,
    usageTemplate: TEMPLATES.agentsUsage,
    registryNames,
  });
}

/**
 * Generate the hooks section with a table of all hooks
 */
function generateHooksSection(hooksDir) {
  if (!fs.existsSync(hooksDir)) {
    console.log(`Hooks directory does not exist: ${hooksDir}`);
    return "";
  }

  // Get all hook folders (directories)
  const hookFolders = fs.readdirSync(hooksDir).filter((file) => {
    const filePath = path.join(hooksDir, file);
    return fs.statSync(filePath).isDirectory();
  });

  // Parse each hook folder
  const hookEntries = hookFolders
    .map((folder) => {
      const hookPath = path.join(hooksDir, folder);
      const metadata = parseHookMetadata(hookPath);
      if (!metadata) return null;

      return {
        folder,
        name: metadata.name,
        description: metadata.description,
        hooks: metadata.hooks,
        tags: metadata.tags,
        assets: metadata.assets,
      };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`Found ${hookEntries.length} hook(s)`);

  if (hookEntries.length === 0) {
    return "";
  }

  // Create table header
  let content =
    "| Name | Description | Events | Bundled Assets |\n| ---- | ----------- | ------ | -------------- |\n";

  // Generate table rows for each hook
  for (const hook of hookEntries) {
    const link = `../hooks/${hook.folder}/README.md`;
    const events = hook.hooks.length > 0 ? hook.hooks.join(", ") : "N/A";
    const assetsList =
      hook.assets.length > 0
        ? hook.assets.map((a) => `\`${a}\``).join("<br />")
        : "None";

    content += `| [${hook.name}](${link}) | ${formatTableCell(
      hook.description
    )} | ${events} | ${assetsList} |\n`;
  }

  return `${TEMPLATES.hooksSection}\n${TEMPLATES.hooksUsage}\n\n${content}`;
}

/**
 * Generate the workflows section with a table of all agentic workflows
 */
function generateWorkflowsSection(workflowsDir) {
  if (!fs.existsSync(workflowsDir)) {
    console.log(`Workflows directory does not exist: ${workflowsDir}`);
    return "";
  }

  // Get all .md workflow files (flat, no subfolders)
  const workflowFiles = fs.readdirSync(workflowsDir).filter((file) => {
    return file.endsWith(".md") && file !== ".gitkeep";
  });

  // Parse each workflow file
  const workflowEntries = workflowFiles
    .map((file) => {
      const filePath = path.join(workflowsDir, file);
      const metadata = parseWorkflowMetadata(filePath);
      if (!metadata) return null;

      return {
        file,
        name: metadata.name,
        description: metadata.description,
        triggers: metadata.triggers,
        tags: metadata.tags,
      };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`Found ${workflowEntries.length} workflow(s)`);

  if (workflowEntries.length === 0) {
    return "";
  }

  // Create table header
  let content =
    "| Name | Description | Triggers |\n| ---- | ----------- | -------- |\n";

  // Generate table rows for each workflow
  for (const workflow of workflowEntries) {
    const link = `../workflows/${workflow.file}`;
    const triggers = workflow.triggers.length > 0 ? workflow.triggers.join(", ") : "N/A";

    content += `| [${workflow.name}](${link}) | ${formatTableCell(
      workflow.description
    )} | ${triggers} |\n`;
  }

  return `${TEMPLATES.workflowsSection}\n${TEMPLATES.workflowsUsage}\n\n${content}`;
}

/**
 * Generate the skills section with a table of all skills
 */
function generateSkillsSection(skillsDir) {
  if (!fs.existsSync(skillsDir)) {
    console.log(`Skills directory does not exist: ${skillsDir}`);
    return "";
  }

  // Get all skill folders (directories)
  const skillFolders = fs.readdirSync(skillsDir).filter((file) => {
    const filePath = path.join(skillsDir, file);
    return fs.statSync(filePath).isDirectory();
  });

  // Parse each skill folder
  const skillEntries = skillFolders
    .map((folder) => {
      const skillPath = path.join(skillsDir, folder);
      const metadata = parseSkillMetadata(skillPath);
      if (!metadata) return null;

      return {
        folder,
        name: metadata.name,
        description: metadata.description,
        assets: metadata.assets,
      };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`Found ${skillEntries.length} skill(s)`);

  if (skillEntries.length === 0) {
    return "";
  }

  // Create table header
  let content =
    "| Name | Description | Bundled Assets |\n| ---- | ----------- | -------------- |\n";

  // Generate table rows for each skill
  for (const skill of skillEntries) {
    const link = `../skills/${skill.folder}/SKILL.md`;
    const assetsList =
      skill.assets.length > 0
        ? skill.assets.map((a) => `\`${a}\``).join("<br />")
        : "None";

    content += `| [${skill.name}](${link}) | ${formatTableCell(
      skill.description
    )} | ${assetsList} |\n`;
  }

  const chineseCatalog = generateChineseSkillCatalog(skillEntries);

  return `${TEMPLATES.skillsSection}\n${TEMPLATES.skillsUsage}\n\n${chineseCatalog}\n${content}`;
}

/**
 * Unified generator for agents (future consolidation)
 * @param {Object} cfg
 * @param {string} cfg.dir - Directory path
 * @param {string} cfg.extension - File extension to match (e.g. .agent.md, .agent.md)
 * @param {string} cfg.linkPrefix - Link prefix folder name
 * @param {string} cfg.badgeType - Badge key (mode, agent)
 * @param {boolean} cfg.includeMcpServers - Whether to include MCP server column
 * @param {string} cfg.sectionTemplate - Section heading template
 * @param {string} cfg.usageTemplate - Usage subheading template
 * @param {{ name: string, displayName: string }[]} cfg.registryNames - Pre-loaded MCP registry names
 */
function generateUnifiedModeSection(cfg) {
  const {
    dir,
    extension,
    linkPrefix,
    badgeType,
    includeMcpServers,
    sectionTemplate,
    usageTemplate,
    registryNames = [],
  } = cfg;

  if (!fs.existsSync(dir)) {
    console.log(`Directory missing for unified mode section: ${dir}`);
    return "";
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(extension));

  const entries = files.map((file) => {
    const filePath = path.join(dir, file);
    return { file, filePath, title: extractTitle(filePath) };
  });

  entries.sort((a, b) => a.title.localeCompare(b.title));
  console.log(
    `Unified mode generator: ${entries.length} files for extension ${extension}`
  );
  if (entries.length === 0) return "";

  let header = "| Title | Description |";
  if (includeMcpServers) header += " MCP Servers |";
  let separator = "| ----- | ----------- |";
  if (includeMcpServers) separator += " ----------- |";

  let content = `${header}\n${separator}\n`;

  for (const { file, filePath, title } of entries) {
    const link = encodeURI(`${linkPrefix}/${file}`);
    const description = extractDescription(filePath);
    const badges = makeBadges(link, badgeType);
    let mcpServerCell = "";
    if (includeMcpServers) {
      const servers = extractMcpServerConfigs(filePath);
      mcpServerCell = generateMcpServerLinks(servers, registryNames);
    }

    const descCell =
      description && description !== "null" ? formatTableCell(description) : "";
    if (includeMcpServers) {
      content += `| [${title}](../${link})<br />${badges} | ${descCell} | ${mcpServerCell} |\n`;
    } else {
      content += `| [${title}](../${link})<br />${badges} | ${descCell} |\n`;
    }
  }

  return `${sectionTemplate}\n${usageTemplate}\n\n${content}`;
}

/**
 * Read and parse a plugin.json file from a plugin directory.
 */
function readPluginJson(pluginDir) {
  const jsonPath = path.join(pluginDir, ".github/plugin", "plugin.json");
  if (!fs.existsSync(jsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Generate the plugins section with a table of all plugins
 */
function generatePluginsSection(pluginsDir) {
  // Check if plugins directory exists, create it if it doesn't
  if (!fs.existsSync(pluginsDir)) {
    console.log("Plugins directory does not exist, creating it...");
    fs.mkdirSync(pluginsDir, { recursive: true });
  }

  // Get all plugin directories
  const pluginDirs = fs
    .readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Map plugin dirs to objects with name for sorting
  const pluginEntries = pluginDirs
    .map((dir) => {
      const pluginDir = path.join(pluginsDir, dir);
      const plugin = readPluginJson(pluginDir);

      if (!plugin) {
        console.warn(`Failed to parse plugin: ${dir}`);
        return null;
      }

      const pluginId = plugin.name || dir;
      const name = plugin.name || dir;
      const isFeatured = plugin.featured === true;
      return { dir, pluginDir, plugin, pluginId, name, isFeatured };
    })
    .filter((entry) => entry !== null);

  // Separate featured and regular plugins
  const featuredPlugins = pluginEntries.filter((entry) => entry.isFeatured);
  const regularPlugins = pluginEntries.filter((entry) => !entry.isFeatured);

  // Sort each group alphabetically by name
  featuredPlugins.sort((a, b) => a.name.localeCompare(b.name));
  regularPlugins.sort((a, b) => a.name.localeCompare(b.name));

  // Combine: featured first, then regular
  const sortedEntries = [...featuredPlugins, ...regularPlugins];

  console.log(
    `Found ${pluginEntries.length} plugins (${featuredPlugins.length} featured)`
  );

  // If no plugins, return empty string
  if (sortedEntries.length === 0) {
    return "";
  }

  // Create table header
  let pluginsContent =
    "| Name | Description | Items | Tags |\n| ---- | ----------- | ----- | ---- |\n";

  // Generate table rows for each plugin
  for (const entry of sortedEntries) {
    const { plugin, dir, name, isFeatured } = entry;
    const description = formatTableCell(
      plugin.description || "No description"
    );
    const itemCount = (plugin.agents || []).length + (plugin.commands || []).length + (plugin.skills || []).length;
    const keywords = plugin.keywords ? plugin.keywords.join(", ") : "";

    const link = `../plugins/${dir}/README.md`;
    const displayName = isFeatured ? `⭐ ${name}` : name;

    pluginsContent += `| [${displayName}](${link}) | ${description} | ${itemCount} items | ${keywords} |\n`;
  }

  return `${TEMPLATES.pluginsSection}\n${TEMPLATES.pluginsUsage}\n\n${pluginsContent}`;
}

/**
 * Generate the featured plugins section for the main README
 */
function generateFeaturedPluginsSection(pluginsDir) {
  // Check if plugins directory exists
  if (!fs.existsSync(pluginsDir)) {
    return "";
  }

  // Get all plugin directories
  const pluginDirs = fs
    .readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Map plugin dirs to objects, filter for featured
  const featuredPlugins = pluginDirs
    .map((dir) => {
      const pluginDir = path.join(pluginsDir, dir);
      return safeFileOperation(
        () => {
          const plugin = readPluginJson(pluginDir);
          if (!plugin) return null;

          // Only include plugins with featured: true
          if (!plugin.featured) return null;

          const name = plugin.name || dir;
          const description = formatTableCell(
            plugin.description || "No description"
          );
          const keywords = plugin.keywords ? plugin.keywords.join(", ") : "";
          const itemCount = (plugin.agents || []).length + (plugin.commands || []).length + (plugin.skills || []).length;

          return {
            dir,
            plugin,
            pluginId: name,
            name,
            description,
            keywords,
            itemCount,
          };
        },
        pluginDir,
        null
      );
    })
    .filter((entry) => entry !== null);

  // Sort by name alphabetically
  featuredPlugins.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`Found ${featuredPlugins.length} featured plugin(s)`);

  // If no featured plugins, return empty string
  if (featuredPlugins.length === 0) {
    return "";
  }

  // Create table header
  let featuredContent =
    "| Name | Description | Items | Tags |\n| ---- | ----------- | ----- | ---- |\n";

  // Generate table rows for each featured plugin
  for (const entry of featuredPlugins) {
    const { dir, name, description, keywords, itemCount } = entry;
    const readmeLink = `plugins/${dir}/README.md`;

    featuredContent += `| [${name}](${readmeLink}) | ${description} | ${itemCount} items | ${keywords} |\n`;
  }

  return `${TEMPLATES.featuredPluginsSection}\n\n${featuredContent}`;
}

// Utility: write file only if content changed
function writeFileIfChanged(filePath, content) {
  const exists = fs.existsSync(filePath);
  if (exists) {
    const original = fs.readFileSync(filePath, "utf8");
    if (original === content) {
      console.log(
        `${path.basename(filePath)} is already up to date. No changes needed.`
      );
      return;
    }
  }
  fs.writeFileSync(filePath, content);
  console.log(
    `${path.basename(filePath)} ${exists ? "updated" : "created"} successfully!`
  );
}

// Build per-category README content using existing generators, upgrading headings to H1
function buildCategoryReadme(
  sectionBuilder,
  dirPath,
  headerLine,
  usageLine,
  registryNames = []
) {
  const section = sectionBuilder(dirPath, registryNames);
  if (section && section.trim()) {
    // Upgrade the first markdown heading level from ## to # for standalone README files
    return section.replace(/^##\s/m, "# ");
  }
  // Fallback content when no entries are found
  return `${headerLine}\n\n${usageLine}\n\n_No entries found yet._`;
}

// Main execution wrapped in async function
async function main() {
  try {
    console.log("Generating category README files...");

    // Load MCP registry names once at the beginning
    const registryNames = await loadMcpRegistryNames();

    // Compose headers for standalone files by converting section headers to H1
    const instructionsHeader = TEMPLATES.instructionsSection.replace(
      /^##\s/m,
      "# "
    );
    const agentsHeader = TEMPLATES.agentsSection.replace(/^##\s/m, "# ");
    const hooksHeader = TEMPLATES.hooksSection.replace(/^##\s/m, "# ");
    const workflowsHeader = TEMPLATES.workflowsSection.replace(/^##\s/m, "# ");
    const skillsHeader = TEMPLATES.skillsSection.replace(/^##\s/m, "# ");
    const pluginsHeader = TEMPLATES.pluginsSection.replace(
      /^##\s/m,
      "# "
    );

    const instructionsReadme = buildCategoryReadme(
      generateInstructionsSection,
      INSTRUCTIONS_DIR,
      instructionsHeader,
      TEMPLATES.instructionsUsage,
      registryNames
    );
    // Generate agents README
    const agentsReadme = buildCategoryReadme(
      generateAgentsSection,
      AGENTS_DIR,
      agentsHeader,
      TEMPLATES.agentsUsage,
      registryNames
    );

    // Generate hooks README
    const hooksReadme = buildCategoryReadme(
      generateHooksSection,
      HOOKS_DIR,
      hooksHeader,
      TEMPLATES.hooksUsage,
      registryNames
    );

    // Generate workflows README
    const workflowsReadme = buildCategoryReadme(
      generateWorkflowsSection,
      WORKFLOWS_DIR,
      workflowsHeader,
      TEMPLATES.workflowsUsage,
      registryNames
    );

    // Generate skills README
    const skillsReadme = buildCategoryReadme(
      generateSkillsSection,
      SKILLS_DIR,
      skillsHeader,
      TEMPLATES.skillsUsage,
      registryNames
    );

    // Generate plugins README
    const pluginsReadme = buildCategoryReadme(
      generatePluginsSection,
      PLUGINS_DIR,
      pluginsHeader,
      TEMPLATES.pluginsUsage,
      registryNames
    );

    // Ensure docs directory exists for category outputs
    if (!fs.existsSync(DOCS_DIR)) {
      fs.mkdirSync(DOCS_DIR, { recursive: true });
    }

    // Write category outputs into docs folder
    writeFileIfChanged(
      path.join(DOCS_DIR, "README.instructions.md"),
      instructionsReadme
    );
    writeFileIfChanged(path.join(DOCS_DIR, "README.agents.md"), agentsReadme);
    writeFileIfChanged(path.join(DOCS_DIR, "README.hooks.md"), hooksReadme);
    writeFileIfChanged(path.join(DOCS_DIR, "README.workflows.md"), workflowsReadme);
    writeFileIfChanged(path.join(DOCS_DIR, "README.skills.md"), skillsReadme);
    writeFileIfChanged(
      path.join(DOCS_DIR, "README.plugins.md"),
      pluginsReadme
    );

    // Plugin READMEs are authoritative (already exist in each plugin folder)

    // Generate featured plugins section and update main README.md
    console.log("Updating main README.md with featured plugins...");
    const featuredSection = generateFeaturedPluginsSection(PLUGINS_DIR);

    if (featuredSection) {
      const mainReadmePath = path.join(ROOT_FOLDER, "README.md");

      if (fs.existsSync(mainReadmePath)) {
        let readmeContent = fs.readFileSync(mainReadmePath, "utf8");

        // Define markers to identify where to insert the featured plugins
        const startMarker = "## 🌟 Featured Plugins";
        const endMarker = "## MCP Server";

        // Check if the section already exists
        const startIndex = readmeContent.indexOf(startMarker);

        if (startIndex !== -1) {
          // Section exists, replace it
          const endIndex = readmeContent.indexOf(endMarker, startIndex);
          if (endIndex !== -1) {
            // Replace the existing section
            const beforeSection = readmeContent.substring(0, startIndex);
            const afterSection = readmeContent.substring(endIndex);
            readmeContent =
              beforeSection + featuredSection + "\n\n" + afterSection;
          }
        } else {
          // Section doesn't exist, insert it before "## MCP Server"
          const mcpIndex = readmeContent.indexOf(endMarker);
          if (mcpIndex !== -1) {
            const beforeMcp = readmeContent.substring(0, mcpIndex);
            const afterMcp = readmeContent.substring(mcpIndex);
            readmeContent = beforeMcp + featuredSection + "\n\n" + afterMcp;
          }
        }

        writeFileIfChanged(mainReadmePath, readmeContent);
        console.log("Main README.md updated with featured plugins");
      } else {
        console.warn(
          "README.md not found, skipping featured plugins update"
        );
      }
    } else {
      console.log("No featured plugins found to add to README.md");
    }
  } catch (error) {
    console.error(`Error generating category README files: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the main function
main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
