// src/server/main.ts
import { createServer } from "node:http";
import { readFileSync as readFileSync5 } from "node:fs";

// src/server/access.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
var digest = (value) => createHash("sha256").update(value).digest();
var equal = (left, right) => timingSafeEqual(digest(left), digest(right));
function access(admin, password, apiToken) {
  const sessions = /* @__PURE__ */ new Map();
  const attempts = /* @__PURE__ */ new Map();
  const ttl = 8 * 60 * 60 * 1e3;
  return {
    login(user, secret, address) {
      const now = Date.now();
      for (const [key, expiry] of sessions) {
        if (expiry < now) {
          sessions.delete(key);
        }
      }
      for (const [key, attempt2] of attempts) {
        if (attempt2.until < now) {
          attempts.delete(key);
        }
      }
      const attempt = attempts.get(address) ?? { count: 0, until: now + 6e4 };
      if (attempt.count >= 10 || attempts.size > 1e4) {
        throw new Error("Too many login attempts; retry in one minute");
      }
      attempt.count += 1;
      attempts.set(address, attempt);
      if (!equal(user, admin) || !equal(secret, password)) {
        throw new Error("Invalid account or password");
      }
      attempts.delete(address);
      const token = randomBytes(32).toString("hex");
      sessions.set(token, now + ttl);
      return token;
    },
    authorized(request2) {
      if (equal(request2.headers.authorization ?? "", `Bearer ${apiToken}`)) {
        return true;
      }
      const cookie = request2.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("tunnel_session="));
      return (sessions.get(cookie?.slice("tunnel_session=".length) ?? "") ?? 0) > Date.now();
    },
    logout(request2) {
      const cookie = request2.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("tunnel_session="));
      sessions.delete(cookie?.slice("tunnel_session=".length) ?? "");
    }
  };
}

// src/server/settings.ts
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
function settings() {
  const root = resolve(required("TUNNEL_DATA"));
  const suffix = required("TUNNEL_DOMAIN");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(suffix)) {
    throw new Error("TUNNEL_DOMAIN must be a domain");
  }
  mkdirSync(root, { recursive: true, mode: 448 });
  return {
    suffix,
    mode: "lan",
    lanIp: required("TUNNEL_LAN_IP"),
    resolver: { port: 53, upstreams: [], provider: "none", fragment: true, configFile: `${root}/dns/tunnel.conf` },
    portal: { root, aliasesDir: `${root}/nginx`, mapPrefix: "tunnel", reload: false },
    gateway: { adapter: "none" },
    caddy: { sitesDir: `${root}/caddy`, prefix: "tunnel-", bind: required("TUNNEL_LAN_IP"), allow: required("TUNNEL_ALLOWED_CIDRS").split(",") },
    providers: {
      dns: "cloudflare",
      connectivity: "caddy",
      certificate: "internal-ca",
      policy: "lan-allowlist",
      cloud: { cloudflare: { enabled: true, zone: process.env.TUNNEL_CF_ZONE, credentialsEnv: "TUNNEL_CF_TOKEN", cnameTarget: required("TUNNEL_RAW_HOST"), allowPublicWrite: Boolean(process.env.TUNNEL_CF_TOKEN) } }
    }
  };
}

