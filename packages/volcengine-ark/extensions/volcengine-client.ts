import { createHash, createHmac } from "node:crypto";

const DEFAULT_REGION = "cn-beijing";
const DEFAULT_TIMEOUT_MS = 15_000;
const IAM_CONTROL_URL = "https://iam.volcengineapi.com/";
const ARK_CONTROL_URL = "https://ark.cn-beijing.volcengineapi.com/";
const PAGE_SIZE = 100;

type JsonObject = Record<string, unknown>;
type ArkEndpointAction = "ListEndpoints" | "InnerDescribeModelEndpoints";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function pick(record: JsonObject | undefined, ...keys: string[]): unknown {
  for (const key of keys) if (record?.[key] !== undefined) return record[key];
}

export interface VolcengineClientOptions {
  accessKeyId: string;
  secretAccessKey: string;
  signal: AbortSignal;
  region?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface VolcengineRequestOptions {
  url: string;
  method: string;
  service: string;
  body?: string;
  headers?: HeadersInit;
}

export type VolcengineApiRecord = Record<string, unknown>;

export class VolcengineClient {
  private readonly options: VolcengineClientOptions;
  private readonly region: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: VolcengineClientOptions) {
    this.options = options;
    this.region = options.region ?? DEFAULT_REGION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request(request: VolcengineRequestOptions): Promise<Response> {
    const url = new URL(request.url);
    url.searchParams.sort();
    const method = request.method.toUpperCase();
    const xDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = xDate.slice(0, 8);
    const xContentSha256 = sha256(request.body ?? "");
    const signsPayload = request.body !== undefined;
    const signedHeaders = signsPayload ? "host;x-content-sha256;x-date" : "host;x-date";
    const canonicalHeaders = signsPayload
      ? `host:${url.host}\nx-content-sha256:${xContentSha256}\nx-date:${xDate}\n`
      : `host:${url.host}\nx-date:${xDate}\n`;
    const canonicalRequest = [
      method,
      url.pathname,
      url.search.slice(1),
      canonicalHeaders,
      signedHeaders,
      xContentSha256,
    ].join("\n");
    const scope = `${day}/${this.region}/${request.service}/request`;
    const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const signingKey = hmac(
      hmac(hmac(hmac(this.options.secretAccessKey, day), this.region), request.service),
      "request",
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const headers = new Headers(request.headers);
    headers.set("x-date", xDate);
    if (signsPayload) headers.set("x-content-sha256", xContentSha256);
    headers.set(
      "authorization",
      `HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    );
    return this.fetchImpl(url, {
      method,
      headers,
      body: request.body,
      signal: AbortSignal.any([this.options.signal, AbortSignal.timeout(this.timeoutMs)]),
    });
  }

  async listProjects(): Promise<VolcengineApiRecord[]> {
    const projects: VolcengineApiRecord[] = [];
    for (let offset = 0; offset <= 100_000;) {
      const response = await this.request({
        url: `${IAM_CONTROL_URL}?Action=ListProjects&Limit=${PAGE_SIZE}&Offset=${offset}&Version=2021-08-01`,
        method: "GET",
        service: "iam",
      });
      const { items, total } = await this.page(response, "ListProjects", "Projects");
      projects.push(...items);
      offset += items.length;
      if (offset >= total || items.length === 0) break;
    }
    return projects;
  }

  async listBuiltInEndpoints(projectNames: readonly string[]): Promise<VolcengineApiRecord[]> {
    return this.listEndpoints("InnerDescribeModelEndpoints", projectNames);
  }

  async listCustomEndpoints(projectNames: readonly string[]): Promise<VolcengineApiRecord[]> {
    return this.listEndpoints("ListEndpoints", projectNames);
  }

  private async listEndpoints(
    action: ArkEndpointAction,
    projectNames: readonly string[],
  ): Promise<VolcengineApiRecord[]> {
    const endpoints: VolcengineApiRecord[] = [];
    for (const projectName of projectNames) {
      let projectCount = 0;
      for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
        const response = await this.request({
          url: `${ARK_CONTROL_URL}?Action=${action}&Version=2024-01-01`,
          method: "POST",
          service: "ark",
          body: JSON.stringify({ PageNumber: pageNumber, PageSize: PAGE_SIZE, ProjectName: projectName }),
          headers: { "content-type": "application/json; charset=utf-8" },
        });
        const { items, total } = await this.page(response, action, "Items");
        endpoints.push(...items);
        projectCount += items.length;
        if (projectCount >= total || items.length === 0) break;
      }
    }
    return endpoints;
  }

  private async page(
    response: Response,
    action: string,
    itemKey: string,
  ): Promise<{ items: VolcengineApiRecord[]; total: number }> {
    if (!response.ok) throw new Error(`Volcengine ${action} request failed (HTTP ${response.status})`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Volcengine ${action} returned malformed JSON`);
    }
    const root = object(payload);
    const metadata = object(pick(root, "ResponseMetadata", "response_metadata"));
    const apiError = object(pick(metadata, "Error", "error"));
    if (apiError) {
      const code = string(pick(apiError, "Code", "code")) ?? "UnknownError";
      throw new Error(`Volcengine ${action} request failed (${code})`);
    }
    const result = object(pick(root, "Result", "result")) ?? root;
    const rawItems = pick(result, itemKey, itemKey.toLowerCase());
    if (!Array.isArray(rawItems)) throw new Error(`Volcengine ${action} response format changed`);
    const items = rawItems.map(object).filter((item): item is VolcengineApiRecord => Boolean(item));
    const total = number(pick(result, "Total", "total", "TotalCount", "total_count")) ?? items.length;
    return { items, total };
  }
}