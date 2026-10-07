/**
 * 与机器无关的路径解析。
 *
 * 发布到 npm 后，插件会在完全不同的电脑上运行，因此**绝对不能**把
 * `C:\Users\xxx\.dsh\...` 这类绝对路径写进 bundle 的 `cordis.patch.yml`。
 * 这里统一把「凭据放哪儿」解析成相对 DSH home 的位置：
 *
 * 1. 显式配置（`clientSecretFile` / `tokenFile`）优先；
 * 2. 否则落在 `$DSH_HOME`（未设置时回退 `~/.dsh`）下。
 *
 * @module dsh-plugin-google/lib/paths
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 默认的 OAuth 客户端凭据文件名。 */
export const DEFAULT_CLIENT_FILE = 'google-oauth-client.json';

/** 默认的长期令牌文件名。 */
export const DEFAULT_TOKEN_FILE = 'google-oauth-token.json';

/**
 * 解析 DSH home 目录。
 *
 * @param {Record<string, string|undefined>} [env] - 环境变量（便于测试注入）。
 * @returns {string} DSH home 绝对路径。
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return fromEnv || join(homedir(), '.dsh');
}

/**
 * 解析插件用到的全部文件路径。
 *
 * @param {object} [config] - 插件配置（可能只填了其中一部分）。
 * @param {Record<string, string|undefined>} [env] - 环境变量。
 * @returns {{ dshHome: string, clientSecretFile: string, tokenFile: string }} 绝对路径。
 */
export function resolvePluginPaths(config = {}, env = process.env) {
  const dshHome = resolveDshHome(env);
  const explicitClient = typeof config.clientSecretFile === 'string' ? config.clientSecretFile.trim() : '';
  const explicitToken = typeof config.tokenFile === 'string' ? config.tokenFile.trim() : '';
  return {
    dshHome,
    clientSecretFile: explicitClient || join(dshHome, DEFAULT_CLIENT_FILE),
    tokenFile: explicitToken || join(dshHome, DEFAULT_TOKEN_FILE),
  };
}

/**
 * 解析默认时区：优先配置，其次系统时区，最后回退到一个确定值。
 *
 * 作为通用插件，把默认时区写死成 `Asia/Shanghai` 对别人是不合适的；
 * 用户在别的时区装完应该开箱即用。本函数保证不抛异常。
 *
 * @param {string|undefined} configured - 配置里的时区。
 * @param {() => string} [systemTimeZone] - 取系统时区的函数（便于测试）。
 * @returns {string} 待交给 Intl 校验的时区名。
 */
export function resolveDefaultTimeZone(configured, systemTimeZone = detectSystemTimeZone) {
  const fromConfig = typeof configured === 'string' ? configured.trim() : '';
  if (fromConfig) return fromConfig;
  try {
    return systemTimeZone() || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 读取运行环境的 IANA 时区名。 */
export function detectSystemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
