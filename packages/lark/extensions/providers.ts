import {
  createProvider,
  type ApiKeyCredential,
  type AuthInteraction,
  type OAuthCredential,
  type ProviderAuth,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { registerApp } from "@larksuiteoapi/node-sdk";
import {
  APP_ID_ENV,
  APP_PROVIDER_ID,
  BRAND_ENV,
  DOMAINS_ENV,
  TENANT_SCOPES_ENV,
  USER_PROVIDER_ID,
  USER_SCOPES_ENV,
  type LarkBrand,
} from "./constants.ts";
import {
  parseAppCredential,
  promptDomains,
  readAppCredential,
  serializeAppCredential,
  userCredentialAppId,
  type AppCredentials,
} from "./credentials.ts";
import {
  exchangeOAuthToken,
  exchangeTenantToken,
  queryBotInfo,
  queryAppScopes,
  refreshOAuthToken,
  requestDeviceAuthorization,
} from "./lark-api.ts";
import { DEFAULT_QR_DOMAINS, missingScopes, scopesForDomains } from "./scopes.ts";

export interface ProviderDependencies {
  registerApp: typeof registerApp;
  exchangeTenantToken: typeof exchangeTenantToken;
  queryAppScopes: typeof queryAppScopes;
  queryBotInfo: typeof queryBotInfo;
  requestDeviceAuthorization: typeof requestDeviceAuthorization;
  exchangeOAuthToken: typeof exchangeOAuthToken;
  refreshOAuthToken: typeof refreshOAuthToken;
  readAppCredential: typeof readAppCredential;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("授权已取消"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("授权已取消"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const defaultDependencies: ProviderDependencies = {
  registerApp,
  exchangeTenantToken,
  queryAppScopes,
  queryBotInfo,
  requestDeviceAuthorization,
  exchangeOAuthToken,
  refreshOAuthToken,
  readAppCredential,
  now: Date.now,
  sleep,
};

function credentialProvider(id: string, name: string, auth: ProviderAuth) {
  return createProvider({
    id,
    name,
    auth,
    models: [],
    api: openAICompletionsApi(),
  });
}

async function selectBrand(interaction: AuthInteraction): Promise<LarkBrand> {
  const value = await interaction.prompt({
    type: "select",
    message: "应用区域",
    options: [
      { id: "feishu", label: "Feishu 中国" },
      { id: "lark", label: "Lark Global" },
    ],
  });
  if (value !== "feishu" && value !== "lark") throw new Error("无效的应用区域");
  return value;
}

function notifyScopeResult(
  interaction: AuthInteraction,
  requested: { tenantScopes: string[]; userScopes: string[] },
  actual: { tenant: string[]; user: string[] },
  appId: string,
  brand: LarkBrand,
): void {
  const missingTenant = missingScopes(requested.tenantScopes, actual.tenant);
  const missingUser = missingScopes(requested.userScopes, actual.user);
  if (missingTenant.length === 0 && missingUser.length === 0) {
    interaction.notify({ type: "info", message: "应用权限核验通过。" });
    return;
  }
  const base = brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  const allMissing = [...new Set([...missingTenant, ...missingUser])];
  const url = `${base}/page/scope-apply?clientID=${encodeURIComponent(appId)}&scopes=${encodeURIComponent(allMissing.join(","))}`;
  interaction.notify({
    type: "info",
    message: [
      "平台未启用全部请求权限。",
      missingTenant.length ? `缺少 tenant scopes：${missingTenant.join(", ")}` : "",
      missingUser.length ? `缺少 user scopes：${missingUser.join(", ")}` : "",
      "可在开放平台权限管理中补充，或重新进入“飞书/Lark 应用配置”选择扫码配置，并在扫码页面选择该应用。",
    ].filter(Boolean).join("\n"),
    links: [{ label: "打开权限管理", url }],
  });
}

async function verifyAndReport(
  interaction: AuthInteraction,
  app: AppCredentials,
  dependencies: ProviderDependencies,
): Promise<void> {
  const tat = await dependencies.exchangeTenantToken(
    app.appId,
    app.appSecret,
    app.brand,
    interaction.signal,
  );
  try {
    const actual = await dependencies.queryAppScopes(
      app.appId,
      tat.token,
      app.brand,
      interaction.signal,
    );
    notifyScopeResult(interaction, app, actual, app.appId, app.brand);
  } catch (error) {
    interaction.notify({
      type: "info",
      message: `应用凭据已验证，但无法读取实际权限：${error instanceof Error ? error.message : String(error)}`,
    });
  }
  try {
    const bot = await dependencies.queryBotInfo(tat.token, app.brand, interaction.signal);
    interaction.notify({
      type: "info",
      message: bot.appName
        ? `聊天 Bot capability 可用：${bot.appName}。`
        : "聊天 Bot capability 可用。",
    });
  } catch (error) {
    interaction.notify({
      type: "info",
      message: [
        "聊天 Bot 状态不可用；这不会阻断文档、日历等非 IM API。",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    });
  }
}

async function configureByQr(
  interaction: AuthInteraction,
  dependencies: ProviderDependencies,
): Promise<ApiKeyCredential> {
  const scopes = scopesForDomains(DEFAULT_QR_DOMAINS);
  const selected = {
    domains: DEFAULT_QR_DOMAINS,
    tenantScopes: scopes.tenant,
    userScopes: scopes.user,
  };
  interaction.notify({
    type: "info",
    message: "将为应用预配置常用领域权限：calendar、docs、drive。其他权限可在需要时补充。",
  });
  let detectedBrand: LarkBrand = "feishu";
  const result = await dependencies.registerApp({
    source: "pi-lark",
    signal: interaction.signal,
    appPreset: {
      name: "{user} 的 Pi 助手",
      desc: "由 Pi 管理凭据并通过官方 lark-cli 调用飞书/Lark OpenAPI",
    },
    addons: {
      preset: false,
      scopes: { tenant: selected.tenantScopes, user: selected.userScopes },
    },
    onQRCodeReady(info) {
      interaction.notify({
        type: "auth_url",
        url: info.url,
        instructions: `请扫描页面二维码或打开链接，然后在飞书/Lark 页面选择已有应用或新建应用；如果浏览器已有登录态，可能会直接进入应用选择页。链接 ${info.expireIn} 秒后过期。`,
      });
    },
    onStatusChange(info) {
      if (info.status === "domain_switched") {
        detectedBrand = "lark";
        interaction.notify({ type: "progress", message: "检测到 Lark tenant，已切换国际站。" });
      } else {
        interaction.notify({ type: "progress", message: `应用注册状态：${info.status}` });
      }
    },
  });
  const brand = result.user_info?.tenant_brand === "lark" ? "lark" : detectedBrand;
  const app: AppCredentials = {
    appId: result.client_id,
    appSecret: result.client_secret,
    brand,
    ...selected,
  };
  await verifyAndReport(interaction, app, dependencies);
  return serializeAppCredential(app);
}

async function configureExisting(
  interaction: AuthInteraction,
  dependencies: ProviderDependencies,
): Promise<ApiKeyCredential> {
  const brand = await selectBrand(interaction);
  const appId = (await interaction.prompt({
    type: "text",
    message: "App ID / Client ID",
    placeholder: "cli_...",
  })).trim();
  const appSecret = (await interaction.prompt({
    type: "secret",
    message: "App Secret / Client Secret",
  })).trim();
  if (!appId || !appSecret) throw new Error("App ID 和 App Secret 均不能为空");
  const selected = await promptDomains(interaction);
  const app: AppCredentials = { appId, appSecret, brand, ...selected };
  await verifyAndReport(interaction, app, dependencies);
  return serializeAppCredential(app);
}

export async function loginApp(
  interaction: AuthInteraction,
  dependencies: ProviderDependencies = defaultDependencies,
): Promise<ApiKeyCredential> {
  const mode = await interaction.prompt({
    type: "select",
    message: "第一步：配置飞书/Lark 开放平台应用",
    options: [
      {
        id: "qr",
        label: "扫码选择或创建应用",
        description: "在飞书/Lark 页面选择已有应用，或新建 PersonalAgent",
      },
      {
        id: "manual",
        label: "手动配置已有应用",
        description: "输入 App ID / App Secret，验证后直接保存",
      },
    ],
  });
  if (mode === "qr") return configureByQr(interaction, dependencies);
  if (mode === "manual") return configureExisting(interaction, dependencies);
  throw new Error("无效的接入方式");
}

export async function loginUser(
  interaction: AuthInteraction,
  dependencies: ProviderDependencies = defaultDependencies,
): Promise<OAuthCredential> {
  const app = dependencies.readAppCredential();
  if (!app) throw new Error("请先完成“飞书/Lark 应用配置”，再授权当前用户");
  interaction.notify({
    type: "info",
    message: "第二步：授权当前用户。此操作会产生用户访问令牌（UAT），不会修改开放平台中的应用权限配置。",
  });
  const device = await dependencies.requestDeviceAuthorization(
    app.appId,
    app.appSecret,
    app.brand,
    app.userScopes,
    interaction.signal,
  );
  interaction.notify({
    type: "device_code",
    userCode: device.userCode,
    verificationUri: device.verificationUriComplete,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expiresIn,
  });
  interaction.notify({
    type: "auth_url",
    url: device.verificationUriComplete,
    instructions: "打开链接并确认用户授权。",
  });

  const deadline = dependencies.now() + device.expiresIn * 1000;
  let interval = Math.max(1, device.interval);
  while (dependencies.now() < deadline) {
    await dependencies.sleep(interval * 1000, interaction.signal);
    const result = await dependencies.exchangeOAuthToken(
      app.brand,
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.deviceCode,
        client_id: app.appId,
        client_secret: app.appSecret,
      }),
      interaction.signal,
    );
    if ("pending" in result) {
      if (result.slowDown) interval = Math.min(60, interval + 5);
      continue;
    }
    return {
      type: "oauth",
      access: result.accessToken,
      refresh: result.refreshToken,
      expires: dependencies.now() + result.expiresIn * 1000,
      refresh_expires: dependencies.now() + result.refreshExpiresIn * 1000,
      app_id: app.appId,
      brand: app.brand,
      scopes: result.scope,
    };
  }
  throw new Error("用户 OAuth 已过期，请重新授权");
}

export async function refreshUser(
  credential: OAuthCredential,
  signal: AbortSignal,
  dependencies: ProviderDependencies = defaultDependencies,
): Promise<OAuthCredential> {
  const app = dependencies.readAppCredential();
  if (!app) throw new Error("飞书/Lark 应用配置不存在，无法刷新用户授权");
  if (userCredentialAppId(credential) !== app.appId) {
    throw new Error("App ID 已改变，拒绝复用旧 UAT；请重新进行“飞书/Lark 用户授权”");
  }
  const token = await dependencies.refreshOAuthToken(
    app.appId,
    app.appSecret,
    credential.refresh,
    app.brand,
    signal,
  );
  return {
    ...credential,
    access: token.accessToken,
    refresh: token.refreshToken,
    expires: dependencies.now() + token.expiresIn * 1000,
    refresh_expires: dependencies.now() + token.refreshExpiresIn * 1000,
    scopes: token.scope || credential.scopes,
    brand: app.brand,
  };
}

export function createAppProvider() {
  return credentialProvider(APP_PROVIDER_ID, "飞书/Lark 应用配置", {
    apiKey: {
      name: "创建或复用开放平台应用（App ID / App Secret）",
      login: loginApp,
      async resolve({ credential }) {
        const app = parseAppCredential(credential);
        if (!app) return undefined;
        return {
          auth: { apiKey: app.appSecret },
          env: {
            [APP_ID_ENV]: app.appId,
            [BRAND_ENV]: app.brand,
            [DOMAINS_ENV]: app.domains.join(","),
            [TENANT_SCOPES_ENV]: app.tenantScopes.join(","),
            [USER_SCOPES_ENV]: app.userScopes.join(","),
          },
          source: "Pi credential store",
        };
      },
    },
  });
}

export function createUserProvider() {
  return credentialProvider(USER_PROVIDER_ID, "飞书/Lark 用户授权", {
    oauth: {
      name: "授权当前用户（OAuth）",
      login: loginUser,
      refresh: refreshUser,
      async toAuth(credential) {
        const app = readAppCredential();
        if (!app || userCredentialAppId(credential) !== app.appId) {
          throw new Error("App ID 已改变，请重新进行“飞书/Lark 用户授权”");
        }
        return { apiKey: credential.access };
      },
    },
  });
}
