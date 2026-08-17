import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(root, "snapshots", "bridge-permissions-3.json"), "utf8"));
const expectedSdkVersion = "1.73.0";
const permissions = await import("../extensions/bridge-permissions.ts");

if (packageJson.dependencies["@larksuiteoapi/node-sdk"] !== expectedSdkVersion) {
  throw new Error(
    `node-sdk changed from ${expectedSdkVersion}; review LarkChannel and Bridge permissions, then update this check explicitly`,
  );
}
if (snapshot.version !== 3 ||
  !Array.isArray(snapshot.tenantScopes) ||
  !Array.isArray(snapshot.events) ||
  !Array.isArray(snapshot.callbacks) ||
  typeof snapshot.openGroupScope !== "string") {
  throw new Error("bridge permission snapshot is invalid");
}
const stable = (value) => JSON.stringify([...value].sort());
if (snapshot.version !== permissions.BRIDGE_PERMISSION_VERSION ||
  stable(snapshot.tenantScopes) !== stable(permissions.BRIDGE_TENANT_SCOPES) ||
  snapshot.openGroupScope !== permissions.BRIDGE_OPEN_GROUP_SCOPE ||
  stable(snapshot.events) !== stable(permissions.BRIDGE_EVENTS) ||
  stable(snapshot.callbacks) !== stable(permissions.BRIDGE_CALLBACKS)) {
  throw new Error("bridge permission source and snapshot drifted; update both and review the diff");
}
console.log(`bridge permissions v${snapshot.version} match node-sdk ${expectedSdkVersion}`);
