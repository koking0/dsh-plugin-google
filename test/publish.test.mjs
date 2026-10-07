/**
 * 发布可达性测试。
 *
 * 实际的扫描逻辑只有一份实现（`scripts/check-package.mjs`），这里直接调用它，
 * 避免「测试通过但发布检查是另一套代码」这种假安全感。
 *
 * 这套检查来自真实事故：最初 `cordis.patch.yml` 写死了本机绝对路径，
 * 一旦发布，别人装上会指向不存在的文件。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkPackage, stripYamlComments } from '../scripts/check-package.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

test('发布前自检全部通过', async () => {
  const { problems, notes } = await checkPackage({ root: packageRoot });
  assert.deepEqual(problems, [], `发布自检未通过：\n  - ${problems.join('\n  - ')}`);
  assert.ok(notes.length > 0);
});

test('market 准入项（repository）被跟踪', async () => {
  // repository 不影响 npm publish，但插件市场的准入门槛要求「可访问的仓库地址」。
  // 这里只断言它被显式跟踪：有则通过，没有则必须出现在 warnings 里，不能静默忽略。
  const { warnings } = await checkPackage({ root: packageRoot });
  if (!manifest.repository) {
    assert.ok(warnings.some((item) => item.includes('repository')),
      '缺少 repository 时必须给出 warning，避免发布后才发现进不了市场');
  }
});

test('package.json 具备发布所需的核心元数据', () => {
  assert.notEqual(manifest.private, true, '不能带着 private: true 发布');
  assert.equal(manifest.name, 'dsh-plugin-google');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.license, 'MIT');
  assert.ok(manifest.keywords.includes('dsh-plugin'), '插件市场靠该关键词自动抓取');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.publishConfig.access, 'public');
});

test('dsh.catalog 元数据符合市场目录的约束', () => {
  const catalog = manifest.dsh.catalog;
  assert.ok(catalog, '缺少 dsh.catalog');
  assert.ok(['tool', 'provider', 'ui', 'workflow', 'integration', 'theme', 'other']
    .includes(catalog.category));
  for (const lang of ['en', 'zh']) {
    assert.ok(catalog.summary[lang].length > 0 && catalog.summary[lang].length <= 200,
      `summary.${lang} 必须存在且 ≤200 字符`);
  }
  assert.ok(catalog.capabilities.length <= 20);
  for (const item of catalog.capabilities) {
    assert.ok(item.length <= 64, `capability 超过 64 字符：${item}`);
  }
});

test('stripYamlComments 只保留生效内容', () => {
  const yaml = ['# 注释里的 otherCalendarIds', '- insert:', '    - id: google', '      config:', '        a: 1'].join('\n');
  assert.doesNotMatch(stripYamlComments(yaml), /otherCalendarIds/);
  assert.match(stripYamlComments(yaml), /- insert:/);
});

test('依赖范围能覆盖当前 DSH 运行时（安装器只校验 @deepseek-ai/dsh-*）', () => {
  const peers = manifest.peerDependencies ?? {};
  const dshPeers = Object.entries(peers).filter(([name]) => /^@deepseek-ai\/dsh(-|$)/.test(name));
  assert.ok(dshPeers.length > 0, '应声明 @deepseek-ai/dsh-* 的 peer');
  for (const [name, range] of dshPeers) {
    const alternatives = range.split('||').map((part) => part.trim());
    // 当前运行时 0.2.0-rc.2：任一分支能覆盖它即可（安装器用 includePrerelease 比较）。
    const covers = alternatives.some((part) => part === '^0.2.0-rc.1' || part === '^0.2.0' || part === '*');
    assert.ok(covers, `${name} 的范围 ${range} 覆盖不到当前运行时 0.2.0-rc.2`);
  }
});
