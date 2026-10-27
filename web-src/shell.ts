/**
 * 独立控制台外壳：登录 / 密码本 / Excel 导出 + 「服务入口」面板。
 *
 * 面板本体在 `panel.ts`，与 AIO 内嵌页共用同一份实现；这里只放独立部署才有的东西
 * （cookie 登录、密码本、导出下载）和 fetch 版 transport。
 */
import {ServicePanel} from './panel.js';
import type {Directory, DnsAccount, Publication} from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const words: Record<string, string> = {
  subtitle: '服务入口管理', logout: '退出登录', welcome: '连接你的服务', account: '账号', password: '密码', login: '登录',
  services: '服务入口', alias: '域名别名', domain: '域名', actions: '操作', empty: '还没有服务，点击「登记服务」开始。',
  edit: '编辑', remove: '删除', save: '保存', close: '关闭', devices: '配对设备', device: '设备', accounts: 'DNS 账号',
  add: '登记服务', refresh: '刷新', applied: '配置已应用', failed: '请求失败', applying: '正在发布配置…',
  online: '在线', offline: '离线', configured: '凭据已配置', saved: '已保存', success: '成功', running: '发布中', pending: '等待发布',
  vault: '密码本', vaultSearch: '搜索名称 / 分类 / 账号 / 地址', vaultEmpty: '还没有登记凭据，填写下面表单保存第一条。',
  vaultSave: '保存条目', name: '名称', category: '分类', address: '地址', username: '账号', note: '备注', reveal: '查看并复制',
  copied: '密码已复制到剪贴板', vaultRemoveConfirm: '删除这条凭据？删除后无法恢复。', vaultSaved: '凭据已加密保存', vaultKeep: '留空保留原密码',
  exportServices: '导出 Excel', exportVault: '导出密码本', exportVaultSecrets: '导出（含明文）', exportStarted: '已开始下载导出文件',
  exportSecretsConfirm: '导出的 Excel 里会包含全部明文密码。确认导出到本机并妥善保管？', accountSaved: 'DNS 账号已加密保存',
  serviceCount: '项服务', tcp: 'TCP', managedTcp: '现有 TCP 入口', copiedAddress: '连接地址已复制', pendingApply: '待应用',
};

interface VaultItem {id: string; name: string; category?: string; url?: string; username?: string; note?: string; password?: string}

let domain = '';
let publishing = false;

function message(text: string, error = false): void {
  const node = $('message');
  node.textContent = text;
  node.className = error ? 'error' : 'success';
  node.hidden = false;
}

/** 同一份页面有三种落地方式：独立站（cookie 登录）、AIO 宿主内嵌（window.aioPlugin 代理）、
 *  以及设备助手的 `space-tunnels` 页（那份用的是 web-src/panel.ts 的副本 + 自己的桥）。
 *  这里只处理前两种：宿主注入 aioPlugin 时改走宿主代理，登录与导出按钮都不出现。 */
const hosted = typeof (window as unknown as {aioPlugin?: {json<T>(method: string, path: string, data?: unknown): Promise<T>}}).aioPlugin !== 'undefined';

async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  if (hosted) {
    return (window as unknown as {aioPlugin: {json<T>(method: string, path: string, data?: unknown): Promise<T>}}).aioPlugin.json<T>(method, path, data);
  }
  const response = await fetch(path, {method, credentials: 'same-origin', headers: data === undefined ? {} : {'content-type': 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data)});
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) { showLogin(); }
    throw new Error(value.error || words.failed);
  }
  return value as T;
}

function showLogin(): void { $('login').hidden = false; $('workspace').hidden = true; $('logout').hidden = true; }

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 回退到临时输入框 */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try { return document.execCommand('copy'); } finally { area.remove(); }
}

const panel: ServicePanel = new ServicePanel({
  api: (method, path, body) => api(path, method, body),
  refresh: async () => { await load(); },
  // 独立站没有设备隧道，「连接方式」不会切到这个分支。
  onRegister: (): void => { message('此入口不支持设备隧道登记', true); },
  confirm: (text, label, run) => {
    if (!window.confirm(`${text}\n\n${label}？`)) { return; }
    void run().catch(error => message(error instanceof Error ? error.message : words.failed, true));
  },
  deviceFilter: () => '',
  caps: {edges: true, dnsMode: true, status: false, devices: true, accounts: true, consolidation: false, note: true, deviceTunnel: false},
}, {mount: $('panel-mount')});

async function load(): Promise<void> {
  const [registry, deviceList, accountList] = await Promise.all([
    api<{domain: string; items: Directory['registry']['items']; status: Publication | null}>('/api/services'),
    api<{items: Directory['devices']['items']}>('/api/devices'),
    api<{items: DnsAccount[]}>('/api/accounts'),
  ]);
  domain = registry.domain;
  $('login').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = hosted;
  // 首次进页面会先吃到 401 提示，登录成功后要清掉。
  const notice = $('message');
  if (!notice.classList.contains('error')) { notice.textContent = ''; notice.hidden = true; }
  // 宿主只能回 JSON，Excel 下载只在独立控制台可用。
  $('export-button').hidden = hosted;
  $('vault-export').hidden = hosted;
  $('vault-export-secrets').hidden = hosted;
  $('domain').textContent = `${domain} · ${registry.items.length} ${words.serviceCount}`;
  // 先回灌目录再取行：panel.rows() 依赖 load() 里的设备/账号/发布状态。
  panel.load({registry: {domain, items: registry.items, status: registry.status}, devices: deviceList, accounts: accountList});
  $('rows').replaceChildren(...panel.rows());
  $('empty').hidden = registry.items.length > 0;
}

