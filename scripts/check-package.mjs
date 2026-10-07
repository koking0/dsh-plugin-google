/**
 * 发布前自检：确保打进 npm 包里的内容对**别人的电脑**是干净、可用的。
 *
 * 这是从真实事故里长出来的检查 —— 最初 `cordis.patch.yml` 写死了
 * `C:\Users\<本机用户>\.dsh\...`，一旦发布，别人装上会直接指向不存在的文件。
 *
 * 同时作为 CLI（`npm run pack:check`）和测试导入的函数使用，只有一份实现。
 *
 * @module dsh-plugin-google/scripts/check-package
 */

import { readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 会真正被打包的文件（依据 `files` 白名单展开目录）。
 *
 * @param {object} manifest - package.json 内容。
 * @param {string} root - 包根目录。
 * @returns {Promise<string[]>} 相对路径列表（正斜杠）。
 */
export async function collectPublishedFiles(manifest, root) {
  const out = new Set();
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else out.add(rel);
    }
  };
  for (const entry of manifest.files ?? []) {
    const target = join(root, entry);
    try {
      if (statSync(target).isDirectory()) await walk(target, entry);
      else out.add(String(entry).replace(/\\/g, '/'));
    } catch {
      // 存在性检查会单独报错
    }
  }
  return [...out];
}

