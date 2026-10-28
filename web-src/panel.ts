/**
 * 「服务入口」面板：表格 + 登记/编辑 + 配对设备 + DNS 账号 + 发布状态。
 *
 * 这是唯一实现。`tunnel.addzero.site` 独立控制台与 `aio.addzero.site/?page=space-tunnels`
 * 内嵌页都用它，只在两处不同：
 *   1) host.api —— 独立站是 `fetch('/api/*')` + cookie；AIO 页转成宿主代理请求；
 *   2) caps    —— 独立站有密码本/导出、无设备隧道；AIO 页反过来。
 * 面板自己创建全部 DOM（含弹窗），壳只需要提供一个挂载点和几个回调。
 */
import type {Directory, DnsAccount, DomainDevice, DomainService, Publication} from './types.js';

/** 面板上哪些列/按钮参与渲染：不是"权限"，而是这个部署方式支持什么。 */
export interface PanelCaps {
  /** 入口归属列（localmesh / home-edge）。 */
  edges: boolean;
  /** DNS 方式列（自动管理 / 保留现有公网 DNS）。 */
  dnsMode: boolean;
  /** 发布状态列（已应用 / 待应用）。 */
  status: boolean;
  /** 配对设备弹窗（中继地址与发布节点）。 */
  devices: boolean;
  /** DNS 账号弹窗。 */
  accounts: boolean;
  /** 旧菜单合并按钮（只在 AIO 里有旧菜单要收）。 */
  consolidation: boolean;
  /** 备注列（独立控制台有，AIO 表格没有这一列）。 */
  note: boolean;
  /** AIO 有设备代理，工具栏多一个「登记设备隧道」入口；独立站没有。 */
  deviceTunnel: boolean;
}

export interface PanelHost {
  /** 统一按 HTTP 语义发起请求，壳负责换成 fetch 或宿主代理。 */
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** 数据变化后让壳重新读取并回灌 `load`。 */
  refresh(): Promise<void>;
  /** 登记设备隧道：只在 caps.deviceTunnel 时由工具栏调用，壳负责开自己的弹窗。 */
  onRegister(): void;
  /** 危险操作统一走壳的确认弹窗（AIO 是 dialog，独立站是 confirm）。 */
  confirm(text: string, label: string, run: () => Promise<unknown>): void;
  /** 当前页头筛选的设备 ID，空串表示不筛选。 */
  deviceFilter(): string;
  /** 收拢旧菜单入口：AIO 侧才有（宿主提供的目录操作），独立站不实现。 */
  consolidate?(): Promise<unknown>;
  /** 配对设备弹窗里的部署专属补充（AIO 用来编辑设备 SSH 别名）。 */
  deviceExtras?(device: DomainDevice, group: HTMLElement): void;
  caps?: Partial<PanelCaps>;
}

const DEFAULTS: PanelCaps = {edges: true, dnsMode: true, status: false, devices: true, accounts: true, consolidation: false, note: true, deviceTunnel: false};

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const option = (value: string, label: string): HTMLOptionElement => {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
};
const field = (form: HTMLFormElement, name: string): HTMLInputElement | HTMLSelectElement =>
  form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
const cell = (text: string): HTMLTableCellElement => {
  const node = document.createElement('td');
  node.className = 'data-table-cell';
  node.textContent = text;
  node.title = text;
  return node;
};

