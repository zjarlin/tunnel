const words = {
  subtitle:'服务入口管理', logout:'退出登录', welcome:'连接你的服务', account:'账号', password:'密码', login:'登录', services:'服务入口', apply:'应用配置', alias:'域名别名', target:'目标主机 / 子网地址', port:'端口', scheme:'协议', visibility:'访问范围', internal:'仅内网', public:'公网', note:'备注', save:'保存', domain:'域名', actions:'操作', empty:'还没有服务，点击「添加服务」开始。', edit:'编辑', remove:'删除', removeConfirm:'删除服务并撤下代理和本系统管理的 DNS？', applied:'配置已应用', failed:'请求失败', applying:'正在发布配置…', devices:'配对设备', device:'设备', accounts:'DNS 账号', dnsAccount:'DNS 账号', add:'添加服务', service:'服务配置', close:'关闭', suffix:'域名后缀', saveApply:'保存并应用', status:'配对状态', meshAddress:'EasyTier 地址 / 主机名', devicesEmpty:'当前账号还没有配对设备。请先在设备助手完成配对。', accountId:'账号标识', label:'名称', provider:'厂商', zone:'Zone ID（可留空自动查询）', rawHost:'灰云入口', direct:'入口直接可达的主机', defaultAccount:'默认账号 / 仅内网', online:'在线', offline:'离线', configured:'凭据已配置', saved:'已保存', success:'成功', running:'发布中', configuredHost:'设备本机', bindRequired:'未绑定地址', revoked:'设备已撤销或不可见', accountSaved:'DNS 账号已加密保存', pending:'等待发布',
};
const $ = id => document.getElementById(id);
Object.assign(words, {dnsMode:'DNS 方式', managed:'自动管理 DNS', existing:'保留现有公网 DNS', removeExistingConfirm:'删除本地登记与代理？原公网入口和 DNS 会保留，需要在原入口单独关闭。'});
Object.assign(words, {transport:'连接方式', easytier:'EasyTier / 直连', frp:'FRP 映射', frpHost:'FRP 映射地址', frpPort:'FRP 映射端口', frpPlaceholder:'127.0.0.1 或中转主机名', devicePlaceholder:'留空使用设备本机', frpRemoveConfirm:'已有 FRP 映射仍由原系统管理，需要在原系统单独关闭。', tlsServerName:'上游 TLS 主机名'});
Object.assign(words, {copy:'复制地址', copied:'连接地址已复制', open:'打开', tcp:'TCP', managedTcp:'现有 TCP 入口', serviceCount:'项服务', refresh:'刷新'});
document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = words[node.dataset.i18n]; });
document.querySelectorAll('[data-close]').forEach(node => { node.onclick = () => $(node.dataset.close).close(); });
const hosted = Boolean(window.aioPlugin);
let devices = [], accounts = [], domain = '', publishing = false;
function message(text, error = false) { $('message').textContent = text; $('message').className = error ? 'error' : 'success'; $('message').hidden = false; }
async function api(path, method = 'GET', data) {
  if (hosted) { return window.aioPlugin.json(method, path, data); }
  const response = await fetch(path, {method, credentials:'same-origin', headers:data === undefined ? {} : {'content-type':'application/json'}, body:data === undefined ? undefined : JSON.stringify(data)});
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) { $('login').hidden = false; $('workspace').hidden = true; $('logout').hidden = true; }
    throw new Error(value.error || words.failed);
  }
  return value;
}
function option(value, text) { const node = document.createElement('option'); node.value = value; node.textContent = text; return node; }
function button(text, action) { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.onclick = action; return node; }
function cells(values) { const row = document.createElement('tr'); for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } return row; }
function showStatus(status) {
  $('publication').textContent = status ? `${new Date(status.at).toLocaleString()} · ${(status.steps || []).map(item => `${item.step}：${words[item.state] || item.state}${item.detail ? `（${item.detail}）` : ''}`).join(' → ')}` : words.pending;
  $('publication').className = status?.state === 'failed' ? 'error' : '';
}
function connectionFields() {
  const form = $('service-form');
  const frp = form.elements.transport.value === 'frp';
  $('target-label').textContent = words[frp ? 'frpHost' : 'target'];
  $('port-label').textContent = words[frp ? 'frpPort' : 'port'];
  form.elements.host.placeholder = words[frp ? 'frpPlaceholder' : 'devicePlaceholder'];
  form.elements.host.required = frp || !form.elements.deviceId.value;
  const https = form.elements.scheme.value === 'https';
  $('tls-server-name').hidden = !https;
  form.elements.tlsServerName.disabled = !https;
  form.elements.tlsServerName.required = https && frp;
  for (const option of $('device-select').options) {
    const device = devices.find(item => item.id === option.value);
    if (device) { option.textContent = `${device.label} · ${words[device.status] || device.status}${!frp && !device.address ? ` · ${words.bindRequired}` : ''}`; }
  }
}
async function refresh() {
  const [registry, deviceList, accountList] = await Promise.all([api('/api/services'), api('/api/devices'), api('/api/accounts')]);
  devices = deviceList.items; accounts = accountList.items; domain = registry.domain;
  $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = hosted; $('domain').textContent = `${domain} · ${registry.items.length} ${words.serviceCount}`;
  $('rows').replaceChildren(); $('empty').hidden = registry.items.length > 0;
  $('device-select').replaceChildren(option('', words.direct), ...devices.map(item => option(item.id, `${item.label} · ${words[item.status] || item.status}${item.address ? '' : ` · ${words.bindRequired}`}`)));
  $('account-select').replaceChildren(option('', words.defaultAccount), ...accounts.map(item => option(item.id, `${item.label} · ${item.domain}`)));
  for (const item of registry.items) {
    const device = devices.find(entry => entry.id === item.deviceId);
    const hostname = `${item.alias}.${item.domain || domain}`;
    const endpoint = item.scheme === 'tcp' ? `${hostname}:${item.port}` : `https://${hostname}/`;
    const row = cells([item.scheme === 'tcp' ? endpoint : hostname, item.deviceLabel || (item.deviceId ? device?.label || words.revoked : words.direct), item.scheme === 'tcp' ? words.tcp : words[item.transport || 'easytier'], `${item.scheme}://${item.host || device?.address || words.configuredHost}:${item.port}`, words[item.visibility], words[item.dnsMode || 'managed'], item.note]);
    const actions = document.createElement('td'); actions.className = 'actions';
    actions.append(button(words.copy, async () => {
      try { await navigator.clipboard.writeText(endpoint); message(words.copied); } catch (error) { message(`${endpoint} · ${error.message}`, true); }
    }));
    if (item.readOnly) {
      const label = document.createElement('span'); label.textContent = words.managedTcp; actions.append(label);
      row.append(actions); $('rows').append(row); continue;
    }
    const link = document.createElement('a'); link.href = endpoint; link.textContent = words.open; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link);
    actions.append(button(words.edit, () => {
      const form = $('service-form'); form.reset();
      for (const key of ['alias','domain','deviceId','accountId','dnsMode','transport','tlsServerName','host','port','scheme','visibility','note']) { form.elements[key].value = item[key] ?? ({domain, dnsMode:'managed', transport:'easytier'}[key] || ''); }
      form.elements.alias.readOnly = true; connectionFields(); $('service-dialog').showModal();
    }), button(words.remove, async () => {
      const confirmation = item.dnsMode === 'existing' ? words.removeExistingConfirm : words.removeConfirm;
      if (!confirm(confirmation + (item.transport === 'frp' ? `\n${words.frpRemoveConfirm}` : ''))) { return; }
      try { await api(`/api/services/${encodeURIComponent(item.alias)}`, 'DELETE'); await refresh(); await publish(); } catch (error) { message(error.message, true); }
    })); row.append(actions); $('rows').append(row);
  }
  showStatus(registry.status);
}
async function publish() {
  if (publishing) { return; }
  publishing = true; $('apply').disabled = true; message(words.applying);
  try {
    await api('/api/publications', 'POST', {});
    for (let attempt = 0; attempt < 150; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const status = await api('/api/publications'); showStatus(status);
      if (status?.state === 'failed') { throw new Error(status.steps.at(-1)?.detail || words.failed); }
      if (status?.routes) { message(`${words.applied} · ${status.routes.length}`); return; }
    }
    throw new Error('发布仍在处理，请查看发布状态');
  } finally { publishing = false; $('apply').disabled = false; }
}
$('new-service').onclick = () => { $('service-form').reset(); $('service-form').elements.alias.readOnly = false; $('service-form').elements.domain.value = domain; connectionFields(); $('service-dialog').showModal(); };
$('service-form').elements.transport.onchange = connectionFields;
$('service-form').elements.scheme.onchange = connectionFields;
$('device-select').onchange = connectionFields;
$('account-select').onchange = event => { const account = accounts.find(item => item.id === event.target.value); if (account) { $('service-form').elements.domain.value = account.domain; } };
$('service-form').onsubmit = async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); data.port = Number(data.port);
  try { await api('/api/services', 'PUT', data); $('service-dialog').close(); await refresh(); await publish(); } catch (error) { message(error.message, true); }
};
$('apply').onclick = () => publish().catch(error => message(error.message, true));
$('refresh').onclick = () => refresh().catch(error => message(error.message, true));
$('devices-button').onclick = async () => {
  try {
    await refresh(); $('device-rows').replaceChildren(); $('devices-empty').hidden = devices.length > 0;
    for (const device of devices) {
      const row = cells([device.label, words[device.status] || device.status]); const cell = document.createElement('td'); const address = document.createElement('input'); address.value = device.address || ''; address.setAttribute('aria-label', `${device.label} ${words.meshAddress}`); cell.append(address); row.append(cell);
      const actions = document.createElement('td'); actions.append(button(words.save, async () => { try { await api('/api/devices', 'PUT', {id:device.id, address:address.value}); message(words.saved); await refresh(); } catch (error) { message(error.message, true); } })); row.append(actions); $('device-rows').append(row);
    }
    $('devices-dialog').showModal();
  } catch (error) { message(error.message, true); }
};
$('accounts-button').onclick = () => {
  $('account-form').reset(); $('account-list').replaceChildren();
  for (const account of accounts) { $('account-list').append(button(`${account.label} · ${account.domain} · ${words.configured}`, () => { $('account-form').reset(); for (const key of ['id','label','provider','domain','zone','rawHost']) { $('account-form').elements[key].value = account[key] || ''; } })); }
  $('accounts-dialog').showModal();
};
$('account-form').elements.domain.oninput = event => { $('account-form').elements.rawHost.value = `raw.${event.target.value}`; };
$('account-form').onsubmit = async event => { event.preventDefault(); try { await api('/api/accounts', 'PUT', Object.fromEntries(new FormData(event.target))); event.target.reset(); $('accounts-dialog').close(); await refresh(); message(words.accountSaved); } catch (error) { message(error.message, true); } };
$('login-form').onsubmit = async event => { event.preventDefault(); try { await api('/api/login', 'POST', Object.fromEntries(new FormData(event.target))); event.target.reset(); await refresh(); $('message').hidden = true; } catch (error) { message(error.message, true); } };
$('logout').onclick = async () => { try { await api('/api/logout', 'POST', {}); $('workspace').hidden = true; $('login').hidden = false; $('logout').hidden = true; } catch (error) { message(error.message, true); } };
refresh().catch(error => { if (hosted) { message(error.message, true); } });