// src/server/services.ts
import { existsSync as existsSync4, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { isIP } from "node:net";

// src/portal/registry.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// src/config/index.ts
import { join, resolve as resolve2 } from "node:path";
import { readFileSync, existsSync } from "node:fs";
var registryFile = (s) => join(s.portal.root, "aliases.json");
function normalizeAlias(item) {
  const visibility = item.visibility ?? (item.lan === false ? "public" : "internal");
  return { ...item, visibility, lan: visibility === "internal" };
}
function loadRegistry(s) {
  const file = registryFile(s);
  if (!existsSync(file)) return { aliases: [] };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return { aliases: (parsed.aliases ?? []).map(normalizeAlias) };
}

// src/portal/registry.ts
var fqdn = (s, alias) => `${alias}.${s.suffix}`;
function writeRegistry(s, registry) {
  const file = registryFile(s);
  mkdirSync2(dirname(file), { recursive: true, mode: 448 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}
`, { mode: 384 });
  renameSync(tmp, file);
}
function upsert(s, entry) {
  const registry = loadRegistry(s);
  const next = registry.aliases.filter((item) => item.alias !== entry.alias);
  next.push(entry);
  next.sort((a, b) => a.alias.localeCompare(b.alias));
  const updated = { aliases: next };
  writeRegistry(s, updated);
  return updated;
}
function remove(s, alias) {
  const registry = loadRegistry(s);
  const removed = registry.aliases.find((item) => item.alias === alias);
  const updated = { aliases: registry.aliases.filter((item) => item.alias !== alias) };
  writeRegistry(s, updated);
  return { registry: updated, removed };
}
var aliasFqdn = fqdn;
function readAliases(s) {
  return loadRegistry(s).aliases.slice().sort((a, b) => a.alias.localeCompare(b.alias));
}

// src/portal/render.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readdirSync, readFileSync as readFileSync3, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/portal/providers.ts
var fqdn2 = (settings2, alias) => `${alias}.${settings2.suffix}`;
var isInternal = (alias) => (alias.visibility ?? (alias.lan === false ? "public" : "internal")) === "internal";
var cloudConfig = (settings2, alias) => {
  const provider = alias.providers?.dns ?? settings2.providers?.dns ?? "local-dnsmasq";
  return { provider, config: settings2.providers?.cloud?.[provider] };
};
var credential = (settings2, alias) => {
  const { config: config2 } = cloudConfig(settings2, alias);
  return config2?.credentialsEnv ? process.env[config2.credentialsEnv] : void 0;
};
var timeout = () => AbortSignal.timeout(15e3);
var redact = (text) => text.replace(/(token|key|secret)[^&\s"]*[=:]\s*[^&\s"]+/gi, "$1=<redacted>");
var CloudDnsProvider = class {
  kind = "dns";
  async plan(alias, settings2) {
    const zone = this.zone(settings2, alias);
    const { config: config2 } = cloudConfig(settings2, alias);
    const warnings = [];
    const changes = [];
    if (!zone) {
      warnings.push(`\u672A\u914D\u7F6E ${this.name}.zone\uFF0C\u65E0\u6CD5\u4EA7\u751F\u4E91 DNS \u8BA1\u5212`);
      return { provider: this.name, kind: this.kind, changes, warnings, blocked: true };
    }
    if (isInternal(alias)) {
      return {
        provider: this.name,
        kind: this.kind,
        changes: [{ kind: "noop", resource: fqdn2(settings2, alias.alias), detail: "internal \u522B\u540D\u7981\u6B62\u521B\u5EFA\u516C\u7F51\u8BB0\u5F55" }],
        warnings
      };
    }
    if (!config2?.allowPublicWrite) {
      warnings.push("\u516C\u7F51 DNS \u5199\u5165\u672A\u663E\u5F0F\u5F00\u542F\uFF08allowPublicWrite=false\uFF09\uFF0C\u4EC5\u751F\u6210\u8BA1\u5212");
      return { provider: this.name, kind: this.kind, changes, warnings, blocked: true };
    }
    if (!alias.authorizedBy) {
      warnings.push("public \u522B\u540D\u7F3A\u5C11 authorizedBy\uFF0C\u62D2\u7EDD\u516C\u7F51\u5199\u5165");
      return { provider: this.name, kind: this.kind, changes, warnings, blocked: true };
    }
    const token = credential(settings2, alias);
    if (!token) {
      warnings.push(`\u7F3A\u5C11\u51ED\u636E\u73AF\u5883\u53D8\u91CF ${config2.credentialsEnv ?? "\uFF08\u672A\u914D\u7F6E\uFF09"}\uFF0C\u4E0D\u6267\u884C\u771F\u5B9E\u5199\u5165`);
      return { provider: this.name, kind: this.kind, changes, warnings, blocked: true };
    }
    const name = fqdn2(settings2, alias.alias);
    const value = settings2.lanIp ?? "";
    if (!value) {
      warnings.push("\u672A\u914D\u7F6E lanIp\uFF0C\u516C\u7F51 A \u8BB0\u5F55\u503C\u5C06\u4E3A\u7A7A");
      return { provider: this.name, kind: this.kind, changes, warnings, blocked: true };
    }
    const record = { name, value, ttl: config2.ttl ?? 120 };
    try {
      const existing = await this.list(zone, name, token);
      if (!existing) {
        changes.push({ kind: "create", resource: `${this.name}:${name}`, detail: `A ${value} ttl=${record.ttl}` });
      } else if (existing.value === value) {
        changes.push({ kind: "noop", resource: `${this.name}:${name}`, detail: `\u5DF2\u662F A ${value}` });
      } else {
        changes.push({ kind: "update", resource: `${this.name}:${name}`, detail: `A ${existing.value} -> ${value}` });
      }
      return { provider: this.name, kind: this.kind, changes, warnings };
    } catch (error) {
      warnings.push(`\u8BFB\u53D6\u8FDC\u7AEF\u5931\u8D25\uFF0C\u672A\u751F\u6210\u5199\u5165\u8BA1\u5212\uFF1A${redact(error instanceof Error ? error.message : String(error))}`);
      return { provider: this.name, kind: this.kind, changes, warnings, blocked: true };
    }
  }
  async apply(alias, settings2, plan) {
    if (plan.blocked) throw new Error(`${this.name}: \u8BA1\u5212\u672A\u901A\u8FC7\u5B89\u5168\u68C0\u67E5\uFF0C\u62D2\u7EDD\u5199\u5165`);
    const zone = this.zone(settings2, alias);
    const token = credential(settings2, alias);
    if (!zone || !token) throw new Error(`${this.name}: \u7F3A\u5C11 zone \u6216\u51ED\u636E`);
    const { config: config2 } = cloudConfig(settings2, alias);
    const name = fqdn2(settings2, alias.alias);
    const record = { name, value: settings2.lanIp ?? "", ttl: config2?.ttl ?? 120 };
    const change = plan.changes.find((item) => item.kind !== "noop");
    if (!change) return;
    const existing = await this.list(zone, name, token);
    if (change.kind === "create") {
      await this.create(zone, record, token);
      return;
    }
    if (change.kind === "update" && existing) {
      await this.update(zone, record, existing, token);
      return;
    }
    throw new Error(`${this.name}: \u8FDC\u7AEF\u72B6\u6001\u4E0E\u8BA1\u5212\u4E0D\u4E00\u81F4\uFF08${change.kind}\uFF09\uFF0C\u8BF7\u91CD\u65B0\u6267\u884C plan`);
  }
  async verify(alias, settings2) {
    if (isInternal(alias)) return { ok: true, detail: "internal \u522B\u540D\u4E0D\u68C0\u67E5\u516C\u7F51 DNS" };
    const zone = this.zone(settings2, alias);
    const token = credential(settings2, alias);
    if (!zone || !token) return { ok: false, detail: "\u7F3A\u5C11 zone \u6216\u51ED\u636E\uFF0C\u65E0\u6CD5\u6821\u9A8C\u516C\u7F51\u8BB0\u5F55" };
    try {
      const existing = await this.list(zone, fqdn2(settings2, alias.alias), token);
      const value = settings2.lanIp ?? "";
      if (!existing) return { ok: false, detail: "\u516C\u7F51\u8BB0\u5F55\u4E0D\u5B58\u5728" };
      return existing.value === value ? { ok: true, detail: `\u516C\u7F51 A ${existing.value} \u5DF2\u5B58\u5728` } : { ok: false, detail: `\u516C\u7F51 A \u4E3A ${existing.value}\uFF0C\u671F\u671B ${value}` };
    } catch (error) {
      return { ok: false, detail: `\u516C\u7F51\u6821\u9A8C\u5931\u8D25\uFF1A${redact(error instanceof Error ? error.message : String(error))}` };
    }
  }
};
async function jsonRequest(url, init) {
  const response = await fetch(url, { ...init, signal: timeout() });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${redact(text).slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}
var CloudflareDnsProvider = class extends CloudDnsProvider {
  name = "cloudflare";
  recordType = "A";
  cnameSettings(settings2, alias) {
    const target = cloudConfig(settings2, alias).config?.cnameTarget;
    this.recordType = target ? "CNAME" : "A";
    return target ? { ...settings2, lanIp: target } : settings2;
  }
  async plan(alias, settings2) {
    return super.plan(alias, this.cnameSettings(settings2, alias));
  }
  async apply(alias, settings2, plan) {
    return super.apply(alias, this.cnameSettings(settings2, alias), plan);
  }
  async verify(alias, settings2) {
    return super.verify(alias, this.cnameSettings(settings2, alias));
  }
  zone(settings2, alias) {
    return cloudConfig(settings2, alias).config?.zone;
  }
  base(zone) {
    return `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`;
  }
  headers(token) {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }
  async list(zone, name, token) {
    const data = await jsonRequest(`${this.base(zone)}?type=${this.recordType}&name=${encodeURIComponent(name)}`, { headers: this.headers(token) });
    const rows = data.result ?? [];
    const row = rows[0];
    if (!row) return null;
    return { id: String(row.id), value: String(row.content) };
  }
  async create(zone, record, token) {
    await jsonRequest(this.base(zone), {
      method: "POST",
      headers: this.headers(token),
      body: JSON.stringify({ type: this.recordType, name: record.name, content: record.value, ttl: record.ttl, proxied: false })
    });
  }
  async update(zone, record, existing, token) {
    await jsonRequest(`${this.base(zone)}/${existing.id}`, {
      method: "PATCH",
      headers: this.headers(token),
      body: JSON.stringify({ type: this.recordType, name: record.name, content: record.value, ttl: record.ttl, proxied: false })
    });
  }
};
var DnspodDnsProvider = class extends CloudDnsProvider {
  name = "dnspod";
  zone(settings2, alias) {
    return cloudConfig(settings2, alias).config?.zone;
  }
  async call(path, form, token) {
    const body2 = new URLSearchParams({ login_token: token, format: "json", lang: "cn", ...form });
    const response = await fetch(`https://dnsapi.cn/${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body2,
      signal: timeout()
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${redact(text).slice(0, 500)}`);
    const data = JSON.parse(text);
    if (data.status?.code !== "1") throw new Error(`DNSPod: ${data.status?.code ?? "?"} ${data.status?.message ?? text}`);
    return data;
  }
  split(zone, name) {
    if (name === zone) return { domain: zone, sub: "@" };
    if (!name.endsWith(`.${zone}`)) throw new Error(`DNSPod: ${name} \u4E0D\u5C5E\u4E8E zone ${zone}`);
    return { domain: zone, sub: name.slice(0, -(zone.length + 1)) };
  }
  async list(zone, name, token) {
    const { domain, sub } = this.split(zone, name);
    const data = await this.call("Record.List", { domain, sub_domain: sub, record_type: "A" }, token);
    const rows = data.records ?? [];
    const row = rows.find((item) => item.type === "A");
    if (!row) return null;
    return { id: String(row.id), value: String(row.value) };
  }
  async create(zone, record, token) {
    const { domain, sub } = this.split(zone, record.name);
    await this.call("Record.Create", {
      domain,
      sub_domain: sub,
      record_type: "A",
      record_line: "\u9ED8\u8BA4",
      value: record.value,
      ttl: String(record.ttl)
    }, token);
  }
  async update(zone, record, existing, token) {
    const { domain, sub } = this.split(zone, record.name);
    await this.call("Record.Modify", {
      domain,
      record_id: existing.id,
      sub_domain: sub,
      record_type: "A",
      record_line: "\u9ED8\u8BA4",
      value: record.value,
      ttl: String(record.ttl)
    }, token);
  }
};
var HuaweiDnsProvider = class extends CloudDnsProvider {
  name = "huawei";
  zone(settings2, alias) {
    return cloudConfig(settings2, alias).config?.zone;
  }
  base(zone) {
    return `https://dns.myhuaweicloud.com/v2/zones/${zone}/recordsets`;
  }
  headers(token) {
    return { "x-auth-token": token, "content-type": "application/json" };
  }
  async list(zone, name, token) {
    const url = `${this.base(zone)}?name=${encodeURIComponent(`${name}.`)}&type=A`;
    const data = await jsonRequest(url, { headers: this.headers(token) });
    const rows = data.recordsets ?? [];
    const row = rows.find((item) => item.type === "A");
    if (!row) return null;
    const values = row.records ?? [];
    return { id: String(row.id), value: String(values[0] ?? "") };
  }
  async create(zone, record, token) {
    await jsonRequest(this.base(zone), {
      method: "POST",
      headers: this.headers(token),
      body: JSON.stringify({ name: `${record.name}.`, type: "A", ttl: record.ttl, records: [record.value] })
    });
  }
  async update(zone, record, existing, token) {
    await jsonRequest(`${this.base(zone)}/${existing.id}`, {
      method: "PUT",
      headers: this.headers(token),
      body: JSON.stringify({ name: `${record.name}.`, type: "A", ttl: record.ttl, records: [record.value] })
    });
  }
};
var LocalDnsmasqProvider = class {
  name = "local-dnsmasq";
  kind = "dns";
  async plan(alias, settings2) {
    const name = fqdn2(settings2, alias.alias);
    if (!isInternal(alias)) {
      return { provider: this.name, kind: this.kind, changes: [], warnings: ["public \u522B\u540D\u4E0D\u4F7F\u7528\u5185\u7F51 DNS \u8986\u76D6"] };
    }
    return {
      provider: this.name,
      kind: this.kind,
      changes: [{ kind: "create", resource: name, detail: `address=/${name}/${settings2.lanIp ?? ""}` }],
      warnings: settings2.lanIp ? [] : ["\u672A\u914D\u7F6E lanIp"],
      blocked: !settings2.lanIp
    };
  }
  async apply() {
  }
  async verify(alias, settings2) {
    return { ok: isInternal(alias) && Boolean(settings2.lanIp), detail: isInternal(alias) ? "\u7B49\u5F85 render \u540E\u6821\u9A8C" : "public \u522B\u540D\u4E0D\u5199\u5185\u7F51 DNS" };
  }
};
function dnsProvider(settings2, alias) {
  const name = alias.providers?.dns ?? settings2.providers?.dns ?? "local-dnsmasq";
  switch (name) {
    case "local-dnsmasq":
      return new LocalDnsmasqProvider();
    case "cloudflare":
      return new CloudflareDnsProvider();
    case "dnspod":
      return new DnspodDnsProvider();
    case "huawei":
      return new HuaweiDnsProvider();
    default:
      throw new Error(`\u4E0D\u652F\u6301\u7684 DNS provider\uFF1A${String(name)}`);
  }
}

// src/portal/render.ts
var writeLines = (path, lines) => {
  writeFileSync2(path, lines.length ? `${lines.join("\n")}
` : "");
};
var quote = (value) => /^[A-Za-z0-9_.:/\[\]-]+$/.test(value) ? value : JSON.stringify(value);
function caddySite(settings2, item) {
  const name = aliasFqdn(settings2, item.alias);
  const target = `${item.scheme}://${item.host}:${item.port}`;
  const lines = [`# generated by aio-plugin-portal; alias=${item.alias} visibility=${item.visibility ?? "internal"}`, `${name} {`, "	import defaults"];
  if (isInternal(item)) {
    const bind = settings2.caddy?.bind;
    if (bind) lines.push(`	bind ${quote(bind)}`);
    const allow = settings2.caddy?.allow?.length ? settings2.caddy.allow : ["127.0.0.1/32"];
    lines.push(`	@internal remote_ip ${allow.join(" ")}`);
    lines.push("	handle @internal {", "		encode gzip", `		reverse_proxy ${quote(target)}`, "	}");
    lines.push("	handle {", `		respond ${settings2.caddy?.denyStatus ?? 404}`, "	}");
  } else {
    lines.push("	encode gzip", `	reverse_proxy ${quote(target)}`);
  }
  lines.push("}", "");
  return lines.join("\n");
}
function cleanGenerated(dir, prefix) {
  if (!existsSync3(dir)) return [];
  const removed = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".caddy")) continue;
    const path = join2(dir, name);
    const text = readFileSync3(path, "utf8");
    if (text.startsWith("# generated by aio-plugin-portal")) {
      rmSync(path);
      removed.push(path);
    }
  }
  return removed;
}
function renderCaddy(settings2) {
  const caddy = settings2.caddy;
  if (!caddy?.sitesDir) return [];
  const prefix = caddy.prefix ?? "portal-";
  mkdirSync3(caddy.sitesDir, { recursive: true });
  cleanGenerated(caddy.sitesDir, prefix);
  const files = [];
  for (const item of readAliases(settings2)) {
    const path = join2(caddy.sitesDir, `${prefix}${item.alias}.caddy`);
    writeFileSync2(path, caddySite(settings2, item));
    files.push(path);
  }
  return files;
}
function render(settings2) {
  const s = settings2;
  const aliases = readAliases(s);
  const dir = s.portal.aliasesDir;
  mkdirSync3(dir, { recursive: true });
  const map = [];
  const scheme = [];
  const host = [];
  for (const item of aliases) {
    const name = aliasFqdn(s, item.alias);
    const target = `${item.host}:${item.port}`;
    map.push(`    ${name}  ${target};`);
    scheme.push(`    ${name}  ${item.scheme};`);
    host.push(`    ${name}  ${target};`);
  }
  const files = [
    join2(dir, `${s.portal.mapPrefix}.map`),
    join2(dir, `${s.portal.mapPrefix}.scheme`),
    join2(dir, `${s.portal.mapPrefix}.host`)
  ];
  writeLines(files[0], map);
  writeLines(files[1], scheme);
  writeLines(files[2], host);
  const resolver = s.resolver.configFile;
  mkdirSync3(join2(resolver, ".."), { recursive: true });
  const overrides = s.mode === "none" || !s.lanIp ? [] : aliases.filter((item) => isInternal(item)).map((item) => `address=/${aliasFqdn(s, item.alias)}/${s.lanIp}`);
  const header = `# \u7531 aio-portal \u751F\u6210\uFF0C\u8BF7\u52FF\u624B\u6539\uFF1B\u6539 ${aliasFqdn(s, "aio-portal")} \u7684\u6CE8\u518C\u8868\u540E\u6267\u884C sync`;
  const lines = s.resolver.fragment ? [header, ...overrides] : [
    header,
    `port=${s.resolver.port}`,
    `listen-address=${s.lanIp || "127.0.0.1"}`,
    "bind-interfaces",
    "no-resolv",
    "no-hosts",
    "cache-size=1000",
    ...s.resolver.upstreams.map((up) => `server=${up}`),
    ...overrides
  ];
  writeFileSync2(resolver, `${lines.join("\n")}
`);
  return { aliases: aliases.length, files, resolver, caddy: renderCaddy(s) };
}

