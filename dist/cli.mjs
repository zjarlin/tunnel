#!/usr/bin/env node

// src/cli.ts
import { parseArgs } from "node:util";

// src/portal/commands.ts
import { existsSync as existsSync4 } from "node:fs";

// src/config/index.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
var DEFAULTS = () => ({
  suffix: "",
  mode: "lan",
  lanIp: "",
  hostsFile: "/etc/hosts",
  resolver: { port: 53, upstreams: ["223.5.5.5", "114.114.114.114"], provider: "dnsmasq" },
  portal: { root: join(homedir(), ".config", "aio-portal"), mapPrefix: "10-alias", reload: true },
  gateway: { adapter: "xiaomi", fallbackDns: "223.5.5.5" },
  caddy: { prefix: "portal-", allow: ["127.0.0.1/32"], denyStatus: 404 },
  providers: {
    dns: "local-dnsmasq",
    connectivity: "caddy",
    certificate: "internal-ca",
    policy: "lan-allowlist"
  }
});
function loadSettings(rootOverride) {
  const base = DEFAULTS();
  const root = resolve(rootOverride ?? process.env.AIO_PORTAL_HOME ?? base.portal.root);
  const configFile = join(root, "aio-portal.json");
  let file = {};
  if (existsSync(configFile)) file = JSON.parse(readFileSync(configFile, "utf8"));
  const merged = {
    ...base,
    ...file,
    resolver: { ...base.resolver, ...file.resolver },
    portal: { ...base.portal, ...file.portal, root },
    gateway: { ...base.gateway, ...file.gateway },
    caddy: { ...base.caddy, ...file.caddy },
    providers: { ...base.providers, ...file.providers }
  };
  if (!merged.suffix) throw new Error(`\u7F3A\u5C11\u57DF\u540D\u540E\u7F00\u914D\u7F6E\uFF0C\u8BF7\u5728 ${configFile} \u4E2D\u8BBE\u7F6E suffix`);
  merged.portal.root = root;
  merged.resolver.configFile ??= join(root, "dns", "aio-portal.conf");
  merged.portal.aliasesDir ??= join(root, "nginx", "aliases.d");
  if (merged.caddy && !merged.caddy.sitesDir) merged.caddy.sitesDir = join(root, "caddy", "sites");
  return merged;
}
var registryFile = (s) => s.portal.registryFile ?? process.env.TUNNEL_REGISTRY_FILE ?? join(s.portal.root, "aliases.json");
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

