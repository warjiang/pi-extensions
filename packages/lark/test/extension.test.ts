import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import larkExtension from "../extensions/index.ts";

test("extension registers two credential-only providers and the lark tool", async () => {
  const providers: unknown[] = [];
  const tools: unknown[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const commandHandlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const eventHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  larkExtension({
    registerProvider(provider: unknown) {
      providers.push(provider);
    },
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.push(name);
      commandHandlers.set(name, command.handler);
    },
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      events.push(name);
      eventHandlers.set(name, handler);
    },
  } as unknown as ExtensionAPI);

  assert.equal(providers.length, 2);
  assert.deepEqual(
    providers.map((provider) => (provider as { id: string }).id),
    ["lark-app", "lark-user"],
  );
  assert.ok(providers.every((provider) =>
    (provider as { getModels: () => unknown[] }).getModels().length === 0
  ));
  assert.equal((tools[0] as { name: string }).name, "lark");
  assert.deepEqual(commands, ["lark"]);
  assert.deepEqual(events, ["session_shutdown", "session_start"]);

  const cleared: string[] = [];
  eventHandlers.get("session_shutdown")?.(
    { type: "session_shutdown", reason: "reload" },
    {
      ui: {
        setStatus(key: string, value: unknown) {
          if (key === "lark-bridge-auth" && value === undefined) cleared.push("status");
        },
        setWidget(key: string, value: unknown) {
          if (key === "lark-bridge-auth" && value === undefined) cleared.push("widget");
        },
      },
    },
  );
  assert.deepEqual(cleared, ["status", "widget"]);

  let usedStaleContext = false;
  await commandHandlers.get("lark")?.("status", {
    ui: {
      notify() {
        usedStaleContext = true;
      },
    },
  });
  assert.equal(usedStaleContext, false);
});