// src/server/caddy.ts
import { request, Agent } from "node:http";
function caddyRequest(endpoint, path, method = "GET", body2, agent, metadata, headers = {}) {
  return new Promise((resolve3, reject) => {
    const payload = body2 === void 0 ? void 0 : JSON.stringify(body2);
    const connection = endpoint.startsWith("http:") ? { hostname: new URL(endpoint).hostname, port: new URL(endpoint).port, agent } : { socketPath: endpoint };
    const req = request({ ...connection, path, method, headers: { ...headers, ...payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} } }, (response) => {
      let text = "";
      if (metadata) {
        metadata.etag = response.headers.etag;
      }
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
        if (text.length > 1e6) {
          req.destroy(new Error("Caddy response too large"));
        }
      });
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 300) {
          reject(new Error(`Caddy HTTP ${response.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          resolve3(text ? JSON.parse(text) : null);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(1e4, () => req.destroy(new Error("Caddy request timeout")));
    req.end(payload);
  });
}
function routes(settings2, aliases) {
  return aliases.map((item) => {
    const proxy = { handler: "reverse_proxy", upstreams: [{ dial: `${item.host}:${item.port}` }], ...item.scheme === "https" ? { transport: { protocol: "http", tls: {} } } : {} };
    const handlers = item.visibility === "public" ? [proxy] : [{ handler: "subroute", routes: [
      { match: [{ remote_ip: { ranges: settings2.caddy?.allow ?? [] } }], handle: [proxy], terminal: true },
      { handle: [{ handler: "static_response", status_code: 404 }] }
    ] }];
    return { match: [{ host: [`${item.alias}.${settings2.suffix}`] }], handle: handlers, terminal: true };
  });
}
async function publish(settings2, aliases, endpoint) {
  const id = "tunnel-services";
  const consoleHost = new URL(process.env.TUNNEL_PUBLIC_URL ?? "http://localhost").hostname;
  const listener = process.env.TUNNEL_CADDY_LISTENER;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const metadata = {};
      const config2 = await caddyRequest(endpoint, "/config/", "GET", void 0, agent, metadata);
      const server2 = Object.values(config2.apps.http.servers).find((value) => (!listener || value.listen?.includes(listener)) && JSON.stringify(value.routes).includes(`"${consoleHost}"`));
      if (!server2) {
        continue;
      }
      const managed = { match: [{ host: aliases.map((item) => `${item.alias}.${settings2.suffix}`) }], handle: [{ "@id": id, handler: "subroute", routes: routes(settings2, aliases) }] };
      const existing = (server2.routes ?? []).findIndex((route) => JSON.stringify(route).includes(`"@id":"${id}"`));
      if (existing >= 0 && JSON.stringify(server2.routes?.[existing]) === JSON.stringify(managed)) {
        return;
      }
      if (existing < 0 && !aliases.length) {
        return;
      }
      const other = (server2.routes ?? []).filter((_, index) => index !== existing);
      for (const alias of aliases) {
        const domain = `${alias.alias}.${settings2.suffix}`;
        if (JSON.stringify(other).includes(`"${domain}"`)) {
          throw new Error(`Caddy already manages ${domain} outside Tunnel`);
        }
      }
      server2.routes = aliases.length ? [managed, ...other] : other;
      config2.apps.tls ??= {};
      config2.apps.tls.automation ??= {};
      const issuerId = "tunnel-internal-certificates";
      const policies = (config2.apps.tls.automation.policies ?? []).filter((policy) => policy["@id"] !== issuerId);
      const internal = aliases.filter((item) => item.visibility !== "public").map((item) => `${item.alias}.${settings2.suffix}`);
      if (internal.length) {
        policies.unshift({ "@id": issuerId, subjects: internal, issuers: [{ module: "internal" }] });
      }
      config2.apps.tls.automation.policies = policies;
      if (!metadata.etag) {
        throw new Error("Caddy did not return an ETag; refusing an unguarded config update");
      }
      await caddyRequest(endpoint, "/config/", "POST", config2, agent, void 0, { "if-match": metadata.etag });
      return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Caddy HTTP 412")) {
        continue;
      }
      throw error;
    } finally {
      agent.destroy();
    }
  }
  throw new Error("Caddy console route/listener not found or config changed concurrently");
}

// src/server/services.ts
function validate(value) {
  const { alias, host, port, scheme, visibility, note } = value;
  if (typeof alias !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(alias)) {
    throw new Error("Invalid alias");
  }
  if (typeof host !== "string" || !(isIP(host) === 4 || /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host))) {
    throw new Error("Invalid target host");
  }
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("Invalid port");
  }
  if (scheme !== "http" && scheme !== "https") {
    throw new Error("Invalid scheme");
  }
  if (visibility !== "internal" && visibility !== "public") {
    throw new Error("Invalid visibility");
  }
  if (typeof note !== "string" || note.length > 300) {
    throw new Error("Invalid note");
  }
  return { alias, host, port: Number(port), scheme, visibility, note, authorizedBy: visibility === "public" ? "console-admin" : void 0 };
}
function serviceRegistry(settings2, socket) {
  let active = false;
  const assertIdle = () => {
    if (active) {
      throw new Error("An apply operation is already running");
    }
  };
  return {
    list: () => readAliases(settings2),
    save: (value) => {
      assertIdle();
      const entry = validate(value);
      const name = `${entry.alias}.${settings2.suffix}`;
      if ([new URL(process.env.TUNNEL_PUBLIC_URL ?? "http://localhost").hostname, process.env.TUNNEL_RAW_HOST].includes(name)) {
        throw new Error("The console and raw entry hostnames are reserved");
      }
      return upsert(settings2, entry);
    },
    remove: (alias) => {
      assertIdle();
      return remove(settings2, alias);
    },
    async recover() {
      const file = `${settings2.portal.root}/published.json`;
      if (active || !existsSync4(file)) {
        return;
      }
      active = true;
      try {
        await publish(settings2, JSON.parse(readFileSync4(file, "utf8")), socket);
      } finally {
        active = false;
      }
    },
    async apply() {
      if (active) {
        throw new Error("An apply operation is already running");
      }
      active = true;
      try {
        const aliases = readAliases(settings2);
        const entries = await Promise.all(aliases.map(async (item) => {
          const provider = dnsProvider(settings2, item);
          return { item, provider, plan: item.visibility === "public" ? await provider.plan(item, settings2) : null };
        }));
        const blocked = entries.filter((entry) => entry.plan?.blocked);
        if (blocked.length) {
          throw new Error(blocked.map((entry) => `${entry.item.alias}: ${entry.plan?.warnings.join("; ")}`).join("\n"));
        }
        await publish(settings2, aliases, socket);
        render(settings2);
        const verified = [];
        for (const { item, provider, plan } of entries) {
          if (plan) {
            await provider.apply(item, settings2, plan);
            const check = await provider.verify(item, settings2);
            if (!check.ok) {
              throw new Error(`${item.alias}: ${check.detail}`);
            }
          }
          verified.push(item.alias);
        }
        const report = { at: (/* @__PURE__ */ new Date()).toISOString(), routes: verified, dns: "Internal DNS fragment generated; resolver reload is managed by the host" };
        writeFileSync3(`${settings2.portal.root}/published.json`, JSON.stringify(aliases), { mode: 384 });
        writeFileSync3(`${settings2.portal.root}/last-apply.json`, JSON.stringify(report), { mode: 384 });
        return report;
      } finally {
        active = false;
      }
    }
  };
}

// src/server/main.ts
var config = settings();
var origin = new URL(required("TUNNEL_PUBLIC_URL")).origin;
var login = access(required("TUNNEL_ADMIN_USER"), required("TUNNEL_ADMIN_PASSWORD"), required("TUNNEL_API_TOKEN"));
var services = serviceRegistry(config, required("TUNNEL_CADDY_ADMIN"));
var assets = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };
async function body(request2) {
  if (!request2.headers["content-type"]?.startsWith("application/json")) {
    throw new Error("JSON body required");
  }
  let text = "";
  for await (const chunk of request2) {
    text += chunk;
    if (Buffer.byteLength(text) > 32768) {
      throw new Error("Request too large");
    }
  }
  return JSON.parse(text);
}
var server = createServer(async (request2, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
  const send = (status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  try {
    const path = new URL(request2.url ?? "/", "http://localhost").pathname;
    if (request2.method === "GET" && path === "/health") {
      send(200, { status: "ok", service: "tunnel", version: "0.3.0" });
      return;
    }
    if (request2.method === "GET" && assets[path]) {
      const [file, type] = assets[path];
      response.writeHead(200, { "content-type": `${type}; charset=utf-8` });
      response.end(readFileSync5(new URL(`./web/${file}`, import.meta.url)));
      return;
    }
    if (request2.headers.origin && request2.headers.origin !== origin) {
      send(403, { error: "Origin rejected" });
      return;
    }
    if (request2.method === "POST" && path === "/api/login") {
      const data = await body(request2);
      const token = login.login(String(data.user ?? ""), String(data.password ?? ""), request2.socket.remoteAddress ?? "unknown");
      response.setHeader("set-cookie", `tunnel_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${origin.startsWith("https:") ? "; Secure" : ""}`);
      send(200, { ok: true });
      return;
    }
    if (!login.authorized(request2)) {
      send(401, { error: "Login required" });
      return;
    }
    if (request2.method === "POST" && path === "/api/logout") {
      login.logout(request2);
      response.setHeader("set-cookie", "tunnel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      send(200, { ok: true });
      return;
    }
    if (request2.method === "GET" && path === "/api/services") {
      send(200, { domain: config.suffix, items: services.list() });
      return;
    }
    if (request2.method === "PUT" && path === "/api/services") {
      send(200, services.save(await body(request2)));
      return;
    }
    if (request2.method === "DELETE" && path.startsWith("/api/services/")) {
      send(200, services.remove(decodeURIComponent(path.slice("/api/services/".length))));
      return;
    }
    if (request2.method === "POST" && path === "/api/apply") {
      await body(request2);
      send(200, await services.apply());
      return;
    }
    send(404, { error: "Not found" });
  } catch (error) {
    send(400, { error: error instanceof Error ? error.message : "Request failed" });
  }
});
server.requestTimeout = 6e4;
server.headersTimeout = 15e3;
server.listen(Number(required("TUNNEL_PORT")), required("TUNNEL_BIND"), () => console.log("Tunnel server ready"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
var recovery = setInterval(async () => {
  try {
    await services.recover();
  } catch (error) {
    console.error("Caddy route recovery:", error instanceof Error ? error.message : String(error));
  }
}, 3e4);
recovery.unref();
