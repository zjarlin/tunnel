#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {add, doctor, list, plan, removeAlias, sync, warden} from './portal/commands.js';
import {vault} from './server/vault.js';
import {required} from './server/settings.js';

declare const PACKAGE_VERSION: string;

const USAGE = `aio-plugin-portal <命令> [选项]

命令:
  add <别名> --port <端口> [--host <主机>] [--scheme http|https] [--note <备注>]
  add <别名> --port <端口> --visibility public --authorized-by <授权人>
  （public 必须显式授权；旧 --no-lan 只表示不做内网 DNS，不再自动算授权）
  remove <别名>
  list
  plan
  sync [--apply]
  doctor
  warden [--password <网关密码>] [--apply] [--restore]
  secret list | reveal <条目ID> | add --name <名称> --password <口令> [--category <分类>] [--username <账号>] [--url <地址>] [--note <备注>] | remove <条目ID>

  密码本（secret）直连部署数据目录读取，不经过控制台；控制台下线后仍可用。
  需要 TUNNEL_DATA 与 TUNNEL_SECRET_KEY，通常来自部署 .env。

通用选项:
  --home <目录>    门户配置根目录（默认 AIO_PORTAL_HOME 或 ~/.config/aio-portal）
  --version        显示版本
  --help           显示帮助`;

async function main(): Promise<void> {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
      version: {type: 'boolean'},
      help: {type: 'boolean'},
      host: {type: 'string', default: '127.0.0.1'},
      port: {type: 'string'},
      scheme: {type: 'string', default: 'http'},
      note: {type: 'string'},
      lan: {type: 'boolean', default: true},
      'no-lan': {type: 'boolean', default: false},
      visibility: {type: 'string'},
      'authorized-by': {type: 'string'},
      home: {type: 'string'},
      password: {type: 'string'},
      apply: {type: 'boolean', default: false},
      restore: {type: 'boolean', default: false},
      name: {type: 'string'},
      username: {type: 'string'},
      url: {type: 'string'},
      category: {type: 'string'},
    },
  });
  const [command, argument] = positionals;
  if (values.version) {
    console.log(PACKAGE_VERSION);
    return;
  }
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case 'add': {
      if (!argument) throw new Error('add 需要别名');
      if (values.port === undefined) throw new Error('add 需要 --port');
      const visibility = values.visibility ?? (values['no-lan'] || !values.lan ? 'public' : 'internal');
      if (visibility !== 'internal' && visibility !== 'public') throw new Error('--visibility 只能是 internal 或 public');
      const authorizedBy = values['authorized-by'];
      console.log(await add({alias: argument, host: values.host, port: values.port, scheme: values.scheme, note: values.note, visibility, authorizedBy, home: values.home}));
      return;
    }
    case 'remove': {
      if (!argument) throw new Error('remove 需要别名');
      console.log(await removeAlias({alias: argument, home: values.home}));
      return;
    }
    case 'list':
      console.log(await list({home: values.home}));
      return;
    case 'plan':
      console.log(await plan({home: values.home}));
      return;
    case 'sync':
      console.log(await sync({home: values.home, apply: values.apply}));
      return;
    case 'doctor':
      console.log(await doctor({home: values.home}));
      return;
    case 'warden':
      console.log(await warden({password: values.password, apply: values.apply, restore: values.restore, home: values.home}));
      return;
    case 'secret': {
      // 直接读部署数据目录里的密文，不依赖 HTTP 控制台或登录会话。
      const book = vault(required('TUNNEL_DATA'));
      if (argument === 'list') {
        const items = book.list();
        if (!items.length) { console.log('密码本为空'); return; }
        for (const item of items) {
          console.log(`${item.id}  ${item.category}  ${item.name}${item.username ? `  ${item.username}` : ''}${item.url ? `  ${item.url}` : ''}`);
        }
        return;
      }
      if (argument === 'reveal') {
        const id = positionals[2];
        if (!id) throw new Error('reveal 需要条目 ID');
        const item = book.reveal(id);
        console.log(item.password);
        return;
      }
      if (argument === 'add') {
        if (!values.name) throw new Error('add 需要 --name');
        if (!values.password) throw new Error('add 需要 --password');
        const saved = book.save({name: values.name, password: values.password, category: values.category, username: values.username, url: values.url, note: values.note});
        console.log(`已保存 ${saved.id}  ${saved.name}`);
        return;
      }
      if (argument === 'remove') {
        const id = positionals[2];
        if (!id) throw new Error('remove 需要条目 ID');
        console.log(`已删除 ${book.remove(id).id}`);
        return;
      }
      throw new Error(`未知 secret 子命令：${argument}（可用 list / reveal / add / remove）`);
    }
    default:
      throw new Error(`未知命令：${command}\n\n${USAGE}`);
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
