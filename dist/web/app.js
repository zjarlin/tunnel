const words = {
  subtitle: '服务入口管理', logout: '退出登录', welcome: '连接你的服务', account: '账号', password: '密码', login: '登录',
  services: '服务管理', apply: '应用配置', alias: '域名别名', target: '目标主机', port: '端口', scheme: '协议', visibility: '访问范围',
  internal: '仅内网', public: '公网', note: '备注', save: '保存', domain: '域名', actions: '操作', empty: '还没有服务，填写上方表格开始登记。',
  integration: 'API / AIO sidecar', edit: '编辑', remove: '删除', removeConfirm: '删除此服务登记？应用配置后生效。',
  saved: '已保存，点击「应用配置」发布。', applied: '配置已应用', failed: '请求失败', applying: '正在应用…',
};
document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = words[node.dataset.i18n]; });
const $ = id => document.getElementById(id);
const hosted = Boolean(window.aioPlugin);

function message(text, error = false) {
  $('message').textContent = text;
  $('message').className = error ? 'error' : 'success';
  $('message').hidden = false;
}

async function api(path, method = 'GET', data) {
  if (hosted) { return window.aioPlugin.json(method, path, data); }
  const response = await fetch(path, {method, credentials: 'same-origin', headers: data === undefined ? {} : {'content-type': 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data)});
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) { $('login').hidden = false; $('workspace').hidden = true; $('logout').hidden = true; }
    throw new Error(value.error || words.failed);
  }
  return value;
}

async function refresh() {
  const {items, domain} = await api('/api/services');
  $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = hosted;
  $('domain').textContent = domain;
  $('rows').replaceChildren(); $('empty').hidden = items.length > 0;
  for (const item of items) {
    const row = document.createElement('tr');
    const values = [`${item.alias}.${domain}`, `${item.scheme}://${item.host}:${item.port}`, words[item.visibility], item.note];
    for (const [index, value] of values.entries()) {
      const cell = document.createElement('td'); cell.textContent = value;
      if (index === 2) { cell.className = `scope ${item.visibility}`; }
      row.append(cell);
    }
    const actions = document.createElement('td'); actions.className = 'actions';
    const edit = document.createElement('button'); edit.textContent = words.edit;
    edit.onclick = () => {
      for (const key of ['alias', 'host', 'port', 'scheme', 'visibility', 'note']) { $('service-form').elements[key].value = item[key] ?? ''; }
      $('service-form').elements.host.focus();
    };
    const remove = document.createElement('button'); remove.textContent = words.remove;
    remove.onclick = async () => {
      if (!confirm(words.removeConfirm)) { return; }
      try { await api(`/api/services/${encodeURIComponent(item.alias)}`, 'DELETE'); await refresh(); message(words.saved); }
      catch (error) { message(error.message, true); }
    };
    actions.append(edit, remove); row.append(actions); $('rows').append(row);
  }
}

$('login-form').onsubmit = async event => {
  event.preventDefault();
  try { await api('/api/login', 'POST', Object.fromEntries(new FormData(event.target))); event.target.reset(); await refresh(); $('message').hidden = true; }
  catch (error) { message(error.message, true); }
};
$('service-form').onsubmit = async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target)); data.port = Number(data.port);
  try { await api('/api/services', 'PUT', data); event.target.reset(); await refresh(); message(words.saved); }
  catch (error) { message(error.message, true); }
};
$('apply').onclick = async () => {
  $('apply').disabled = true; message(words.applying);
  try { const report = await api('/api/apply', 'POST', {}); message(`${words.applied} · ${report.routes.length}`); }
  catch (error) { message(error.message, true); }
  finally { $('apply').disabled = false; }
};
$('logout').onclick = async () => {
  try { await api('/api/logout', 'POST', {}); $('workspace').hidden = true; $('login').hidden = false; $('logout').hidden = true; }
  catch (error) { message(error.message, true); }
};
refresh().catch(error => { if (hosted) { message(error.message, true); } });