// ---- 密码本 ----------------------------------------------------------------
let vaultItems: VaultItem[] = [];
let vaultEditing = '';

function vaultMatches(item: VaultItem, query: string): boolean {
  if (!query) { return true; }
  return [item.name, item.category, item.username, item.url, item.note].join(' ').toLowerCase().includes(query.toLowerCase());
}

function renderVault(): void {
  const query = ($('vault-search') as HTMLInputElement).value.trim();
  const rows = $('vault-rows');
  rows.replaceChildren();
  const shown = vaultItems.filter(item => vaultMatches(item, query));
  $('vault-empty').hidden = shown.length > 0;
  for (const item of shown) {
    const row = document.createElement('tr');
    for (const value of [item.name, item.category || '—', item.url || '—', item.username || '—']) {
      const cell = document.createElement('td');
      cell.textContent = value ?? '';
      row.append(cell);
    }
    const actions = document.createElement('td');
    actions.append(button(words.reveal, () => { void revealVault(item); }));
    actions.append(button(words.edit, () => editVault(item)));
    actions.append(button(words.remove, () => {
      if (!window.confirm(words.vaultRemoveConfirm)) { return; }
      void api(`/api/vault/${encodeURIComponent(item.id)}`, 'DELETE').then(async () => { await refreshVault(); message(words.saved); }).catch(error => message(error.message, true));
    }));
    row.append(actions);
    row.title = item.note || '';
    rows.append(row);
  }
}

async function refreshVault(): Promise<void> {
  const data = await api<{items: VaultItem[]}>('/api/vault');
  vaultItems = data.items || [];
  renderVault();
}

function editVault(item: VaultItem): void {
  const form = $('vault-form') as HTMLFormElement;
  form.reset();
  vaultEditing = item.id;
  for (const key of ['name', 'category', 'url', 'username', 'note']) {
    (form.elements.namedItem(key) as HTMLInputElement).value = (item[key as keyof VaultItem] as string) || '';
  }
  (form.elements.namedItem('password') as HTMLInputElement).placeholder = words.vaultKeep;
  (form.elements.namedItem('name') as HTMLInputElement).focus();
}

async function revealVault(item: VaultItem): Promise<void> {
  try {
    const value = await api<{password: string}>('/api/vault/reveal', 'POST', {id: item.id});
    const done = await copyText(value.password);
    message(done ? `${words.copied} · ${item.name}` : `${item.name} 的密码需要手动复制`, !done);
  } catch (error) { message((error as Error).message, true); }
}

function button(label: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.onclick = action;
  return node;
}

// ---- 接线 ------------------------------------------------------------------
for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) { node.textContent = words[node.dataset.i18n!] ?? ''; }
for (const node of document.querySelectorAll<HTMLElement>('[data-close]')) { node.onclick = () => $<HTMLDialogElement>(node.dataset.close!).close(); }

panel.toolbar($('panel-tools'));
$('refresh').onclick = () => { void load().catch(error => message((error as Error).message, true)); };

($('vault-form') as HTMLFormElement).onsubmit = event => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = Object.fromEntries(new FormData(form)) as Record<string, unknown>;
  if (vaultEditing) { data.id = vaultEditing; }
  void api('/api/vault', 'PUT', data)
    .then(async () => {
      form.reset(); vaultEditing = '';
      (form.elements.namedItem('password') as HTMLInputElement).placeholder = '';
      await refreshVault(); message(words.vaultSaved);
    })
    .catch(error => message(error.message, true));
};

$('vault-button').onclick = () => {
  const form = $('vault-form') as HTMLFormElement;
  form.reset(); vaultEditing = '';
  ($('vault-search') as HTMLInputElement).value = '';
  (form.elements.namedItem('password') as HTMLInputElement).placeholder = '';
  void refreshVault().then(() => $<HTMLDialogElement>('vault-dialog').showModal()).catch(error => message(error.message, true));
};
$('vault-search').oninput = () => { if (vaultItems.length) { renderVault(); } };

function downloadExport(query = ''): void {
  const link = document.createElement('a');
  link.href = `/api/export.xlsx${query}`;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  message(words.exportStarted);
}
$('export-button').onclick = () => downloadExport();
$('vault-export').onclick = () => downloadExport();
$('vault-export-secrets').onclick = () => {
  if (!window.confirm(words.exportSecretsConfirm)) { return; }
  downloadExport('?secrets=1');
};

($('login-form') as HTMLFormElement).onsubmit = event => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  void api('/api/login', 'POST', Object.fromEntries(new FormData(form)))
    .then(async () => { form.reset(); await load(); $('message').hidden = true; })
    .catch(error => message(error.message, true));
};
$('logout').onclick = () => {
  void api('/api/logout', 'POST', {}).then(() => showLogin()).catch(error => message(error.message, true));
};

void load().catch(error => message((error as Error).message, true));
