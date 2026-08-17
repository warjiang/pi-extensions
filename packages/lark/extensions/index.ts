import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAppProvider, createUserProvider } from "./providers.ts";
import { runLarkCli } from "./runner.ts";
import { registerBridge } from "./bridge-command.ts";

export default function larkExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createAppProvider());
  pi.registerProvider(createUserProvider());
  registerBridge(pi);
  pi.registerTool({
    name: "lark",
    label: "Lark",
    description: "通过 Pi 管理的应用配置和用户授权安全执行官方 lark-cli。默认使用 bot 身份；用户数据操作显式使用 user。",
    promptSnippet: "Run the official lark-cli with Pi-managed bot or user credentials",
    promptGuidelines: [
      "Use lark for Feishu/Lark operations covered by the installed lark-* skills.",
      "Read the relevant upstream skill with args [\"skills\", \"read\", \"<skill>\"] before a first complex operation.",
      "Never attempt auth, config, update, profile switching, or credential flags; Pi owns credentials.",
    ],
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        minItems: 1,
        description: "不含可执行文件名的 lark-cli 参数数组",
      }),
      identity: Type.Optional(Type.Union([Type.Literal("bot"), Type.Literal("user")], {
        description: "调用身份，默认 bot",
      })),
      stdin: Type.Optional(Type.String({ description: "写入子进程标准输入的内容" })),
      timeoutMs: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 1_800_000,
        description: "超时毫秒数，默认 120000",
      })),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runLarkCli(params, ctx, signal);
      const text = result.stdout.trim() || result.stderr.trim() ||
        `lark-cli exited with code ${result.exitCode ?? "null"}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });
}