// src/portal/gateway.ts
import { createHash } from "node:crypto";
var Http = class {
  constructor(origin, password) {
    this.origin = origin;
    this.password = password;
  }
  origin;
  password;
  async call(path, options = {}) {
    const body = options.form ? new URLSearchParams(options.form).toString() : void 0;
    const headers = { referer: `${this.origin}/`, "user-agent": "Mozilla/5.0" };
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";
    const response = await fetch(`${this.origin}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 12e3)
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`\u7F51\u5173\u8FD4\u56DE\u975E JSON \u54CD\u5E94\uFF08HTTP ${response.status}\uFF09\uFF1A${text.slice(0, 120)}`);
    }
  }
  /** 先明文登录；部分固件需要 nonce + SHA1 流程。 */
  async login() {
    const plain = await this.call("/cgi-bin/luci/api/xqsystem/login", {
      method: "POST",
      form: { username: "admin", logtype: "2", password: this.password }
    });
    const token = plain.token ?? plain.stok;
    if (plain.code === 0 && token) return token;
    const first = await this.call("/cgi-bin/luci/api/xqsystem/login");
    const nonce = first.nonce;
    if (nonce) {
      const pw = createHash("sha1").update(this.password).digest("hex");
      const key = createHash("sha1").update(nonce + pw).digest("hex");
      const second = await this.call("/cgi-bin/luci/api/xqsystem/login", {
        method: "POST",
        form: { username: "admin", logtype: "2", nonce, password: key }
      });
      const token2 = second.token ?? second.stok;
      if (second.code === 0 && token2) return token2;
      throw new Error(`\u7F51\u5173\u767B\u5F55\u5931\u8D25\uFF1A${String(second.msg ?? second)}`);
    }
    throw new Error(`\u7F51\u5173\u767B\u5F55\u5931\u8D25\uFF1A${String(plain.msg ?? plain)}`);
  }
};
var XiaomiGateway = class {
  constructor(address, password) {
    this.address = address;
    this.http = new Http(`http://${address}`, password);
  }
  address;
  name = "xiaomi";
  http;
  async api(token, path, form) {
    return await this.http.call(`/cgi-bin/luci/;stok=${token}/api/${path}`, form ? { method: "POST", form } : {});
  }
  async probe() {
    const token = await this.http.login();
    const info = await this.api(token, "xqnetwork/wan_info");
    const root = info.info ?? {};
    const details = root.details ?? {};
    if (!("dnsAddrs" in root)) throw new Error("\u8BE5\u56FA\u4EF6\u7684\u4E0A\u7F51\u8BBE\u7F6E\u672A\u66B4\u9732 DNS \u5B57\u6BB5\uFF0C\u8BF7\u6539\u7528\u5BA2\u6237\u7AEF\u65B9\u5F0F");
    return {
      adapter: this.name,
      wanType: details.wanType,
      current: { dns1: root.dnsAddrs ?? "", dns2: root.dnsAddrs1 ?? "" },
      detail: { username: details.username, mru: details.mru }
    };
  }
  async submit(token, dns, current) {
    const form = {
      wanType: "pppoe",
      pppoeName: String(current.username ?? ""),
      pppoePwd: String(current.password ?? ""),
      autoset: "0",
      mtu: String(current.mru ?? "1480"),
      service: String(current.service ?? ""),
      dns1: dns.dns1,
      dns2: dns.dns2
    };
    const result = await this.api(token, "xqnetwork/set_wan", form);
    if (result.code !== 0) throw new Error(`\u7F51\u5173\u5199\u5165\u5931\u8D25\uFF1A${result.msg ?? JSON.stringify(result)}`);
  }
  async apply(dns) {
    const token = await this.http.login();
    const info = await this.api(token, "xqnetwork/wan_info");
    await this.submit(token, dns, (info.info ?? {}).details ?? {});
  }
  async restore() {
    const token = await this.http.login();
    await this.submit(token, { dns1: "", dns2: "" }, {});
  }
};
function gatewayAdapter(config, password) {
  if (config.adapter === "none" || !config.address) throw new Error("\u672A\u914D\u7F6E\u7F51\u5173\u5730\u5740\u6216\u5DF2\u7981\u7528\u7F51\u5173\u9002\u914D\u5668");
  if (config.adapter === "xiaomi") return new XiaomiGateway(config.address, password);
  throw new Error(`\u4E0D\u652F\u6301\u7684\u7F51\u5173\u9002\u914D\u5668\uFF1A${config.adapter}`);
}

// src/portal/registry.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var fqdn = (s, alias) => `${alias}.${s.suffix}`;
function writeRegistry(s, registry) {
  const file = registryFile(s);
  mkdirSync(dirname(file), { recursive: true, mode: 448 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}
`, { mode: 384 });
  renameSync(tmp, file);
}
function snapshot(s) {
  const file = registryFile(s);
  return existsSync2(file) ? readFileSync2(file, "utf8") : null;
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
import { execFileSync } from "node:child_process";
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync3, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/portal/providers.ts
var fqdn2 = (settings2, alias) => `${alias}.${settings2.suffix}`;
var isInternal = (alias) => (alias.visibility ?? (alias.lan === false ? "public" : "internal")) === "internal";
var cloudConfig = (settings2, alias) => {
  const provider = alias.providers?.dns ?? settings2.providers?.dns ?? "local-dnsmasq";
  return { provider, config: settings2.providers?.cloud?.[provider] };
};
var credential = (settings2, alias) => {
  const { config } = cloudConfig(settings2, alias);
  return config?.credentialsEnv ? process.env[config.credentialsEnv] : void 0;
};
var timeout = () => AbortSignal.timeout(15e3);
var redact = (text) => text.replace(/(token|key|secret)[^&\s"]*[=:]\s*[^&\s"]+/gi, "$1=<redacted>");
var CloudDnsProvider = class {
  kind = "dns";
  async plan(alias, settings2) {
    const zone = this.zone(settings2, alias);
    const { config } = cloudConfig(settings2, alias);
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
    if (!config?.allowPublicWrite) {
      warnings.push("\u516C\u7F51 DNS \u5199\u5165\u672A\u663E\u5F0F\u5F00\u542F\uFF08allowPublicWrite=false\uFF09\uFF0C\u4EC5\u751F\u6210\u8BA1\u5212");
      return { provider: this.name, kind: this.kind, changes, warnings, blocked: true };
    }
    if (!alias.authorizedBy) {
      warnings.push("public \u522B\u540D\u7F3A\u5C11 authorizedBy\uFF0C\u62D2\u7EDD\u516C\u7F51\u5199\u5165");
      return { provider: this.name, kind: this.kind, changes, warnings, blocked: true };
    }
    const token = credential(settings2, alias);
    if (!token) {
      warnings.push(`\u7F3A\u5C11\u51ED\u636E\u73AF\u5883\u53D8\u91CF ${config.credentialsEnv ?? "\uFF08\u672A\u914D\u7F6E\uFF09"}\uFF0C\u4E0D\u6267\u884C\u771F\u5B9E\u5199\u5165`);
      return { provider: this.name, kind: this.kind, changes, warnings, blocked: true };
    }
    const name = fqdn2(settings2, alias.alias);
    const value = settings2.lanIp ?? "";
    if (!value) {
      warnings.push("\u672A\u914D\u7F6E lanIp\uFF0C\u516C\u7F51 A \u8BB0\u5F55\u503C\u5C06\u4E3A\u7A7A");
      return { provider: this.name, kind: this.kind, changes, warnings, blocked: true };
    }
    const record = { name, value, ttl: config.ttl ?? 120 };
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
  async apply(alias, settings2, plan2) {
    if (plan2.blocked) throw new Error(`${this.name}: \u8BA1\u5212\u672A\u901A\u8FC7\u5B89\u5168\u68C0\u67E5\uFF0C\u62D2\u7EDD\u5199\u5165`);
    const zone = this.zone(settings2, alias);
    const token = credential(settings2, alias);
    if (!zone || !token) throw new Error(`${this.name}: \u7F3A\u5C11 zone \u6216\u51ED\u636E`);
    const { config } = cloudConfig(settings2, alias);
    const name = fqdn2(settings2, alias.alias);
    const record = { name, value: settings2.lanIp ?? "", ttl: config?.ttl ?? 120 };
    const change = plan2.changes.find((item) => item.kind !== "noop");
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
  async apply(alias, settings2, plan2) {
    return super.apply(alias, this.cnameSettings(settings2, alias), plan2);
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
    const body = new URLSearchParams({ login_token: token, format: "json", lang: "cn", ...form });
    const response = await fetch(`https://dnsapi.cn/${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
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
var CaddyConnectivityProvider = class {
  name = "caddy";
  kind = "connectivity";
  async plan(alias, settings2) {
    const name = fqdn2(settings2, alias.alias);
    const warnings = [];
    if (isInternal(alias) && !settings2.caddy?.bind) warnings.push("internal \u522B\u540D\u7F3A\u5C11 caddy.bind\uFF0C\u516C\u7F51\u5165\u53E3\u4ECD\u53EF\u80FD\u547D\u4E2D");
    if (isInternal(alias) && !settings2.caddy?.allow?.length) warnings.push("internal \u522B\u540D\u7F3A\u5C11 caddy.allow\uFF0C\u6765\u6E90\u4E0D\u53D7\u9650");
    return {
      provider: this.name,
      kind: this.kind,
      changes: [{ kind: "update", resource: `caddy:${name}`, detail: `reverse_proxy ${alias.scheme}://${alias.host}:${alias.port}` }],
      warnings,
      blocked: isInternal(alias) && (!settings2.caddy?.bind || !settings2.caddy?.allow?.length)
    };
  }
  async apply() {
  }
  async verify(alias, settings2) {
    if (!isInternal(alias)) return { ok: true, detail: "public \u522B\u540D\u4E0D\u505A\u6765\u6E90\u9650\u5236" };
    const ok = Boolean(settings2.caddy?.bind && settings2.caddy?.allow?.length);
    return { ok, detail: ok ? "internal \u7AD9\u70B9\u5DF2\u914D\u7F6E bind + allowlist" : "\u7F3A\u5C11 bind \u6216 allowlist" };
  }
};
var InternalCaProvider = class {
  name = "internal-ca";
  kind = "certificate";
  async plan() {
    return { provider: this.name, kind: this.kind, changes: [], warnings: ["\u8BC1\u4E66\u7531 localmesh Caddy \u7684 internal issuer \u7EDF\u4E00\u7B7E\u53D1"] };
  }
  async apply() {
  }
  async verify() {
    return { ok: true, detail: "internal-ca \u7531 Caddy \u8D1F\u8D23" };
  }
};
var AcmeProvider = class {
  name = "acme";
  kind = "certificate";
  async plan() {
    return { provider: this.name, kind: this.kind, changes: [], warnings: ["ACME \u9700\u8981\u5916\u90E8\u53EF\u8FBE\u7684 80/443 \u4E0E DNS \u51ED\u636E\uFF0C\u672C\u5730\u4E0D\u4F2A\u9020\u7B7E\u53D1"], blocked: true };
  }
  async apply() {
    throw new Error("ACME \u672A\u914D\u7F6E\u6388\u6743\uFF0C\u62D2\u7EDD\u5199\u5165");
  }
  async verify() {
    return { ok: false, detail: "ACME \u9700\u8981\u771F\u5B9E\u8FDC\u7AEF\u9A8C\u8BC1" };
  }
};
var LanAllowlistProvider = class {
  name = "lan-allowlist";
  kind = "policy";
  async plan(alias, settings2) {
    if (!isInternal(alias)) return { provider: this.name, kind: this.kind, changes: [], warnings: ["public \u522B\u540D\u9700\u663E\u5F0F\u6388\u6743"] };
    return {
      provider: this.name,
      kind: this.kind,
      changes: [{ kind: "noop", resource: fqdn2(settings2, alias.alias), detail: `allow ${settings2.caddy?.allow?.join(" ") ?? ""} deny ${settings2.caddy?.denyStatus ?? 404}` }],
      warnings: []
    };
  }
  async apply() {
  }
  async verify(alias, settings2) {
    if (!isInternal(alias) && !alias.authorizedBy) return { ok: false, detail: "public \u522B\u540D\u7F3A\u5C11 authorizedBy" };
    return { ok: true, detail: "\u7B56\u7565\u6EE1\u8DB3" };
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
function connectivityProvider(settings2, alias) {
  const name = alias.providers?.connectivity ?? settings2.providers?.connectivity ?? "caddy";
  switch (name) {
    case "caddy":
      return new CaddyConnectivityProvider();
    case "aio-tunnel":
    case "cloudflared":
      return {
        name,
        kind: "connectivity",
        async plan() {
          return {
            provider: name,
            kind: "connectivity",
            changes: [],
            warnings: [`${name} \u7531 AIO \u8BBE\u5907\u96A7\u9053/\u5916\u90E8\u96A7\u9053\u7BA1\u7406\uFF1B\u8BF7\u5728\u96A7\u9053\u4FA7\u7528\u8BBE\u5907\u914D\u5BF9\u4E0E\u77ED\u65F6\u7968\u636E\u6821\u9A8C\uFF0C\u4E0D\u5728\u672C\u5730 Caddy \u4F2A\u9020\u6210\u529F`],
            blocked: true
          };
        },
        async apply() {
          throw new Error(`${name} \u9700\u8981\u5916\u90E8\u96A7\u9053\u7F16\u6392\uFF0C\u62D2\u7EDD\u672C\u5730\u5199\u5165`);
        },
        async verify() {
          return { ok: false, detail: `${name} \u9700\u8981\u771F\u5B9E\u96A7\u9053\u5065\u5EB7\u68C0\u67E5\uFF08AIO \u8BBE\u5907\u5728\u7EBF + \u76EE\u6807\u5141\u8BB8 + \u7968\u636E\u6709\u6548\uFF09` };
        }
      };
    default:
      throw new Error(`\u4E0D\u652F\u6301\u7684\u8FDE\u901A\u6027 provider\uFF1A${String(name)}`);
  }
}
function certificateProvider(settings2, alias) {
  const name = alias.providers?.certificate ?? settings2.providers?.certificate ?? "internal-ca";
  return name === "acme" ? new AcmeProvider() : new InternalCaProvider();
}
function policyProvider(settings2, alias) {
  const name = alias.providers?.policy ?? settings2.providers?.policy ?? "lan-allowlist";
  if (name === "public") {
    return {
      name,
      kind: "policy",
      async plan() {
        return { provider: name, kind: "policy", changes: [], warnings: ["\u9700\u663E\u5F0F public \u6388\u6743"] };
      },
      async apply() {
      },
      async verify() {
        return { ok: true, detail: "public \u7B56\u7565\u7531\u6CE8\u518C\u8868\u6388\u6743\u5B57\u6BB5\u4FDD\u8BC1" };
      }
    };
  }
  if (name === "aio-auth") {
    return {
      name,
      kind: "policy",
      async plan() {
        return { provider: name, kind: "policy", changes: [], warnings: ["AIO \u8BA4\u8BC1\u7531\u5E94\u7528\u81EA\u8EAB\u8D1F\u8D23"] };
      },
      async apply() {
      },
      async verify() {
        return { ok: true, detail: "AIO \u8BA4\u8BC1\u7531\u5E94\u7528\u8D1F\u8D23" };
      }
    };
  }
  return new LanAllowlistProvider();
}
function providersFor(settings2, alias) {
  return [
    dnsProvider(settings2, alias),
    connectivityProvider(settings2, alias),
    certificateProvider(settings2, alias),
    policyProvider(settings2, alias)
  ];
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
  mkdirSync2(caddy.sitesDir, { recursive: true });
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
  mkdirSync2(dir, { recursive: true });
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
  mkdirSync2(join2(resolver, ".."), { recursive: true });
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
var run = (program, args) => {
  try {
    const out = execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out: out.trim() };
  } catch (error) {
    const err = error;
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || (err.message ?? "") };
  }
};
function validateCaddy(settings2) {
  const s = settings2;
  if (!s.caddy?.binary) return "\u5DF2\u8DF3\u8FC7 caddy validate\uFF08\u672A\u914D\u7F6E caddy.binary\uFF09";
  const config = s.caddy.sitesDir ? join2(s.caddy.sitesDir, "..", "Caddyfile") : "";
  if (!existsSync3(config)) return `Caddy \u914D\u7F6E\u6821\u9A8C\u5931\u8D25\uFF1A\u627E\u4E0D\u5230 ${config}`;
  const args = ["validate", "--config", config];
  const test = run(s.caddy.binary, args);
  return test.code === 0 ? "Caddy \u914D\u7F6E\u6821\u9A8C\u901A\u8FC7" : `Caddy \u914D\u7F6E\u6821\u9A8C\u5931\u8D25\uFF1A${test.out}`;
}
function reloadCaddy(settings2) {
  const command = settings2.caddy?.reload;
  if (!command) return "\u5DF2\u8DF3\u8FC7 Caddy \u70ED\u52A0\u8F7D\uFF08\u672A\u914D\u7F6E caddy.reload\uFF09";
  const [program, ...args] = command.trim().split(/\s+/);
  const result = run(program, args);
  return result.code === 0 ? "Caddy \u5DF2\u70ED\u52A0\u8F7D" : `Caddy \u70ED\u52A0\u8F7D\u5931\u8D25\uFF1A${result.out}`;
}
function reloadResolver(settings2) {
  if (settings2.resolver.provider === "none") return "\u5DF2\u8DF3\u8FC7\u5185\u7F51\u89E3\u6790\u5237\u65B0\uFF08resolver.provider=none\uFF09";
  const binary = settings2.resolver.dnsmasqBinary ?? "dnsmasq";
  const test = run(binary, ["--test", `--conf-file=${settings2.resolver.configFile}`]);
  if (test.code !== 0) return `\u89E3\u6790\u914D\u7F6E\u6821\u9A8C\u5931\u8D25\uFF1A${test.out}`;
  if (settings2.resolver.service) {
    const reload = run("systemctl", ["reload-or-restart", settings2.resolver.service]);
    return reload.code === 0 ? "\u5185\u7F51\u89E3\u6790\u5DF2\u5237\u65B0" : `\u5185\u7F51\u89E3\u6790\u5237\u65B0\u5931\u8D25\uFF1A${reload.out}`;
  }
  return "\u89E3\u6790\u914D\u7F6E\u5DF2\u751F\u6210\uFF08\u672A\u914D\u7F6E resolver.service\uFF0C\u672A\u89E6\u78B0\u5BBF\u4E3B\u670D\u52A1\uFF09";
}

// src/portal/reconcile.ts
async function reconcile(settings2, options = {}) {
  const aliases = readAliases(settings2).filter((item) => !options.alias || item.alias === options.alias);
  const items = [];
  for (const item of aliases) {
    const plans = [];
    const applied = [];
    const verify = [];
    for (const provider of providersFor(settings2, item)) {
      const plan2 = await provider.plan(item, settings2);
      plans.push(plan2);
      if (options.apply && !plan2.blocked) {
        await provider.apply(item, settings2, plan2);
        applied.push(provider.name);
      }
      const result = await provider.verify(item, settings2);
      verify.push({ provider: provider.name, ...result });
    }
    items.push({
      alias: item.alias,
      visibility: item.visibility ?? "internal",
      plans,
      applied,
      verify,
      ok: plans.every((plan2) => !plan2.blocked) && verify.every((result) => result.ok)
    });
  }
  return { items, ok: items.every((item) => item.ok) };
}
function formatReport(report) {
  const lines = [];
  for (const item of report.items) {
    lines.push(`${item.alias} (${item.visibility}) ${item.ok ? "OK" : "NEEDS ATTENTION"}`);
    for (const plan2 of item.plans) {
      const changes = plan2.changes.length ? plan2.changes : [{ kind: "noop", resource: plan2.provider, detail: "\u65E0\u53D8\u66F4" }];
      for (const change of changes) lines.push(`  [${plan2.provider}] ${change.kind} ${change.resource} ${change.detail}`);
      for (const warning of plan2.warnings) lines.push(`  [${plan2.provider}] warning: ${warning}`);
    }
    for (const result of item.verify) lines.push(`  [${result.provider}] verify ${result.ok ? "ok" : "failed"}: ${result.detail}`);
  }
  lines.push(report.ok ? "\u534F\u8C03\u5B8C\u6210" : "\u5B58\u5728\u672A\u6EE1\u8DB3\u7684 provider \u8BA1\u5212\u6216\u6821\u9A8C");
  return lines.join("\n");
}

// src/portal/commands.ts
var isAlias = (value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
var isHost = (value) => /^[A-Za-z0-9_.:-]+$/.test(value);
var parsePort = (value) => {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`\u7AEF\u53E3\u4E0D\u5408\u6CD5\uFF1A${value}`);
  return port;
};
var settings = (home) => loadSettings(home);
function add(options) {
  const s = settings(options.home);
  if (!isAlias(options.alias)) throw new Error("\u522B\u540D\u53EA\u80FD\u4F7F\u7528\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u8FDE\u5B57\u7B26");
  if (!isHost(options.host)) throw new Error("\u76EE\u6807\u4E3B\u673A\u4E0D\u5408\u6CD5");
  if (options.scheme !== "http" && options.scheme !== "https") throw new Error("\u534F\u8BAE\u53EA\u80FD\u662F http \u6216 https");
  if (options.visibility === "public" && !options.authorizedBy) throw new Error("public \u522B\u540D\u5FC5\u987B\u63D0\u4F9B --authorized-by\uFF0C\u660E\u786E\u8BB0\u5F55\u6388\u6743\u4EBA");
  const entry = {
    alias: options.alias,
    host: options.host,
    port: parsePort(options.port),
    scheme: options.scheme,
    visibility: options.visibility,
    lan: options.visibility === "internal" && s.mode !== "none",
    authorizedBy: options.authorizedBy,
    note: options.note ?? ""
  };
  const registry = upsert(s, entry);
  const result = render(s);
  return [
    `\u5DF2\u767B\u8BB0 ${aliasFqdn(s, entry.alias)} -> ${entry.scheme}://${entry.host}:${entry.port}\uFF08${entry.visibility}\uFF0C\u5171 ${result.aliases} \u6761\uFF09`,
    renderReload(s)
  ].join("\n");
}
function removeAlias(options) {
  const s = settings(options.home);
  const result = remove(s, options.alias);
  if (!result.removed) throw new Error(`\u672A\u627E\u5230\u522B\u540D\uFF1A${options.alias}`);
  const rendered = render(s);
  return [`\u5DF2\u5220\u9664 ${aliasFqdn(s, options.alias)}\uFF08\u5269\u4F59 ${rendered.aliases} \u6761\uFF09`, renderReload(s)].join("\n");
}
function list(options) {
  const s = settings(options.home);
  const aliases = readAliases(s);
  if (!aliases.length) return "\uFF08\u7A7A\uFF09";
  return aliases.map((item) => `  ${aliasFqdn(s, item.alias).padEnd(30)} -> ${item.scheme}://${item.host}:${item.port}  ${item.visibility ?? "internal"}  ${item.note ?? ""}`).join("\n");
}
async function sync(options) {
  const s = settings(options.home);
  const before = snapshot(s);
  const result = render(s);
  const report = await reconcile(s, { apply: options.apply });
  const after = snapshot(s);
  if (before !== after) throw new Error("\u540C\u6B65\u8FC7\u7A0B\u4E2D\u6CE8\u518C\u8868\u88AB\u5176\u5B83\u8FDB\u7A0B\u4FEE\u6539\uFF0C\u8BF7\u91CD\u8BD5");
  const lines = [
    `\u5DF2\u751F\u6210 ${result.aliases} \u6761\u6620\u5C04\u4E0E ${result.caddy.length} \u4E2A Caddy \u7AD9\u70B9`,
    renderReload(s),
    validateCaddy(s),
    reloadCaddy(s),
    formatReport(report)
  ];
  if (!report.ok) {
    throw new Error(`${lines.join("\n")}
\u540C\u6B65\u88AB\u62D2\u7EDD\uFF1A\u5B58\u5728\u672A\u6EE1\u8DB3\u7684 provider \u8BA1\u5212\u6216\u6821\u9A8C\uFF0C\u672A\u53D1\u5E03\u4EFB\u4F55\u53D8\u66F4`);
  }
  return lines.join("\n");
}
async function plan(options) {
  const s = settings(options.home);
  return formatReport(await reconcile(s, { apply: false }));
}
function renderReload(s) {
  if (!s.portal.reload) return "\u5DF2\u8DF3\u8FC7\u670D\u52A1\u70ED\u52A0\u8F7D\uFF08portal.reload=false\uFF09";
  return reloadResolver(s);
}
function doctor(options) {
  const s = settings(options.home);
  const resolved = existsSync4(s.resolver.configFile);
  const rendered = existsSync4(`${s.portal.aliasesDir}/${s.portal.mapPrefix}.map`);
  const lines = [
    `  \u57DF\u540D\u540E\u7F00        ${s.suffix}`,
    `  \u89E3\u6790\u6A21\u5F0F        ${s.mode}`,
    `  \u5185\u7F51 IP         ${s.lanIp || "\uFF08\u672A\u914D\u7F6E\uFF09"}`,
    `  \u6CE8\u518C\u8868          ${readAliases(s).length} \u6761`,
    `  \u6620\u5C04\u7247\u6BB5        ${rendered ? "\u5DF2\u751F\u6210" : "\u7F3A\u5931"}`,
    `  \u89E3\u6790\u914D\u7F6E        ${resolved ? "\u5DF2\u751F\u6210" : "\u7F3A\u5931"}`,
    `  Caddy provider  ${s.providers?.connectivity ?? "caddy"}  sites=${s.caddy?.sitesDir ?? "\uFF08\u672A\u914D\u7F6E\uFF09"}  bind=${s.caddy?.bind ?? "\uFF08\u672A\u914D\u7F6E\uFF09"}`,
    `  \u7F51\u5173\u9002\u914D\u5668      ${s.gateway.adapter}${s.gateway.address ? ` @ ${s.gateway.address}` : "\uFF08\u672A\u914D\u7F6E\u5730\u5740\uFF09"}`
  ];
  const internal = readAliases(s).filter((item) => (item.visibility ?? "internal") === "internal");
  const guard = internal.every((item) => Boolean(s.caddy?.bind) && Boolean(s.caddy?.allow?.length));
  if (!guard) lines.push("  \u5185\u7F51\u9632\u62A4        internal \u522B\u540D\u7F3A\u5C11 caddy.bind \u6216 caddy.allow");
  const ok = rendered && resolved && Boolean(s.suffix) && Boolean(s.lanIp || s.mode !== "lan") && guard;
  return [...lines, ok ? "\u4F53\u68C0\u901A\u8FC7" : "\u5B58\u5728\u7F3A\u5931\u9879\uFF0C\u8BF7\u5148\u6267\u884C sync \u6216\u8865\u9F50\u914D\u7F6E"].join("\n");
}
async function warden(options) {
  const s = settings(options.home);
  const target = s.lanIp || "\u672C\u673A\u5185\u7F51 IP";
  if (!options.password) {
    return [
      "\u7F51\u5173\u7A97\u53E3\uFF1A\u628A\u7F51\u5173\u4E0A\u6E38 DNS \u6307\u5411\u672C\u673A\u89E3\u6790\u5668\uFF0C\u8BA9\u5C40\u57DF\u7F51\u6240\u6709\u8BBE\u5907\u81EA\u52A8\u8D70\u5185\u7F51\u3002",
      `  \u7F51\u5173\u9002\u914D\u5668\uFF1A${s.gateway.adapter}${s.gateway.address ? ` @ ${s.gateway.address}` : "\uFF08\u672A\u914D\u7F6E address\uFF09"}`,
      `  DNS1 \u76EE\u6807\uFF1A${target}     DNS2 \u515C\u5E95\uFF1A${s.gateway.fallbackDns}`,
      "",
      "  aio-plugin-portal warden --password <\u7F51\u5173\u5BC6\u7801>            # \u53EA\u8BFB\u63A2\u6D4B",
      "  aio-plugin-portal warden --password <\u7F51\u5173\u5BC6\u7801> --apply    # \u5199\u5165",
      "  aio-plugin-portal warden --password <\u7F51\u5173\u5BC6\u7801> --restore  # \u56DE\u6EDA",
      "",
      "\u624B\u52A8\u7B49\u4EF7\u64CD\u4F5C\uFF1A\u7F51\u5173\u7BA1\u7406\u9875 \u2192 \u4E0A\u7F51\u8BBE\u7F6E \u2192 DNS1 \u586B\u672C\u673A IP\u3001DNS2 \u586B\u516C\u7F51\u89E3\u6790\u5668\u3002"
    ].join("\n");
  }
  const adapter = gatewayAdapter(s.gateway, options.password);
  if (options.restore) {
    await adapter.restore();
    return "\u5DF2\u6062\u590D\u7F51\u5173\u4E0A\u6E38 DNS \u4E3A\u81EA\u52A8\u83B7\u53D6\u3002";
  }
  const probe = await adapter.probe();
  const head = `\u7F51\u5173\u9002\u914D\u5668 ${probe.adapter}\uFF1A\u5F53\u524D ${probe.wanType ?? "-"}\uFF0CDNS ${probe.current.dns1 || "\u81EA\u52A8"} / ${probe.current.dns2 || "\u81EA\u52A8"}`;
  if (!options.apply) return [head, "\u53EA\u8BFB\u63A2\u6D4B\u5B8C\u6210\uFF0C\u672A\u505A\u4FEE\u6539\u3002\u786E\u8BA4\u540E\u52A0 --apply \u5199\u5165\u3002"].join("\n");
  if (!s.lanIp) throw new Error("\u672A\u914D\u7F6E\u5185\u7F51 IP\uFF08lanIp\uFF09\uFF0C\u65E0\u6CD5\u5199\u5165\u7F51\u5173");
  await adapter.apply({ dns1: s.lanIp, dns2: s.gateway.fallbackDns ?? "223.5.5.5" });
  return [head, `\u5DF2\u628A\u7F51\u5173\u4E0A\u6E38 DNS \u8BBE\u4E3A ${s.lanIp}\uFF08\u515C\u5E95 ${s.gateway.fallbackDns}\uFF09\u3002\u5C40\u57DF\u7F51\u8BBE\u5907\u65E0\u9700\u4EFB\u4F55\u8BBE\u7F6E\u5373\u81EA\u52A8\u8D70\u5185\u7F51\u3002`].join("\n");
}

// src/cli.ts
var USAGE = `aio-plugin-portal <\u547D\u4EE4> [\u9009\u9879]

\u547D\u4EE4:
  add <\u522B\u540D> --port <\u7AEF\u53E3> [--host <\u4E3B\u673A>] [--scheme http|https] [--note <\u5907\u6CE8>]
  add <\u522B\u540D> --port <\u7AEF\u53E3> --visibility public --authorized-by <\u6388\u6743\u4EBA>
  \uFF08public \u5FC5\u987B\u663E\u5F0F\u6388\u6743\uFF1B\u65E7 --no-lan \u53EA\u8868\u793A\u4E0D\u505A\u5185\u7F51 DNS\uFF0C\u4E0D\u518D\u81EA\u52A8\u7B97\u6388\u6743\uFF09
  remove <\u522B\u540D>
  list
  plan
  sync [--apply]
  doctor
  warden [--password <\u7F51\u5173\u5BC6\u7801>] [--apply] [--restore]

\u901A\u7528\u9009\u9879:
  --home <\u76EE\u5F55>    \u95E8\u6237\u914D\u7F6E\u6839\u76EE\u5F55\uFF08\u9ED8\u8BA4 AIO_PORTAL_HOME \u6216 ~/.config/aio-portal\uFF09
  --version        \u663E\u793A\u7248\u672C
  --help           \u663E\u793A\u5E2E\u52A9`;
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "boolean" },
      help: { type: "boolean" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string" },
      scheme: { type: "string", default: "http" },
      note: { type: "string" },
      lan: { type: "boolean", default: true },
      "no-lan": { type: "boolean", default: false },
      visibility: { type: "string" },
      "authorized-by": { type: "string" },
      home: { type: "string" },
      password: { type: "string" },
      apply: { type: "boolean", default: false },
      restore: { type: "boolean", default: false }
    }
  });
  const [command, argument] = positionals;
  if (values.version) {
    console.log("0.4.0");
    return;
  }
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case "add": {
      if (!argument) throw new Error("add \u9700\u8981\u522B\u540D");
      if (values.port === void 0) throw new Error("add \u9700\u8981 --port");
      const visibility = values.visibility ?? (values["no-lan"] || !values.lan ? "public" : "internal");
      if (visibility !== "internal" && visibility !== "public") throw new Error("--visibility \u53EA\u80FD\u662F internal \u6216 public");
      const authorizedBy = values["authorized-by"];
      console.log(add({ alias: argument, host: values.host, port: values.port, scheme: values.scheme, note: values.note, visibility, authorizedBy, home: values.home }));
      return;
    }
    case "remove": {
      if (!argument) throw new Error("remove \u9700\u8981\u522B\u540D");
      console.log(removeAlias({ alias: argument, home: values.home }));
      return;
    }
    case "list":
      console.log(list({ home: values.home }));
      return;
    case "plan":
      console.log(await plan({ home: values.home }));
      return;
    case "sync":
      console.log(await sync({ home: values.home, apply: values.apply }));
      return;
    case "doctor":
      console.log(doctor({ home: values.home }));
      return;
    case "warden":
      console.log(await warden({ password: values.password, apply: values.apply, restore: values.restore, home: values.home }));
      return;
    default:
      throw new Error(`\u672A\u77E5\u547D\u4EE4\uFF1A${command}

${USAGE}`);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
