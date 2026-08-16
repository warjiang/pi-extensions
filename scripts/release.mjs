import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const registry = "https://registry.npmjs.org/";
const packages = {
  lark: "packages/lark",
  "volcengine-ark": "packages/volcengine-ark",
  "volcengine-coding-plan": "packages/volcengine-coding-plan",
  "volcengine-agent-plan": "packages/volcengine-agent-plan",
};
const bumps = new Set([
  "patch",
  "minor",
  "major",
  "prepatch",
  "preminor",
  "premajor",
  "prerelease",
]);

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }
    const key = value.slice(2);
    if (key === "dry-run" || key === "provenance") {
      parsed[key] = true;
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) fail(`--${key} requires a value`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function selectedPackages(selection = "all") {
  if (selection === "all") return Object.entries(packages);
  const directory = packages[selection];
  if (!directory) fail(`unknown package "${selection}"`);
  return [[selection, directory]];
}

function manifest(directory) {
  return JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (options.allowFailure) return result;
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
  return result;
}

function bumpPackages(selection, bump, preid) {
  if (!bumps.has(bump)) fail(`unsupported bump "${bump}"`);
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(preid)) fail(`invalid prerelease id "${preid}"`);
  for (const [, directory] of selectedPackages(selection)) {
    const args = ["version", bump, "--no-git-tag-version", "--ignore-scripts"];
    if (bump.startsWith("pre")) args.push("--preid", preid);
    run("npm", args, { cwd: join(root, directory) });
    const current = manifest(directory);
    console.log(`${current.name} -> ${current.version}`);
  }
}

function packageExists(name, version) {
  const result = run(
    "npm",
    ["view", `${name}@${version}`, "version", "--json", "--registry", registry],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0) return false;
  try {
    return JSON.parse(result.stdout) === version;
  } catch {
    return result.stdout.trim().replaceAll('"', "") === version;
  }
}

function publishPackages(selection, tag, dryRun, provenance) {
  if (!/^[a-z][a-z0-9._-]*$/i.test(tag)) fail(`invalid npm dist-tag "${tag}"`);
  for (const [, directory] of selectedPackages(selection)) {
    const current = manifest(directory);
    if (current.private) fail(`${current.name} is private`);
    if (dryRun) {
      run("npm", ["pack", "--dry-run"], { cwd: join(root, directory) });
      continue;
    }
    if (packageExists(current.name, current.version)) {
      console.log(`${current.name}@${current.version} already exists; skipping`);
      continue;
    }
    const args = [
      "publish",
      "--access",
      "public",
      "--tag",
      tag,
      "--registry",
      registry,
    ];
    if (provenance) args.push("--provenance");
    run("npm", args, { cwd: join(root, directory) });
  }
}

function createTags(selection) {
  for (const [, directory] of selectedPackages(selection)) {
    const current = manifest(directory);
    const tag = `${current.name}@${current.version}`;
    const existing = run(
      "git",
      ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`],
      { capture: true, allowFailure: true },
    );
    if (existing.status === 0) {
      console.log(`${tag} already exists; skipping`);
      continue;
    }
    run("git", ["tag", "-a", tag, "-m", tag]);
  }
}

function printVersions(selection) {
  for (const [, directory] of selectedPackages(selection)) {
    const current = manifest(directory);
    console.log(`${current.name}@${current.version}`);
  }
}

function verifyBumps() {
  const expected = {
    patch: "1.2.4",
    minor: "1.3.0",
    major: "2.0.0",
    prepatch: "1.2.4-beta.0",
    preminor: "1.3.0-beta.0",
    premajor: "2.0.0-beta.0",
    prerelease: "1.2.4-beta.0",
  };
  const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-extensions-release-"));
  try {
    const source = join(root, "packages/volcengine-ark/package.json");
    for (const [bump, version] of Object.entries(expected)) {
      const directory = join(temporaryRoot, bump);
      cpSync(source, join(directory, "package.json"), { recursive: true });
      const packageFile = join(directory, "package.json");
      const current = JSON.parse(readFileSync(packageFile, "utf8"));
      current.version = "1.2.3";
      writeFileSync(packageFile, `${JSON.stringify(current, null, 2)}\n`);
      const args = ["version", bump, "--no-git-tag-version", "--ignore-scripts"];
      if (bump.startsWith("pre")) args.push("--preid", "beta");
      run("npm", args, { cwd: directory });
      const updated = JSON.parse(readFileSync(packageFile, "utf8"));
      assert.equal(updated.version, version, `${bump} should produce ${version}`);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  console.log("All npm version bump modes passed.");
}

const args = parseArgs(process.argv.slice(2));
const [command] = args._;
switch (command) {
  case "bump":
    bumpPackages(args.package, args.bump ?? "patch", args.preid ?? "beta");
    break;
  case "publish":
    publishPackages(args.package, args.tag ?? "latest", Boolean(args["dry-run"]), Boolean(args.provenance));
    break;
  case "tags":
    createTags(args.package);
    break;
  case "versions":
    printVersions(args.package);
    break;
  case "verify-bump":
    verifyBumps();
    break;
  default:
    fail("use bump, publish, tags, versions, or verify-bump");
}
