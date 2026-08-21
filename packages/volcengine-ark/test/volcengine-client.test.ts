import assert from "node:assert/strict";
import test from "node:test";
import { VolcengineClient } from "../extensions/volcengine-client.ts";

test("signs and sends a Volcengine request", async () => {
  let requestUrl: URL | undefined;
  let requestInit: RequestInit | undefined;
  const client = new VolcengineClient({
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    signal: new AbortController().signal,
    fetchImpl: async (input, init) => {
      requestUrl = new URL(String(input));
      requestInit = init;
      return new Response();
    },
  });

  await client.request({
    url: "https://ark.cn-beijing.volcengineapi.com/?Version=2024-01-01&Action=ListEndpoints",
    method: "post",
    service: "ark",
    body: "{}",
    headers: { "content-type": "application/json" },
  });

  assert.equal(requestUrl?.search, "?Action=ListEndpoints&Version=2024-01-01");
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.body, "{}");
  const headers = new Headers(requestInit?.headers);
  assert.match(headers.get("x-date") ?? "", /^\d{8}T\d{6}Z$/);
  assert.equal(headers.get("x-content-sha256")?.length, 64);
  assert.match(headers.get("authorization") ?? "", /Credential=AKID\/\d{8}\/cn-beijing\/ark\/request/);
  assert.match(headers.get("authorization") ?? "", /SignedHeaders=host;x-content-sha256;x-date/);
  assert.equal(headers.get("authorization")?.includes("SECRET"), false);
});

test("lists projects and built-in or custom endpoints", async () => {
  const requests: Array<{ action: string | null; projectName?: string }> = [];
  const client = new VolcengineClient({
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
    signal: new AbortController().signal,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const action = url.searchParams.get("Action");
      const body = init?.body ? JSON.parse(String(init.body)) as { ProjectName: string } : undefined;
      requests.push({ action, projectName: body?.ProjectName });
      if (action === "ListProjects") {
        return new Response(JSON.stringify({
          Result: { Projects: [{ ProjectName: "default" }, { ProjectName: "research" }], Total: 2 },
        }));
      }
      return new Response(JSON.stringify({
        Result: { Items: [{ Id: `${action}:${body?.ProjectName}` }], TotalCount: 1 },
      }));
    },
  });

  const projects = await client.listProjects();
  const projectNames = projects.map((project) => project.ProjectName as string);
  const builtIn = await client.listBuiltInEndpoints(projectNames);
  const custom = await client.listCustomEndpoints(projectNames);

  assert.deepEqual(projectNames, ["default", "research"]);
  assert.deepEqual(builtIn, [
    { Id: "InnerDescribeModelEndpoints:default" },
    { Id: "InnerDescribeModelEndpoints:research" },
  ]);
  assert.deepEqual(custom, [
    { Id: "ListEndpoints:default" },
    { Id: "ListEndpoints:research" },
  ]);
  assert.deepEqual(requests, [
    { action: "ListProjects", projectName: undefined },
    { action: "InnerDescribeModelEndpoints", projectName: "default" },
    { action: "InnerDescribeModelEndpoints", projectName: "research" },
    { action: "ListEndpoints", projectName: "default" },
    { action: "ListEndpoints", projectName: "research" },
  ]);
});