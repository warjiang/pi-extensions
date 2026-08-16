import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("all 27 proxy skills are discoverable and contain only allowed frontmatter fields", () => {
  const snapshot = JSON.parse(
    readFileSync(join(root, "snapshots", "skills-1.0.87.json"), "utf8"),
  ) as { skills: { name: string; description: string }[] };
  const directories = readdirSync(join(root, "skills")).sort();
  assert.equal(snapshot.skills.length, 27);
  assert.deepEqual(directories, snapshot.skills.map(({ name }) => name).sort());

  for (const skill of snapshot.skills) {
    const markdown = readFileSync(join(root, "skills", skill.name, "SKILL.md"), "utf8");
    const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    assert.match(frontmatter, new RegExp(`^name: ${skill.name}$`, "m"));
    assert.match(frontmatter, /^description: /m);
    assert.equal(frontmatter.split("\n").length, 2);
    assert.match(markdown, new RegExp(`skills", "read", "${skill.name}"`));
    assert.match(markdown, /Pi manages authentication/);
  }
});

test("fixed CLI metadata and permission checksum remain synchronized", () => {
  const output = execFileSync(process.execPath, [
    join(root, "scripts", "generate-skills.mjs"),
    "--check",
  ], { encoding: "utf8" });
  assert.match(output, /27 skills match lark-cli 1\.0\.87/);
});
