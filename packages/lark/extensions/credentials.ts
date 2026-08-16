import type { ApiKeyCredential, AuthInteraction, OAuthCredential } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  APP_ID_ENV,
  APP_PROVIDER_ID,
  BRAND_ENV,
  DOMAINS_ENV,
  TENANT_SCOPES_ENV,
  USER_SCOPES_ENV,
  type LarkBrand,
} from "./constants.ts";
import { AUTH_DOMAINS, normalizeDomains, scopesForDomains } from "./scopes.ts";

export interface AppCredentials {
  appId: string;
  appSecret: string;
  brand: LarkBrand;
  domains: string[];
  tenantScopes: string[];
  userScopes: string[];
}

function split(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

export function parseAppCredential(credential: ApiKeyCredential | undefined): AppCredentials | undefined {
  const appId = credential?.env?.[APP_ID_ENV];
  const appSecret = credential?.key;
  const brand = credential?.env?.[BRAND_ENV];
  if (!appId || !appSecret || (brand !== "feishu" && brand !== "lark")) return undefined;
  return {
    appId,
    appSecret,
    brand,
    domains: split(credential.env?.[DOMAINS_ENV]),
    tenantScopes: split(credential.env?.[TENANT_SCOPES_ENV]),
    userScopes: split(credential.env?.[USER_SCOPES_ENV]),
  };
}

export function readAppCredential(): AppCredentials | undefined {
  const credential = readStoredCredential(APP_PROVIDER_ID);
  return credential?.type === "api_key" ? parseAppCredential(credential) : undefined;
}

export function serializeAppCredential(app: AppCredentials): ApiKeyCredential {
  return {
    type: "api_key",
    key: app.appSecret,
    env: {
      [APP_ID_ENV]: app.appId,
      [BRAND_ENV]: app.brand,
      [DOMAINS_ENV]: app.domains.join(","),
      [TENANT_SCOPES_ENV]: app.tenantScopes.join(","),
      [USER_SCOPES_ENV]: app.userScopes.join(","),
    },
  };
}

export async function promptDomains(
  interaction: AuthInteraction,
  initial: string[] = [],
): Promise<{ domains: string[]; tenantScopes: string[]; userScopes: string[] }> {
  interaction.notify({
    type: "info",
    message: `可选领域：${AUTH_DOMAINS.join(", ")}。多个领域用逗号分隔；空值表示不预授权业务权限。`,
  });
  const input = await interaction.prompt({
    type: "text",
    message: "需要预授权的领域",
    placeholder: initial.join(",") || "calendar,docs,drive",
  });
  const domains = normalizeDomains(input);
  const scopes = scopesForDomains(domains);
  return {
    domains,
    tenantScopes: scopes.tenant,
    userScopes: scopes.user,
  };
}

export function userCredentialAppId(credential: OAuthCredential): string | undefined {
  return typeof credential.app_id === "string" ? credential.app_id : undefined;
}
