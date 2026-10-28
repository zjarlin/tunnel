import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * 「点网址就打开」是对表格渲染的硬约束：连接地址列的 HTTP(S) 地址必须是链接，
 * 操作列不能再放重复的「打开」按钮；TCP 是 host:port，不能变成链接。
 * 这里对构建产物做静态对账，真实点击验证见 scripts/portal-browser.cjs。
 */
const bundle = readFileSync(new URL('../dist/web/app.js', import.meta.url), 'utf8');

test('连接地址列渲染成链接单元格，不再靠操作列的「打开」按钮', () => {
  assert.match(bundle, /linkCell\(/, '面板需要 linkCell 负责把地址渲染成链接');
  assert.doesNotMatch(bundle, /link\("打开"/, '地址已是链接，不应再生成「打开」按钮');
  assert.doesNotMatch(bundle, /'打开'/, '表格行里不应再出现「打开」文案');
  // 链接必须带 noopener，避免新窗口拿到 opener 反向控制控制台。
  const linkCell = bundle.match(/linkCell\((\w+)\)\{[\s\S]{0,400}?\}\}/);
  assert.ok(linkCell, 'linkCell 实现应可定位');
  assert.match(linkCell[0], /rel="noopener noreferrer"/);
  assert.match(linkCell[0], /target="_blank"/);
});
