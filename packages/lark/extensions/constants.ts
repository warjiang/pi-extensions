export const APP_PROVIDER_ID = "lark-app";
export const USER_PROVIDER_ID = "lark-user";

export const APP_ID_ENV = "PI_LARK_APP_ID";
export const BRAND_ENV = "PI_LARK_BRAND";
export const DOMAINS_ENV = "PI_LARK_DOMAINS";
export const TENANT_SCOPES_ENV = "PI_LARK_TENANT_SCOPES";
export const USER_SCOPES_ENV = "PI_LARK_USER_SCOPES";

export const LARK_CREDENTIAL_ENV = [
  "LARKSUITE_CLI_APP_ID",
  "LARKSUITE_CLI_APP_SECRET",
  "LARKSUITE_CLI_BRAND",
  "LARKSUITE_CLI_USER_ACCESS_TOKEN",
  "LARKSUITE_CLI_TENANT_ACCESS_TOKEN",
  "LARKSUITE_CLI_DEFAULT_AS",
  "LARKSUITE_CLI_STRICT_MODE",
  "LARKSUITE_CLI_AUTH_PROXY",
] as const;

export type LarkBrand = "feishu" | "lark";
export type LarkIdentity = "bot" | "user";

export function openBaseUrl(brand: LarkBrand): string {
  return brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

export function accountsBaseUrl(brand: LarkBrand): string {
  return brand === "lark" ? "https://accounts.larksuite.com" : "https://accounts.feishu.cn";
}