/** 去掉 YAML 注释行，只看真实生效的内容。 */
export function stripYamlComments(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * 疑似「本机专属」的内容特征。
 *
 * 刻意排除 `xxx` / `you` / `<...>` 这类**文档占位符**，否则讲解用的示例会被误报。
 */
const PLACEHOLDER = 'xxx|you|your|user|username|<|example|placeholder|%USERPROFILE%|\\\\?\\$\\{';
const MACHINE_PATTERNS = [
  { re: new RegExp(`[A-Za-z]:\\\\+Users\\\\+(?!(?:${PLACEHOLDER}))[^\\s"'\`]+`, 'gi'), label: 'Windows 绝对路径' },
  // 注意大小写敏感：Google API 里的 `/users/me/` 不是文件路径。
  { re: new RegExp(`/(?:home|Users)/(?!(?:${PLACEHOLDER}))[A-Za-z0-9._-]+/`, 'g'), label: 'Unix 绝对路径' },
  { re: /liu_z/gi, label: '本机用户名' },
  { re: /[\w.+-]+@(?:gmail|outlook|qq|163|126)\.com/gi, label: '个人邮箱' },
  { re: /[a-f0-9]{24,}@group\.calendar\.google\.com/gi, label: '具体日历 ID' },
];

/** 扫描时跳过的文件：检查脚本自身必然包含上面这些模式字面量。 */
const SELF_REFERENTIAL = new Set(['scripts/check-package.mjs']);

const SCANNABLE = /\.(js|mjs|cjs|json|yml|yaml|md|svg|txt)$/i;

/**
 * 执行全部检查。
 *
 * `problems` 是**硬性阻断**（发布出去会对别人造成实际问题）；
 * `warnings` 是**市场准入**相关（不影响 `npm publish`，但会影响社区目录收录）。
 *
 * @param {object} [options] - `{ root }` 包根目录。
 * @returns {Promise<{ problems: string[], warnings: string[], notes: string[], manifest: object }>} 结果。
 */
export async function checkPackage({ root = packageRoot } = {}) {
  const problems = [];
  const warnings = [];
  const notes = [];
  const fail = (message) => problems.push(message);
  const warn = (message) => warnings.push(message);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch (error) {
    return { problems: [`读不到 package.json：${error.message}`], warnings, notes, manifest: {} };
  }

  // ---- 1. 清单字段 ----
  if (manifest.private === true) fail('package.json 仍然是 private: true，npm 会拒绝发布');
  for (const field of ['name', 'version', 'description', 'license']) {
    if (!manifest[field]) fail(`package.json 缺少 ${field}`);
  }
  if (!manifest.repository) {
    // npm publish 不要求它，但社区插件市场的准入门槛里有「可访问的仓库地址」。
    warn('package.json 缺少 repository —— npm publish 可以照常进行，但插件市场会因此不收录');
  }
  if (!Array.isArray(manifest.keywords) || !manifest.keywords.includes('dsh-plugin')) {
    fail('keywords 里应包含 "dsh-plugin"（社区按该关键词自动发现插件）');
  }
  if (!manifest.dsh?.bundle?.patch) fail('package.json 缺少 dsh.bundle.patch');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('package.json 缺少 files 白名单');
  const catalog = manifest.dsh?.catalog;
  if (catalog) {
    if (!['tool', 'provider', 'ui', 'workflow', 'integration', 'theme', 'other'].includes(catalog.category)) {
      fail(`dsh.catalog.category 非法：${catalog.category}`);
    }
    for (const lang of ['en', 'zh']) {
      const summary = catalog.summary?.[lang];
      if (typeof summary !== 'string' || summary.length === 0 || summary.length > 200) {
        fail(`dsh.catalog.summary.${lang} 必须存在且不超过 200 字符`);
      }
    }
    if (Array.isArray(catalog.capabilities)) {
      for (const item of catalog.capabilities) {
        if (String(item).length > 64) fail(`dsh.catalog.capabilities 项超过 64 字符：${item}`);
      }
    }
  }
  notes.push(`清单：${manifest.name}@${manifest.version}（license=${manifest.license}）`);

  // ---- 2. files 白名单必须真实存在 ----
  for (const entry of manifest.files ?? []) {
    try {
      statSync(join(root, entry));
    } catch {
      fail(`files 白名单里的 "${entry}" 不存在`);
    }
  }
  notes.push(`files 白名单：${(manifest.files ?? []).join(', ')}`);

  // ---- 3. bundle patch 结构 ----
  const patchRelative = manifest.dsh?.bundle?.patch;
  let patchText = '';
  if (typeof patchRelative === 'string') {
    try {
      patchText = readFileSync(join(root, patchRelative), 'utf8');
    } catch {
      fail(`dsh.bundle.patch 指向的文件读不到：${patchRelative}`);
    }
  }
  if (patchText) {
    if (!/^\s*-?\s*insert:/m.test(patchText)) fail('cordis.patch.yml 里找不到 insert 段');
    if (!patchText.includes(manifest.name)) fail(`cordis.patch.yml 里没有引用包名 ${manifest.name}`);
    // bundle 层必须保持「通用」：个人日历、凭据路径、时区都属于 profile 覆盖层。
    const effective = stripYamlComments(patchText);
    for (const [pattern, label] of [
      [/otherCalendarIds/, '他人的日历 ID'],
      [/clientSecretFile|tokenFile/, '凭据/令牌路径'],
      [/timeZone/, '写死的时区'],
    ]) {
      if (pattern.test(effective)) fail(`bundle 补丁层不应包含${label}（属于 profile 覆盖层）`);
    }
    notes.push('bundle patch 结构正常，且不含机器专属配置');
  }

  // ---- 4. 扫描发布内容 ----
  const files = await collectPublishedFiles(manifest, root);
  let scanned = 0;
  for (const file of files) {
    if (!SCANNABLE.test(file)) continue;
    if (SELF_REFERENTIAL.has(file)) continue;
    scanned += 1;
    const text = readFileSync(join(root, file), 'utf8');
    for (const { re, label } of MACHINE_PATTERNS) {
      re.lastIndex = 0;
      const hits = text.match(re);
      if (hits) {
        const unique = [...new Set(hits.map((hit) => hit.trim()))].slice(0, 3);
        fail(`${file} 含可疑的${label}：${unique.join(' / ')}`);
      }
    }
  }
  notes.push(`已扫描 ${scanned} 个发布文件`);

  return { problems, warnings, notes, manifest };
}

/** 仅在被直接执行时跑 CLI。 */
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { problems, warnings, notes } = await checkPackage();
  console.log('发布前自检 (dsh-plugin-google)\n');
  for (const note of notes) console.log(`  ✓ ${note}`);
  if (warnings.length > 0) {
    console.log('');
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
  if (problems.length > 0) {
    console.log('');
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    console.log(`\n共 ${problems.length} 个问题，请修复后再发布。`);
    process.exit(1);
  }
  console.log(warnings.length > 0
    ? '\n硬性问题已全部通过（上面 ! 项会影响插件市场收录）。'
    : '\n全部通过，可以发布。');
}
