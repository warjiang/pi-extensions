import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizedEnvironment,
  spawnLarkCli,
  validateArgs,
} from "../extensions/runner.ts";

test("runner blocks credential management and identity override arguments", () => {
  for (const args of [
    ["auth", "login"],
    ["config"],
    ["profile", "switch"],
    ["docs", "get", "--as=user"],
    ["docs", "get", "--app-secret", "secret"],
    ["docs", "get", "--user-access-token=uat"],
  ]) {
    assert.throws(() => validateArgs(args), /禁止|identity/);
  }
  assert.doesNotThrow(() => validateArgs(["docs", "get", "--document-id", "x; touch /tmp/no"]));
});

test("runner scrubs inherited Lark credentials and injects only the selected identity", () => {
  const bot = sanitizedEnvironment({
    PATH: "/bin",
    LARKSUITE_CLI_APP_SECRET: "must-not-leak",
    LARKSUITE_CLI_USER_ACCESS_TOKEN: "old-uat",
    LARKSUITE_CLI_UNRECOGNIZED_SECRET: "old",
  }, {
    appId: "cli_test",
    token: "tat",
    brand: "feishu",
    identity: "bot",
  });
  assert.equal(bot.PATH, "/bin");
  assert.equal(bot.LARKSUITE_CLI_APP_ID, "cli_test");
  assert.equal(bot.LARKSUITE_CLI_TENANT_ACCESS_TOKEN, "tat");
  assert.equal(bot.LARKSUITE_CLI_USER_ACCESS_TOKEN, undefined);
  assert.equal(bot.LARKSUITE_CLI_APP_SECRET, undefined);
  assert.equal(bot.LARKSUITE_CLI_UNRECOGNIZED_SECRET, undefined);
  assert.equal(bot.LARKSUITE_CLI_STRICT_MODE, "bot");
});

test("spawn passes argv literally and supports stdin", async () => {
  const result = await spawnLarkCli(process.execPath, [
    "-e",
    "process.stdin.setEncoding('utf8');let x='';process.stdin.on('data',c=>x+=c);process.stdin.on('end',()=>console.log(JSON.stringify({arg:process.argv[1],stdin:x})))",
    "literal; echo injected",
  ], {
    timeoutMs: 5_000,
    stdin: "hello",
    env: process.env,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    arg: "literal; echo injected",
    stdin: "hello",
  });
});

test("spawn reports timeout and truncates oversized output", async () => {
  const timedOut = await spawnLarkCli(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeoutMs: 20,
    env: process.env,
  });
  assert.equal(timedOut.timedOut, true);
  assert.notEqual(timedOut.signal, null);

  const oversized = await spawnLarkCli(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(1100000))",
  ], {
    timeoutMs: 5_000,
    env: process.env,
  });
  assert.equal(oversized.truncated, true);
  assert.match(oversized.stdout, /output truncated by Pi/);
});

test("spawn honors an already-aborted invocation signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await spawnLarkCli(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeoutMs: 5_000,
    env: process.env,
    signal: controller.signal,
  });
  assert.notEqual(result.signal, null);
  assert.equal(result.timedOut, false);
});
