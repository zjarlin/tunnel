#!/usr/bin/env node

// src/aio/sidecar.ts
import { createServer } from "node:http";
import { readFileSync, chmodSync } from "node:fs";

// src/server/access.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
var digest = (value) => createHash("sha256").update(value).digest();
var equal = (left, right) => timingSafeEqual(digest(left), digest(right));

// src/server/settings.ts
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

// src/aio/sidecar.ts
var host = JSON.parse(readFileSync(required("AIO_PLUGIN_CONFIG"), "utf8"));
var upstream = new URL(required("TUNNEL_URL"));
var token = required("TUNNEL_API_TOKEN");
var tenant = required("TUNNEL_AIO_TENANT");
var users = required("TUNNEL_AIO_USERS").split(",");
if (host.tenant_id !== tenant || !host.ingress_token) {
  throw new Error("AIO tenant configuration rejected");
}
var socket = required("AIO_PLUGIN_SOCKET");
var server = createServer(async (request, response) => {
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && path === "/health") {
    send(200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && path === "/aio/describe") {
    send(200, { label: "Tunnel", pages: [{ id: "tunnel", label: "Tunnel", entry: "index.html", scene: ["workspace", "\u5DE5\u4F5C\u7A7A\u95F4"], menu_path: [], permission: null, surface: "workspace" }] });
    return;
  }
  if (!equal(String(request.headers["x-aio-token"] ?? ""), host.ingress_token) || request.headers["x-aio-tenant-id"] !== tenant || !users.includes(String(request.headers["x-aio-user-id"] ?? ""))) {
    send(403, { error: "AIO identity rejected" });
    return;
  }
  if (!/^\/api\/(services(?:\/[a-z0-9-]+)?|apply)$/.test(path)) {
    send(404, { error: "Not found" });
    return;
  }
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 32768) {
        throw new Error("Request too large");
      }
    }
    const result = await fetch(new URL(path, upstream), { method: request.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body || void 0, redirect: "error", signal: AbortSignal.timeout(3e4) });
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(await result.text());
  } catch (error) {
    send(502, { error: error instanceof Error ? error.message : "Sidecar request failed" });
  }
});
server.listen(socket, () => chmodSync(socket, 384));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
