import { accountsBaseUrl, openBaseUrl, type LarkBrand } from "./constants.ts";

interface LarkErrorEnvelope {
  code?: number;
  msg?: string;
  error?: string;
  error_description?: string;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Lark API 返回了非 JSON 响应（HTTP ${response.status}）`);
  }
}

function apiError(operation: string, response: Response, data: LarkErrorEnvelope): Error {
  const message = data.error_description || data.msg || data.error || `HTTP ${response.status}`;
  return new Error(`${operation}失败：${message}`);
}

export interface TenantToken {
  token: string;
  expiresIn: number;
}

export async function exchangeTenantToken(
  appId: string,
  appSecret: string,
  brand: LarkBrand,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<TenantToken> {
  const response = await fetchImpl(
    `${openBaseUrl(brand)}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal,
    },
  );
  const data = await readJson(response) as LarkErrorEnvelope & {
    tenant_access_token?: string;
    expire?: number;
  };
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw apiError("验证 App ID/App Secret", response, data);
  }
  return { token: data.tenant_access_token, expiresIn: data.expire ?? 7200 };
}

export interface AppScopeInfo {
  tenant: string[];
  user: string[];
}

export interface BotInfo {
  appName?: string;
  openId?: string;
}

export async function queryBotInfo(
  token: string,
  brand: LarkBrand,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<BotInfo> {
  const response = await fetchImpl(`${openBaseUrl(brand)}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  const data = await readJson(response) as LarkErrorEnvelope & {
    bot?: { app_name?: string; open_id?: string };
    data?: { bot?: { app_name?: string; open_id?: string } };
  };
  if (!response.ok || data.code !== 0) throw apiError("查询聊天 Bot 状态", response, data);
  const bot = data.bot ?? data.data?.bot;
  return { appName: bot?.app_name, openId: bot?.open_id };
}

export async function queryAppScopes(
  appId: string,
  token: string,
  brand: LarkBrand,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<AppScopeInfo> {
  const response = await fetchImpl(
    `${openBaseUrl(brand)}/open-apis/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
  const data = await readJson(response) as LarkErrorEnvelope & {
    data?: {
      app?: {
        scopes?: { scope?: string; token_types?: string[] }[];
      };
    };
  };
  if (!response.ok || data.code !== 0) throw apiError("查询应用权限", response, data);
  const scopes = data.data?.app?.scopes ?? [];
  return {
    tenant: [...new Set(scopes.filter((item) => item.token_types?.includes("tenant"))
      .map((item) => item.scope).filter((scope): scope is string => Boolean(scope)))].sort(),
    user: [...new Set(scopes.filter((item) => item.token_types?.includes("user"))
      .map((item) => item.scope).filter((scope): scope is string => Boolean(scope)))].sort(),
  };
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export async function requestDeviceAuthorization(
  appId: string,
  appSecret: string,
  brand: LarkBrand,
  scopes: string[],
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const requested = [...new Set([...scopes, "offline_access"])].join(" ");
  const body = new URLSearchParams({ client_id: appId, scope: requested });
  const response = await fetchImpl(`${accountsBaseUrl(brand)}/oauth/v1/device_authorization`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal,
  });
  const data = await readJson(response) as LarkErrorEnvelope & {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!response.ok || !data.device_code || !data.verification_uri) {
    throw apiError("发起用户授权", response, data);
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code ?? "",
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete ?? data.verification_uri,
    expiresIn: data.expires_in ?? 240,
    interval: data.interval ?? 5,
  };
}

export interface OAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  scope: string;
}

export async function exchangeOAuthToken(
  brand: LarkBrand,
  body: URLSearchParams,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthToken | { pending: true; slowDown: boolean }> {
  const response = await fetchImpl(`${openBaseUrl(brand)}/open-apis/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  const data = await readJson(response) as LarkErrorEnvelope & {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    scope?: string;
  };
  if (data.error === "authorization_pending" || data.error === "slow_down") {
    return { pending: true, slowDown: data.error === "slow_down" };
  }
  if (!response.ok || !data.access_token) throw apiError("用户 OAuth", response, data);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? "",
    expiresIn: data.expires_in ?? 7200,
    refreshExpiresIn: data.refresh_token_expires_in ?? 604800,
    scope: data.scope ?? "",
  };
}

export async function refreshOAuthToken(
  appId: string,
  appSecret: string,
  refreshToken: string,
  brand: LarkBrand,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthToken> {
  const response = await fetchImpl(`${openBaseUrl(brand)}/open-apis/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: appId,
      client_secret: appSecret,
    }),
    signal,
  });
  const data = await readJson(response) as LarkErrorEnvelope & {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    scope?: string;
  };
  if (!response.ok || data.code !== 0 || !data.access_token) {
    throw apiError("刷新用户 OAuth", response, data);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresIn: data.expires_in ?? 7200,
    refreshExpiresIn: data.refresh_token_expires_in ?? 604800,
    scope: data.scope ?? "",
  };
}

export async function revokeOAuthToken(
  token: string,
  brand: LarkBrand,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${accountsBaseUrl(brand)}/oauth/v1/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal,
  });
  const data = await readJson(response) as LarkErrorEnvelope;
  if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
    throw apiError("撤销用户授权", response, data);
  }
}
