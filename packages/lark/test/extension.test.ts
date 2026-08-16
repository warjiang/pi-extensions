import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import larkExtension from "../extensions/index.ts";

test("extension registers two credential-only providers and the lark tool", () => {
  const providers: unknown[] = [];
  const tools: unknown[] = [];
  larkExtension({
    registerProvider(provider: unknown) {
      providers.push(provider);
    },
    registerTool(tool: unknown) {
      tools.push(tool);
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
});
