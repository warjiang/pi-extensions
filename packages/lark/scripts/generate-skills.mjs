import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const packageJsonPath = join(root, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const cliVersion = packageJson.dependencies["@larksuite/cli"];
const cliRunner = require.resolve("@larksuite/cli/scripts/run.js");
const snapshotPath = join(root, "snapshots", `skills-${cliVersion}.json`);
const permissionsPath = join(root, "snapshots", `permissions-${cliVersion}.json`);
const skillsDir = join(root, "skills");

function runCli(...args) {
  return execFileSync(process.execPath, [cliRunner, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function liveSkills() {
  const payload = JSON.parse(runCli("skills", "list"));
  if (!payload.ok || !Array.isArray(payload.skills)) {
    throw new Error("lark-cli skills list returned an unexpected response");
  }
  return payload.skills
    .map(({ name, description }) => ({ name, description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function permissionHash() {
  return createHash("sha256").update(readFileSync(permissionsPath)).digest("hex");
}

function proxySkill({ name, description }) {
  // Codex skill frontmatter rejects angle brackets. Preserve placeholder meaning
  // while keeping the exact upstream description in the synchronization snapshot.
  const safeDescription = description.replaceAll("<", "{").replaceAll(">", "}");
  const title = name
    .replace(/^lark-/, "")
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
  return `---
name: ${name}
description: ${JSON.stringify(safeDescription)}
---

# Lark ${title}

Use the \`lark\` tool for this domain.

Before the first operation, call it with \`args: ["skills", "read", "${name}"]\`.
Read an upstream reference with \`args: ["skills", "read", "${name}", "<relative-path>"]\`.

Follow the upstream identity guidance and set \`identity\` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
`;
}

function expectedSnapshot(skills) {
  return {
    cliVersion,
    permissionSnapshotSha256: permissionHash(),
    skills,
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const mode = process.argv[2] ?? "--check";
if (!["--check", "--write", "--update-snapshot"].includes(mode)) {
  throw new Error(`unknown mode: ${mode}`);
}

const versionOutput = runCli("--version").trim();
if (versionOutput !== `lark-cli version ${cliVersion}`) {
  throw new Error(`expected lark-cli ${cliVersion}, got: ${versionOutput}`);
}

const currentSkills = liveSkills();
if (currentSkills.length !== 27) {
  throw new Error(`expected 27 upstream skills for ${cliVersion}, got ${currentSkills.length}`);
}

if (mode === "--update-snapshot") {
  writeFileSync(snapshotPath, stableJson(expectedSnapshot(currentSkills)));
}

if (!existsSync(snapshotPath)) {
  throw new Error(`missing ${snapshotPath}; run pnpm update:snapshots`);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const expected = expectedSnapshot(currentSkills);
if (stableJson(snapshot) !== stableJson(expected)) {
  fail("lark-cli skill metadata or permission snapshot drifted; run pnpm update:snapshots and review the diff");
}

if (mode === "--write" || mode === "--update-snapshot") {
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of snapshot.skills) {
    const directory = join(skillsDir, skill.name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), proxySkill(skill));
  }
}

if (mode === "--check") {
  const actualDirectories = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    : [];
  const expectedDirectories = snapshot.skills.map((skill) => skill.name).sort();
  if (stableJson(actualDirectories) !== stableJson(expectedDirectories)) {
    fail("generated skill directory list is stale; run pnpm generate:skills");
  }
  for (const skill of snapshot.skills) {
    const path = join(skillsDir, skill.name, "SKILL.md");
    if (!existsSync(path) || readFileSync(path, "utf8") !== proxySkill(skill)) {
      fail(`${skill.name}/SKILL.md is stale; run pnpm generate:skills`);
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`${mode.slice(2)}: ${currentSkills.length} skills match lark-cli ${cliVersion}`);
