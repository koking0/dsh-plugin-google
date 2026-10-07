/**
 * 路径与时区默认值的测试 —— 这些逻辑决定了插件能否在**别人的电脑**上开箱即用，
 * 因此必须与我这台机器的实际情况解耦。
 */
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CLIENT_FILE,
  DEFAULT_TOKEN_FILE,
  detectSystemTimeZone,
  resolveDefaultTimeZone,
  resolveDshHome,
  resolvePluginPaths,
} from '../lib/paths.js';

test('resolveDshHome 优先环境变量，否则回退到 ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/dsh' }), '/custom/dsh');
  assert.equal(resolveDshHome({ DSH_HOME: '  /custom/dsh  ' }), '/custom/dsh');
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'));
  assert.equal(resolveDshHome({}), join(homedir(), '.dsh'));
  assert.equal(resolveDshHome(), join(homedir(), '.dsh'));
});

test('resolvePluginPaths 在未配置时落在 DSH home 下', () => {
  const paths = resolvePluginPaths({}, { DSH_HOME: '/home/user/.dsh' });
  assert.equal(paths.dshHome, '/home/user/.dsh');
  assert.equal(paths.clientSecretFile, join('/home/user/.dsh', DEFAULT_CLIENT_FILE));
  assert.equal(paths.tokenFile, join('/home/user/.dsh', DEFAULT_TOKEN_FILE));
});

test('resolvePluginPaths 尊重显式配置，且忽略空白值', () => {
  const explicit = resolvePluginPaths(
    { clientSecretFile: '/tmp/client.json', tokenFile: '/tmp/token.json' },
    { DSH_HOME: '/home/user/.dsh' },
  );
  assert.equal(explicit.clientSecretFile, '/tmp/client.json');
  assert.equal(explicit.tokenFile, '/tmp/token.json');

  const blank = resolvePluginPaths(
    { clientSecretFile: '   ', tokenFile: '' },
    { DSH_HOME: '/home/user/.dsh' },
  );
  assert.equal(blank.clientSecretFile, join('/home/user/.dsh', DEFAULT_CLIENT_FILE));
  assert.equal(blank.tokenFile, join('/home/user/.dsh', DEFAULT_TOKEN_FILE));
});

test('默认路径完全由 DSH home 推导，不含任何写死的机器路径', () => {
  // 回归保护：发布出去的 bundle 补丁不允许带绝对路径，默认值必须在这里推导出来。
  // 注意用 join 比较而不是 startsWith —— Windows 的分隔符与 POSIX 不同。
  const root = '/somewhere/else';
  const paths = resolvePluginPaths({}, { DSH_HOME: root });
  assert.equal(paths.dshHome, root);
  assert.equal(paths.clientSecretFile, join(root, DEFAULT_CLIENT_FILE));
  assert.equal(paths.tokenFile, join(root, DEFAULT_TOKEN_FILE));
});

test('resolveDefaultTimeZone：配置优先，其次系统时区', () => {
  assert.equal(resolveDefaultTimeZone('Asia/Tokyo', () => 'Europe/Paris'), 'Asia/Tokyo');
  assert.equal(resolveDefaultTimeZone(undefined, () => 'Europe/Paris'), 'Europe/Paris');
  assert.equal(resolveDefaultTimeZone('  ', () => 'Europe/Paris'), 'Europe/Paris');
  assert.equal(resolveDefaultTimeZone(undefined, () => ''), 'UTC');
  assert.equal(resolveDefaultTimeZone(undefined, () => {
    throw new Error('boom');
  }), 'UTC');
});

test('detectSystemTimeZone 返回可用的 IANA 时区', () => {
  const zone = detectSystemTimeZone();
  assert.equal(typeof zone, 'string');
  assert.ok(zone.length > 0);
  // 必须能被 Intl 接受，否则后续解析会全部退化到 UTC。
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: zone }));
});
