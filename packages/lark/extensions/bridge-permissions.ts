import {
  APPLICATION_SELF_MANAGE_SCOPE,
  type AppScopeInfo,
} from "./lark-api.ts";

export const BRIDGE_PERMISSION_VERSION = 3;

export const BRIDGE_TENANT_SCOPES = [
  APPLICATION_SELF_MANAGE_SCOPE,
  "cardkit:card:write",
  "im:chat:read",
  "im:message.group_at_msg:readonly",
  "im:message.p2p_msg:readonly",
  "im:message.reactions:read",
  "im:message.reactions:write_only",
  "im:message:readonly",
  "im:message:send_as_bot",
  "im:resource",
] as const;

export const BRIDGE_OPEN_GROUP_SCOPE = "im:message.group_msg";

export const BRIDGE_EVENTS = [
  "im.chat.member.bot.added_v1",
  "im.message.reaction.created_v1",
  "im.message.reaction.deleted_v1",
  "im.message.receive_v1",
] as const;

export const BRIDGE_CALLBACKS = ["card.action.trigger"] as const;

export interface BridgePermissionDiff {
  tenantScopes: string[];
  events: string[];
  callbacks: string[];
  websocketEvents: boolean;
  websocketCallbacks: boolean;
  botCapability: boolean;
}

export function bridgeTenantScopes(groupPolicy: "mention" | "open"): string[] {
  return groupPolicy === "open"
    ? [...BRIDGE_TENANT_SCOPES, BRIDGE_OPEN_GROUP_SCOPE]
    : [...BRIDGE_TENANT_SCOPES];
}

function missing(expected: readonly string[], actual: readonly string[]): string[] {
  const available = new Set(actual);
  return expected.filter((item) => !available.has(item));
}

export function diffBridgePermissions(
  actual: AppScopeInfo,
  groupPolicy: "mention" | "open",
): BridgePermissionDiff {
  return {
    tenantScopes: missing(bridgeTenantScopes(groupPolicy), actual.tenant),
    events: missing(BRIDGE_EVENTS, actual.events ?? []),
    callbacks: missing(BRIDGE_CALLBACKS, actual.callbacks ?? []),
    websocketEvents: actual.subscriptionType === "websocket",
    websocketCallbacks: actual.callbackType === "websocket",
    botCapability: actual.botCapability === true,
  };
}

export function hasBridgePermissionDiff(diff: BridgePermissionDiff): boolean {
  return diff.tenantScopes.length > 0 ||
    diff.events.length > 0 ||
    diff.callbacks.length > 0 ||
    !diff.websocketEvents ||
    !diff.websocketCallbacks ||
    !diff.botCapability;
}

export function formatBridgePermissionDiff(diff: BridgePermissionDiff): string {
  const lines = [
    diff.tenantScopes.length ? `缺少 tenant scopes：${diff.tenantScopes.join(", ")}` : "",
    diff.events.length ? `缺少 events：${diff.events.join(", ")}` : "",
    diff.callbacks.length ? `缺少 callbacks：${diff.callbacks.join(", ")}` : "",
    !diff.websocketEvents ? "事件订阅未配置为 WebSocket 长连接" : "",
    !diff.websocketCallbacks ? "回调订阅未配置为 WebSocket 长连接" : "",
    !diff.botCapability ? "未检测到 Bot capability" : "",
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : "Bridge 权限和长连接配置已就绪。";
}

export function bridgeAddons(groupPolicy: "mention" | "open") {
  return {
    preset: false,
    scopes: { tenant: bridgeTenantScopes(groupPolicy) },
    events: { items: { tenant: [...BRIDGE_EVENTS] } },
    callbacks: { items: [...BRIDGE_CALLBACKS] },
  };
}

export function bridgeBootstrapAddons() {
  return {
    preset: false,
    scopes: { tenant: [APPLICATION_SELF_MANAGE_SCOPE] },
  };
}