/** 生成一段静态标记，避免两个壳各写一份弹窗 HTML。 */
function markup(): string {
  return `
<p id="domain-status" role="status" aria-live="polite"></p>
<dialog id="domain-editor"><form id="domain-form"><h2>登记服务</h2>
<div class="field"><div class="field-label">目标怎么填<details class="hint" id="transport-hint"><summary aria-label="目标主机怎么填">?</summary><p class="hint-body">选设备、目标留空 → 服务就跑在这台设备上；选设备、填地址 → 服务在设备能访问到的另一个地址上；不选设备 → 服务在入口本机或任意可达地址上。</p></details></div><select name="transport" aria-hidden="true" hidden><option value="easytier">设备中继</option><option value="frp">FRP 映射（遗留）</option></select></div>
<label>设备<select name="deviceId"></select></label>
<div class="field-grid"><label>域名别名<input name="alias" pattern="[a-z0-9][a-z0-9-]{0,62}" required></label><label>域名后缀<input name="domain" placeholder="example.test" required></label></div>
<label>DNS 账号<select name="accountId"></select></label>
<div class="field-grid"><label>访问范围<select name="visibility"><option value="internal">仅内网</option><option value="public">公网</option></select></label><label>DNS 方式<select name="dnsMode"><option value="managed">自动管理</option><option value="existing">保留现有公网 DNS</option></select></label></div>
<label><span id="domain-host-label">目标主机 / 子网地址</span><input name="host" placeholder="选择设备后可留空使用设备本机"></label>
<div class="field-grid"><label><span id="domain-port-label">目标端口</span><input name="port" type="number" min="1" max="65535" required></label><label>目标协议<select name="scheme"><option value="http">HTTP</option><option value="https">HTTPS</option></select></label></div>
<label id="domain-tls" hidden>上游 TLS 主机名<input name="tlsServerName"></label><label>备注<input name="note" maxlength="300"></label>
<p id="domain-validation" role="alert"></p><div class="actions"><button id="domain-save" type="submit">保存并应用</button><button type="button" class="outline" data-domain-close="domain-editor">关闭</button></div>
</form></dialog>
<dialog id="dns-dialog"><h2>DNS 账号</h2><div id="dns-list" class="actions"></div><form id="dns-form" autocomplete="off">
<div class="field-grid"><label>账号标识<input name="id" required></label><label>名称<input name="label" required></label></div>
<label>厂商<select name="provider"><option value="huawei">华为云</option><option value="dnspod">腾讯云 DNSPod</option><option value="cloudflare">Cloudflare</option></select></label>
<div class="field-grid"><label>域名<input name="domain" required></label><label>灰云入口<input name="rawHost" required></label></div>
<label>Zone ID<input name="zone" placeholder="留空自动查询"></label><label>AK / Secret ID<input name="key" type="password" autocomplete="new-password" placeholder="留空保留原凭据"></label><label>SK / Token<input name="secret" type="password" autocomplete="new-password" placeholder="留空保留原凭据"></label>
<p id="dns-validation" role="alert"></p><div class="actions"><button id="dns-save" type="submit">保存账号</button><button type="button" class="outline" data-domain-close="dns-dialog">关闭</button></div></form></dialog>
<dialog id="mesh-dialog"><h2>配对设备地址</h2><div id="mesh-devices"></div><button type="button" class="outline" data-domain-close="mesh-dialog">关闭</button></dialog>`;
}

export class ServicePanel {
  private data: Directory | null = null;
  private publishing = false;
  private readonly caps: PanelCaps;
  private readonly form: HTMLFormElement;
  constructor(private readonly host: PanelHost, options: {mount?: HTMLElement} = {}) {
    this.caps = {...DEFAULTS, ...host.caps};
    const template = document.createElement('template');
    template.innerHTML = markup();
    const dialogs: HTMLDialogElement[] = [];
    const inline: Node[] = [];
    for (const node of Array.from(template.content.childNodes)) {
      if (node.nodeName === 'DIALOG') { dialogs.push(node as HTMLDialogElement); } else { inline.push(node); }
    }
    // 弹窗统一挂到 body：面板可能被放进滚动容器或隐藏的工作区，dialog 不该继承那层布局。
    document.body.append(...dialogs);
    (options.mount ?? document.body).append(...inline);
    this.form = el<HTMLFormElement>('domain-form');
    this.wire();
  }

