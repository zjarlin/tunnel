import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * 独立控制台由 index.html + 构建产物 app.js 组成，而 app.js 里的面板会自己造一批 DOM。
 * 两边靠 id 约定衔接，拼错了只有浏览器里才会炸。这里静态对账：
 * app.js 引用的每个 id，必须要么在 index.html 里，要么由 app.js 自己创建。
 */
const html = readFileSync(new URL('../dist/web/index.html', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../dist/web/app.js', import.meta.url), 'utf8');

const ids = text => new Set([...text.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
const referenced = new Set([...bundle.matchAll(/getElementById\("([^"]+)"\)/g)].map(match => match[1]));
const owner = new Set([...ids(html), ...ids(bundle)]);

test('独立控制台引用的 DOM id 都存在', () => {
  const missing = [...referenced].filter(id => !owner.has(id));
  assert.deepEqual(missing, [], `app.js 引用了不存在的元素：${missing.join(', ')}`);
});

test('服务入口面板由构建产物提供，不再写死在 index.html', () => {
  // 面板与 AIO 内嵌页共用 web-src/panel.ts，表单项必须来自 bundle。
  assert.doesNotMatch(html, /name="transport"/, '登记表单不应再写在 index.html 里');
  assert.match(bundle, /name="transport"/);
  assert.match(bundle, /name="dnsMode"/);
  assert.match(bundle, /value="frp"/);
  assert.match(html, /id="panel-mount"/, '面板需要挂载点');
  assert.match(html, /id="panel-tools"/, '面板按钮需要容器');
});