  private wire(): void {
    this.form.onsubmit = event => { event.preventDefault(); void this.save(); };
    field(this.form, 'transport').onchange = () => { this.hint(false); this.connection(); };
    field(this.form, 'scheme').onchange = () => this.connection();
    field(this.form, 'deviceId').onchange = () => this.connection();
    field(this.form, 'accountId').onchange = () => {
      const account = this.data?.accounts.items.find(item => item.id === field(this.form, 'accountId').value);
      if (account) { field(this.form, 'domain').value = account.domain; }
    };
    el<HTMLFormElement>('dns-form').onsubmit = event => { event.preventDefault(); void this.saveAccount(); };
    // 说明浮层会挡住下方字段，点空白处或按 Esc 收起。
    document.addEventListener('click', event => {
      const hint = this.hintElement();
      if (hint?.open && !hint.contains(event.target as Node)) { hint.open = false; }
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { this.hint(false); } });
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-domain-close]')) {
      button.onclick = () => el<HTMLDialogElement>(button.dataset.domainClose!).close();
    }
  }

  /** 工具栏按钮：壳决定放哪里，按钮集合由能力开关决定。 */
  toolbar(target: HTMLElement): void {
    // 两种登记是两条链路，界面上分成两个按钮，不靠隐藏的下拉切换。
    const add = this.button(this.caps.deviceTunnel ? '登记域名入口' : '登记服务', () => this.create());
    const apply = this.button('应用配置', () => { void this.publish(); }, 'primary');
    target.append(add);
    if (this.caps.deviceTunnel) { target.append(this.button('登记设备隧道', () => this.host.onRegister())); }
    if (this.caps.devices) { target.append(this.button('配对设备', () => { void this.devices(); })); }
    if (this.caps.accounts) { target.append(this.button('DNS 账号', () => this.accounts())); }
    if (this.caps.consolidation && this.host.consolidate) {
      target.append(this.button('合并旧菜单', () => {
        void this.host.consolidate!().catch(error => this.message(error instanceof Error ? error.message : '操作失败', true));
      }));
    }
    target.append(apply);
  }

  get available(): boolean { return this.data !== null; }

  /** 壳每次刷新后回灌一次完整目录。 */
  load(data: Directory | null): void {
    this.data = data;
    if (!data) { return; }
    const devices = field(this.form, 'deviceId') as HTMLSelectElement;
    devices.replaceChildren(option('', '入口直接可达的主机'), ...data.devices.items.map(item => option(item.id, `${item.label} · ${item.status === 'online' ? '在线' : '离线'}`)));
    const accounts = field(this.form, 'accountId') as HTMLSelectElement;
    accounts.replaceChildren(option('', '不使用云 DNS 账号'), ...data.accounts.items.map(item => option(item.id, `${item.label} · ${item.domain}`)));
    if (!this.publishing) { this.showPublication(data.registry.status); }
    if (data.navigationWarning) { this.message(data.navigationWarning, true); }
  }

  error(error: unknown): void {
    this.data = null;
    this.message(error instanceof Error ? error.message : '域名服务读取失败', true);
  }

  message(text: string, isError = false): void {
    const node = el('domain-status');
    node.textContent = text;
    node.className = isError ? 'error' : '';
  }

  showPublication(status: Publication | null): void {
    if (!status) { this.message('域名服务尚未应用'); return; }
    const stepText = (status.steps ?? []).map(item => `${item.step}：${item.detail || ({success: '成功', running: '处理中', failed: '失败'} as Record<string, string>)[item.state] || item.state}`).join(' → ');
    this.message(stepText, status.state === 'failed');
  }

  /** 表格行。`filter` 为设备 ID 时只保留该设备上的域名入口。 */
  rows(filter = ''): HTMLTableRowElement[] {
    if (!this.data) { return []; }
    const data = this.data;
    const items = filter ? data.registry.items.filter(item => item.deviceId === filter) : data.registry.items;
    return items.map(item => {
      const device = data.devices.items.find(entry => entry.id === item.deviceId);
      const domain = item.suffix || item.domain || data.registry.domain;
      const host = `${item.alias}.${domain}`;
      const address = item.scheme === 'tcp' ? `${host}:${item.port}` : `https://${host}/`;
      const row = document.createElement('tr');
      row.className = 'data-table-row';
      row.dataset.service = `domain:${item.alias}`;
      // 逐列构造而不是先拼字符串数组：地址列要放链接，按 index 回填容易和列开关错位。
      const nodes: HTMLTableCellElement[] = [cell(item.alias)];
      if (this.caps.edges) { nodes.push(cell(this.edgeLabel(item))); }
      nodes.push(cell(item.deviceLabel || device?.label || '入口本机'));
      // 连接方式不对外暴露实现名：用户只关心「经设备中继」还是「入口本机」，FRP 是遗留入口才点名。
      nodes.push(cell(item.scheme === 'tcp' ? 'TCP' : item.transport === 'frp' ? 'FRP 映射（遗留）' : item.deviceId ? '设备中继' : '—'));
      nodes.push(cell(`${item.scheme}://${item.host || device?.address || '设备本机'}:${item.port}`));
      // 连接地址列：HTTP(S) 直接就是链接，点网址即打开；TCP 是 host:port，不是可点地址。
      nodes.push(item.scheme === 'tcp' ? cell(address) : this.linkCell(address));
      nodes.push(cell(item.visibility === 'public' ? '公网' : '仅内网'));
      if (this.caps.dnsMode) { nodes.push(cell(item.dnsMode === 'existing' ? '保留现有 DNS' : '自动管理')); }
      if (this.caps.status) {
        nodes.push(cell(item.readOnly ? '现有 TCP 入口' : data.registry.status?.routes?.includes(item.alias) ? '已应用' : '待应用'));
      }
      if (this.caps.note) { nodes.push(cell(item.note ?? '')); }
      row.append(...nodes);

      const actions = document.createElement('td');
      actions.className = 'data-table-cell data-table-align-end actions';
      // 不再单独给「打开」按钮：地址列点一下就是打开，操作列只留动作。
      actions.append(this.button('复制地址', () => { void this.copy(address); }));
      if (!item.readOnly) {
        actions.append(this.button('编辑', () => this.edit(item)));
        actions.append(this.button('删除', () => {
          const warning = item.dnsMode === 'existing' ? '原公网 DNS 和入口不会删除。' : item.transport === 'frp' ? '已有 FRP 映射不会停止。' : '';
          this.host.confirm(`删除 ${host} 的登记和代理？${warning}`, '删除服务', async () => {
            await this.host.api('DELETE', `/api/services/${encodeURIComponent(item.alias)}`);
            await this.publish();
          });
        }));
      }
      row.append(actions);
      return row;
    });
  }

  create(): void {
    if (!this.data) { this.message('服务列表尚未加载，请刷新后重试', true); return; }
    this.form.reset();
    el('domain-validation').textContent = '';
    (field(this.form, 'alias') as HTMLInputElement).readOnly = false;
    field(this.form, 'domain').value = this.data.registry.domain;
    // 页头已按设备筛选时，登记默认落在同一台设备上，避免误登到别的机器。
    const scope = this.host.deviceFilter();
    if (scope && this.data.devices.items.some(item => item.id === scope)) { field(this.form, 'deviceId').value = scope; }
    this.hint(false);
    this.connection();
    el<HTMLDialogElement>('domain-editor').showModal();
  }

  private edgeLabel(item: DomainService): string {
    const owned = item.edges?.length ? item.edges : ['home-edge'];
    const both = owned.includes('localmesh') && owned.includes('home-edge');
    return both ? '内外双入口' : owned.includes('localmesh') ? '仅 182 内网' : '仅 home-edge';
  }

  private edit(item: DomainService): void {
    this.form.reset();
    el('domain-validation').textContent = '';
    for (const name of ['alias', 'domain', 'deviceId', 'accountId', 'transport', 'dnsMode', 'scheme', 'host', 'port', 'tlsServerName', 'visibility', 'note']) {
      const value = item[name as keyof DomainService] ?? ({transport: 'easytier', dnsMode: 'managed'} as Record<string, unknown>)[name];
      field(this.form, name).value = String(value ?? '');
    }
    if (!item.domain && item.suffix) { field(this.form, 'domain').value = item.suffix; }
    (field(this.form, 'alias') as HTMLInputElement).readOnly = true;
    this.hint(false);
    this.connection();
    el<HTMLDialogElement>('domain-editor').showModal();
  }

  private hintElement(): HTMLDetailsElement | null { return document.getElementById('transport-hint') as HTMLDetailsElement | null; }
  private hint(open: boolean): void { const hint = this.hintElement(); if (hint) { hint.open = open; } }

  /** 目标字段随设备/协议联动；连接方式不再暴露给用户，只有编辑遗留 FRP 条目时才会是 frp。 */
  private connection(): void {
    const frp = field(this.form, 'transport').value === 'frp';
    el('domain-host-label').textContent = frp ? 'FRP 映射地址' : '目标主机 / 子网地址';
    el('domain-port-label').textContent = frp ? 'FRP 映射端口' : '目标端口';
    field(this.form, 'host').required = frp || !field(this.form, 'deviceId').value;
    const https = field(this.form, 'scheme').value === 'https';
    el('domain-tls').hidden = !https;
    field(this.form, 'tlsServerName').disabled = !https;
    field(this.form, 'tlsServerName').required = https && frp;
  }

  private async save(): Promise<void> {
    const submit = el<HTMLButtonElement>('domain-save');
    submit.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(this.form));
      await this.host.api('PUT', '/api/services', {...values, port: Number(values.port)});
      el<HTMLDialogElement>('domain-editor').close();
      await this.publish();
    } catch (error) {
      el('domain-validation').textContent = error instanceof Error ? error.message : '保存失败';
    } finally { submit.disabled = false; }
  }

  /** 保存后立刻发布：只有发布成功，表格里的登记才算真的生效。 */
  async publish(): Promise<void> {
    if (this.publishing) { return; }
    this.publishing = true;
    try {
      await this.host.api('POST', '/api/publications', {});
      for (let attempt = 0; attempt < 150; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const state = await this.host.api<Publication>('GET', '/api/publications');
        this.showPublication(state);
        if (state.state === 'failed') { throw new Error(state.steps?.at(-1)?.detail || '发布失败'); }
        if (state.state === 'success' || state.state === 'failed' || state.routes) { await this.host.refresh(); return; }
      }
      throw new Error('发布仍在处理中，请刷新查看结果');
    } catch (error) {
      this.message(error instanceof Error ? error.message : '发布失败', true);
    } finally { this.publishing = false; }
  }

  private accounts(): void {
    const form = el<HTMLFormElement>('dns-form');
    form.reset();
    el('dns-validation').textContent = '';
    el('dns-list').replaceChildren();
    const hints = (account?: DnsAccount) => {
      const source = account as (DnsAccount & {keyHint?: string; secretHint?: string}) | undefined;
      const hint = (name: 'key' | 'secret', fallback: string) => {
        const node = field(form, name) as HTMLInputElement;
        const value = source?.[`${name}Hint` as 'keyHint' | 'secretHint'];
        node.placeholder = value ? `已配置 ${value}，留空保留` : fallback;
        node.title = node.placeholder;
      };
      hint('key', 'AK / SecretId / Token');
      hint('secret', 'SK / SecretKey');
    };
    hints(undefined);
    for (const account of this.data?.accounts.items ?? []) {
      const masked = [(account as DnsAccount & {keyHint?: string}).keyHint && `AK ${(account as DnsAccount & {keyHint?: string}).keyHint}`, (account as DnsAccount & {secretHint?: string}).secretHint && `SK ${(account as DnsAccount & {secretHint?: string}).secretHint}`].filter(Boolean).join(' · ');
      el('dns-list').append(this.button(`${account.label} · ${account.domain}${masked ? ` · ${masked}` : ''}`, () => {
        form.reset();
        for (const name of ['id', 'label', 'provider', 'domain', 'zone', 'rawHost']) {
          field(form, name).value = String(account[name as keyof DnsAccount] ?? '');
        }
        hints(account);
      }));
    }
    el<HTMLDialogElement>('dns-dialog').showModal();
  }

  private async saveAccount(): Promise<void> {
    const form = el<HTMLFormElement>('dns-form');
    const submit = el<HTMLButtonElement>('dns-save');
    submit.disabled = true;
    try {
      await this.host.api('PUT', '/api/accounts', Object.fromEntries(new FormData(form)));
      form.reset();
      el<HTMLDialogElement>('dns-dialog').close();
      await this.host.refresh();
      this.message('DNS 账号已加密保存');
    } catch (error) {
      el('dns-validation').textContent = error instanceof Error ? error.message : '账号保存失败';
    } finally { submit.disabled = false; }
  }

  private async devices(): Promise<void> {
    const container = el('mesh-devices');
    container.textContent = '正在读取配对设备…';
    el<HTMLDialogElement>('mesh-dialog').showModal();
    try {
      const directory = await this.host.api<{items: DomainDevice[]}>('GET', '/api/devices');
      container.replaceChildren();
      if (!directory.items.length) { container.textContent = '当前账号还没有配对设备'; }
      for (const device of directory.items) {
        const group = document.createElement('section');
        const title = document.createElement('h3');
        title.textContent = `${device.label} · ${device.status === 'online' ? '在线' : '离线'}`;
        const label = document.createElement('label');
        label.textContent = '中继地址（可留空）';
        const address = document.createElement('input');
        address.value = device.address || '';
        label.append(address);
        const save = this.action('保存地址', async () => {
          await this.host.api('PUT', '/api/devices', {id: device.id, address: address.value});
          await this.host.refresh();
        });
        group.append(title, label, save);
        this.host.deviceExtras?.(device, group);
        container.append(group);
      }
    } catch (error) {
      container.textContent = error instanceof Error ? error.message : '设备读取失败';
    }
  }

  private async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.message(`已复制 ${text}`);
    } catch {
      // 非安全上下文或不给剪贴板权限时，回退到临时输入框。
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      try { document.execCommand('copy'); this.message(`已复制 ${text}`); }
      catch { this.message(text, true); }
      finally { area.remove(); }
    }
  }

  private button(label: string, action: () => void, className = 'outline'): HTMLButtonElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.textContent = label;
    node.onclick = action;
    return node;
  }

  /** 连接地址单元格：整格就是可点链接，点网址直接打开。 */
  private linkCell(href: string): HTMLTableCellElement {
    const node = document.createElement('td');
    node.className = 'data-table-cell';
    node.title = href;
    const link = document.createElement('a');
    link.href = href;
    link.textContent = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    node.append(link);
    return node;
  }

  private action(label: string, run: () => Promise<unknown>): HTMLButtonElement {
    return this.button(label, () => { void run().catch(error => this.message(error instanceof Error ? error.message : '操作失败', true)); });
  }
}
