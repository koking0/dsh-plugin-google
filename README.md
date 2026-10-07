# Google 日历与任务（dsh-plugin-google）

把 **Google Calendar** 与 **Google Tasks** 接入 DeepSeek Harness 的原生插件：直接通过对话完成日程、日历、待办与任务列表的增删改查、忙闲查询与每日汇总。

插件不依赖任何第三方运行时库 —— HTTP 走 `node:https`，OAuth 2.0 自行实现，因此不需要 Python/Node 中间服务，也不需要额外的令牌存储。

---

## 1. 方案调研结论

**结论：没有可直接复用的 DSH 插件，因此采用「原生插件 + 自行实现 OAuth」方案；工具设计参考了现有 MCP 服务器的成熟做法。**

社区与 npm 上的 DSH 插件目录（`dsh-plugin-shop-catalog`，约 1.3 万条目）中没有任何 Google 日历/任务插件；最接近的只有基于 CalDAV 的 [`dsh-calendar`](https://www.npmjs.com/package/dsh-calendar)、[`dsh-icloud-calendar`](https://github.com/CaiMingshen/dsh-icloud-calendar)，以及一个原生 Google OAuth 的 [gmail-dsh](https://github.com/takasurazeem/gmail-dsh)（非目录内）。

现成的 **MCP 服务器** 有不少，但不能直接装进 DSH 插件管理器，只能旁挂一个额外进程：

| 方案 | 运行时 | 覆盖 | 许可 | 说明 |
|---|---|---|---|---|
| [Google 官方 Calendar MCP](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server) | 远端 Streamable HTTP | 仅日历 | Google 服务 | 官方但需 Developer Preview Program 资格 |
| [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) | Python ≥3.10 | 日历+任务+Gmail 等 120+ 工具 | MIT | 功能最全，需 Python 环境与多用户 OAuth |
| [nspady/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp) | TypeScript | 仅日历 | MIT | 日历侧实现最完整（重复事件、时区） |
| [zcaceres/gtasks-mcp](https://github.com/zcaceres/gtasks-mcp) · [@girmmy/google-tasks-mcp-server](https://www.npmjs.com/package/@girmmy/google-tasks-mcp-server) | TypeScript | 仅任务 | MIT | 子任务、移动、清空已完成 |
| [gcal-mcp](https://pypi.org/project/gcal-mcp/) | Python ≥3.11 | 仅日历 | GPL-3.0 | 已归档 |

**为什么不直接用 MCP：** 需要额外安装并守护 Python/Node 运行时、OAuth 凭据与令牌会落在 DSH 之外、权限范围由对方决定，且无法利用 DSH 的 `confirm` 二次确认机制。

**自建的代价：** 自行实现回环 OAuth、令牌刷新、时区与重复规则处理。本插件通过「自然语言时间解析 + 工具层二次确认 + 200+ 条自动化测试」来覆盖这些复杂度。

技术事实（已核对官方 Discovery 文档与 OAuth 文档）：

- Calendar API **v3**：`https://www.googleapis.com/calendar/v3`；Tasks API **v1**：`https://tasks.googleapis.com/tasks/v1`。
- 权限范围：`.../auth/calendar`（含日历与事件的完整读写）与 `.../auth/tasks`；两者都可在配置中替换为更窄的范围。
- 「桌面应用」类型的 OAuth 客户端允许把 `http://127.0.0.1:<任意端口>` 作为回调地址，因此插件可以在本机自动完成授权，无需手动复制授权码。
- ⚠️ **OAuth 应用处于「测试」发布状态时，refresh token 会在 7 天后失效。** 见下文 [常见问题](#6-常见问题)。

---

## 2. 安装

### 从 npm 安装（推荐）

```sh
dsh plugin --profile <profile> add dsh-plugin-google
```

也可以直接对 DSH 说「把 dsh-plugin-google 装到 desktop profile」，插件管理器会调用同一条路径。

安装后 profile 的 `dsh.profile.bundles` 会加入 `dsh-plugin-google`，该包自带的
`cordis.patch.yml` 会插入一条 `id: google` 的插件行。

### 从源码目录安装（本地开发）

```sh
dsh plugin --profile <profile> add /绝对路径/to/dsh-plugin-google
```

### 本机专属配置写在哪里

**`bundle` 层只放通用默认值**，不要把自己的账号、时区、他人日历 ID 写进去 ——
那样发布出去会污染别人的配置。本机设置请写到 profile 自己的覆盖层
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`：

```yaml
# 补丁按 id 整条替换 config（不是逐键合并），所以这里写全你需要覆盖的键。
- id: google
  name: dsh-plugin-google
  config:
    timeZone: 'Asia/Shanghai'
    otherCalendarIds:
      - '<某个共享日历的 ID>'
```

凭据与令牌**不需要**配置，默认就落在 `$DSH_HOME` 下：

```
$DSH_HOME/google-oauth-client.json   # Google Cloud 下载的 OAuth 客户端 JSON
$DSH_HOME/google-oauth-token.json    # 授权后由插件自动写入
```

（Windows 上 `$DSH_HOME` 通常是 `%USERPROFILE%\.dsh`。）

---

## 3. 配置 Google Cloud（一次性）

> 这一步必须在 Google Cloud 控制台完成，因为 OAuth 客户端凭据属于你自己的账号。
> 下面这套流程已在本机用 BrowserSkill 实际走过一遍，路径与注意事项都是实测结果。

1. **创建项目**：打开 <https://console.cloud.google.com/projectcreate>，新建一个项目（例如 `dsh-google`）。
   项目 ID 会自动生成（形如 `swift-area-510708-v1`），无需手动指定。
2. **启用两个 API**（务必确认控制台顶部已切到新项目）：
   - <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com> → 「启用此 API」
   - <https://console.cloud.google.com/apis/library/tasks.googleapis.com> → 「启用此 API」

   右上角通知里出现「启用服务：calendar-json.googleapis.com」「启用服务：tasks.googleapis.com」即成功。
3. **配置 OAuth 权限请求页面**（<https://console.cloud.google.com/auth/overview> → 「开始」，共 4 步）：
   - 应用名称 + 用户支持邮箱；
   - 受众群体选 **外部 / External**（个人 Gmail 账号下「内部」是灰的，不可选）；
   - 联系邮箱；
   - 勾选同意《Google API 服务：用户数据政策》，再点「创建」。

   ⚠️ **应用名称里不能包含 "Google"**，否则最后一步会报
   「请求失败，因为"应用名称"不符合 Google 的要求」，而且此时前面的填写不会被保存，需要从头再来一次。
   （实测：`DSH Google 日历与任务` 被拒；`DSH 日历与任务` 通过。）
4. **添加测试用户**（<https://console.cloud.google.com/auth/audience> → 「测试用户」→「添加用户」）：
   加入你自己的 Gmail 地址。发布状态为「测试」时，**只有测试用户能授权**，漏掉这一步会在授权时报
   `access_denied`。权限范围**不需要**在这里手动添加，授权时由插件动态请求。
5. **创建 OAuth 客户端**（<https://console.cloud.google.com/auth/clients> → 「创建客户端」）：
   - 应用类型必须选 **桌面应用 / Desktop app**（这类客户端允许任意回环端口，插件才能自动完成授权）；
   - 名称随意（只用于控制台内识别，不展示给用户）；
   - 点「创建」后**立刻点「下载 JSON」**——对话框明确提示：关闭后客户端密钥将无法再次查看；
   - 把下载到的 JSON 放到（Windows 下即 `%USERPROFILE%\.dsh\google-oauth-client.json`）：

     ```
     $DSH_HOME/google-oauth-client.json
     ```

     > 实测提示：若用浏览器自动化下载，文件可能保留为 `Downloads/<uuid>.tmp`，
     > 内容其实是完整的客户端 JSON，直接改名复制即可。

6. **（可选但强烈建议）把发布状态改为「正式 / In production」**：否则 refresh token 每 7 天失效一次。
   把发布状态从「测试」改为「正式」需要先在**品牌塑造**页填好「应用首页」与「应用隐私权政策链接」，
   再把网址域名加进「已获授权的网域」。个人使用无需通过 Google 验证，
   授权页会出现「此应用未经 Google 验证」提示，点「高级」→「转至…（不安全）」即可继续。

   > 实测：用个人博客地址（`https://alex007.blog.csdn.net/`）作为首页与隐私政策链接即可通过，
   > 且 `csdn.net` 作为已授权网域**不需要**先在 Search Console 完成所有权验证，保存后即可发布。

令牌文件由插件自动写入 `$DSH_HOME/google-oauth-token.json`，不需要手工创建。

### 中国大陆网络

Google API 通常无法直连。请设置代理（二选一）：

- 在插件配置里显式指定：`proxy: 'http://127.0.0.1:7890'`
- 或让 DSH 进程继承环境变量 `HTTPS_PROXY`（Clash / V2Ray 等混合端口即可）

插件支持 HTTP `CONNECT` 隧道；`127.0.0.1` 等回环地址永不经过代理。

---

## 4. 完成授权

在对话里依次说：

1. 「**检查 Google 授权状态**」→ 调用 `google_auth_status`，确认客户端 JSON 已就绪。
2. 「**开始 Google 授权**」→ 调用 `google_auth_begin`，插件返回一条授权链接，并已在 `127.0.0.1` 上启动本地回调服务。
3. 在浏览器打开链接 → 选择账号 → 同意（会提示未验证应用，走「高级 → 继续访问」）。
4. 「**好了 / 完成了**」→ 调用 `google_auth_complete`，令牌写入本地文件，授权结束。

> `google_auth_complete` 默认最多等待 20 秒；如果用户还没点完，会返回「仍在等待」，**不是错误** —— 用户完成后再调一次即可。
>
> 若浏览器无法访问本机回环端口（例如远程/容器环境），可以把浏览器跳转后的完整地址作为 `redirectUrl` 传给 `google_auth_complete`，或直接传 `code`。

### 命令行授权（等价替代）

如果不想通过对话触发，或需要在无对话环境下完成授权，可以直接跑插件自带的脚本。
它复用插件自己的 `lib/auth.js` + `lib/oauth-flow.js`，与对话路径是**同一套代码**：

```powershell
cd dsh-plugin-google
node scripts/authorize.mjs
```

脚本会打印一条授权链接并起本地回调服务；浏览器同意后自动写入令牌，并顺手调用一次
`calendars/primary` 与 `calendarList` 做真实验证。可用参数：
`--port <端口>`、`--client-file <路径>`、`--token-file <路径>`、`--proxy <代理>`、`--url-file <把链接写入文件>`。

授权完成后，直接说人话即可：

- 「我今天有什么安排」→ `google_agenda`
- 「明天下午3点到4点，和张总开项目评审，加个腾讯会议链接」
- 「把下周三的牙医改到周五上午10点」
- 「我有哪些待办」/「把写周报标记完成」
- 「帮我约一个下周一上午、双方都空的 1 小时」→ `gcal_find_free_slots`

### 查他人的空闲（例如给学生安排事情）

把对方的日历加进 `calendars` 即可；这样调用时**默认不带待办**，只回对方的日程：

```
google_agenda { calendars: ["<学生日历ID>"], date: "今天", days: 7 }
gcal_find_free_slots { calendars: ["<我的工作日历>", "<学生日历>"], timeMin: "明天", timeMax: "+7d" }
```

配置 `otherCalendarIds` 里登记的日历会被视为「他人日程」：照常展示，但**不参与冲突判定**，
避免「我和研究生的课表时间重叠」被误报成双重预约。

---

## 5. 工具清单（30 个）

### 授权（`google_*`）

| 工具 | 作用 |
|---|---|
| `google_auth_status` | 检查客户端配置、令牌、权限范围，并实时验证令牌是否有效 |
| `google_auth_begin` | 生成授权链接并启动本地回调监听 |
| `google_auth_complete` | 取回授权码并换取长期令牌（支持 `waitMs` / `code` / `redirectUrl`） |
| `google_auth_reset` | 清除本地令牌，可选在 Google 侧撤销（需 `confirm`） |

### 日历与日程（`gcal_*`）

| 工具 | 作用 |
|---|---|
| `google_agenda` | **日历 + 待办的按天汇总**（当天日程、到期待办、逾期任务、时间冲突） |
| `gcal_list_calendars` | 列出所有可见日历 |
| `gcal_create_calendar` / `gcal_update_calendar` / `gcal_delete_calendar` | 日历的增改删（删除需 `confirm`） |
| `gcal_list_events` | 按时间范围/关键词查询日程，`calendarId: all` 可跨日历合并 |
| `gcal_get_event` | 读取日程详情（参与者回复状态、重复规则、会议链接） |
| `gcal_create_event` | 新建日程：自然语言时间、参与者、重复规则、提醒、Google Meet、`dryRun` 预览 |
| `gcal_update_event` | 修改日程；参与者可用 `addAttendees` / `removeAttendees` 增量调整；`scope` 控制重复日程范围 |
| `gcal_delete_event` | 删除日程（需 `confirm`） |
| `gcal_quick_add` | 交给 Google 解析一句自然语言建日程 |
| `gcal_move_event` | 把日程移动到另一个日历 |
| `gcal_find_free_slots` | 多日历忙闲查询，找出共同空闲时段 |
| `gcal_respond_to_invite` | 接受 / 拒绝 / 暂定邀请 |

### 待办（`gtasks_*`）

| 工具 | 作用 |
|---|---|
| `gtasks_list_tasklists` | 列出任务列表 |
| `gtasks_create_tasklist` / `gtasks_update_tasklist` / `gtasks_delete_tasklist` | 任务列表增改删（删除需 `confirm`） |
| `gtasks_list_tasks` | 查询任务；`taskListId: all` 跨列表；支持截止时间区间与关键词 |
| `gtasks_get_task` | 任务详情（含直接子任务） |
| `gtasks_create_task` | 新建任务，支持截止日期、备注、子任务（`parent`）与排序 |
| `gtasks_update_task` | 修改标题/备注/截止日期/状态，`clearDue` 清除截止日期 |
| `gtasks_complete_task` | 标记完成 / 恢复未完成 |
| `gtasks_delete_task` | 删除任务（需 `confirm`） |
| `gtasks_move_task` | 改父任务、调整顺序，或跨列表移动（`destinationListId`） |
| `gtasks_clear_completed` | 清空已完成任务（需 `confirm`） |

### 关于时间参数

所有时间参数都支持中文自然语言，在 `config.timeZone`（默认 `Asia/Shanghai`）下解释：

| 写法 | 含义 |
|---|---|
| `明天下午3点`、`下周一 10:00`、`周五` | 关键词 / 星期表达 |
| `2026-10-06`、`2026年10月6日`、`10月6号` | 日期（全天事件） |
| `2026-10-06T15:00:00+08:00` | 带偏移的绝对时刻 |
| `+2h`、`+90m`、`3天后`、`2小时前`、`now` | 相对量 |
| `15:00`、`下午3点`、`上午9点半` | 纯时刻（按当天算） |

仅给 `start` 时：定时日程默认 60 分钟（`defaultEventMinutes`），全天事件默认 1 天（`days`）。
`end` 只给时刻（如 `16:00`）时会自动落到 `start` 所在的那一天；全天事件的 `end` 采用 Google 语义（不含当日），也可以用更直观的 `days`。
只有时段词（如「今晚」）时按 09:00 / 12:00 / 14:00 / 19:00 估算，并在结果里注明。

### 关于安全

- 删除日程、删除任务、清空已完成任务、删除日历/任务列表 **必须** 传 `confirm: true`；插件提示模型先取得用户同意。
- `config.readOnly: true` 可整体切为只读。
- `config.requireConfirmForWrites: true` 会让**所有**写入都要求 `confirm: true`。

---

## 6. 配置项

在 profile 的 `cordis.patch.yml` 里修改（安装后已有默认值）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `clientSecretFile` | — | Google Cloud 下载的 OAuth 客户端 JSON 路径 |
| `clientId` / `clientSecret` | — | 也可直接给出凭据（不建议写进配置） |
| `credentialRef` | `GOOGLE_OAUTH_CLIENT` | 交给 DSH 凭据服务解析的引用名 |
| `tokenFile` | — | refresh token 的存放路径 |
| `oauthRedirectPort` | `0` | 本地回调端口，0 为自动分配 |
| `oauthRedirectUri` | — | 使用「Web 应用」类型客户端时填写已登记的固定地址 |
| `oauthFlowTimeoutMs` | `900000` | 授权链接有效期 |
| `timeZone` | `Asia/Shanghai` | 解释与展示时间所用时区 |
| `defaultCalendarId` | `primary` | 默认日历 |
| `defaultTaskList` | `@default` | 默认任务列表 |
| `defaultEventMinutes` | `60` | 只给 `start` 时的默认时长 |
| `otherCalendarIds` | `[]` | 「他人日程」日历：照常展示但不参与 `google_agenda` 的冲突判定（例如学生的课表） |
| `scopes` | calendar + tasks | OAuth 权限范围 |
| `proxy` | — | HTTP(S) 代理；留空则读 `HTTPS_PROXY` |
| `rejectUnauthorized` | `true` | 是否校验 TLS 证书 |
| `requestTimeoutMs` | `30000` | 单次请求超时 |
| `readOnly` | `false` | 全局只读 |
| `requireConfirmForWrites` | `false` | 所有写入都要求 `confirm: true` |
| `oauthAuthUrl` / `oauthTokenUrl` / `oauthRevokeUrl` / `calendarApiBase` / `tasksApiBase` | 官方地址 | 端点覆盖（自建代理或测试用） |

---

## 7. 常见问题

**每 7 天就要重新授权一次？**
这是 Google 对「测试」发布状态的限制：外部用户类型 + 测试状态签发的 refresh token 只活 7 天。把 OAuth 同意屏幕的发布状态改为 **「正式 / In production」** 即可长期有效（个人使用无需通过验证）。

**提示「尚未完成 Google 授权」**
运行 `google_auth_status`，再走一遍 `google_auth_begin` → `google_auth_complete`。

**提示 `invalid_grant` / refresh token 已失效**
令牌被撤销、账号改过密码，或上面说的 7 天过期。重新授权即可。

**提示网络不可达 / 连接超时**
中国大陆通常需要代理。设置 `proxy`，或让 DSH 进程带上 `HTTPS_PROXY` 环境变量。

**安装后插件没有生效（工具不出现）？**
`dsh-plugin-google` 通过 `link:` 方式安装，加载器可能在 pnpm 建好链接之前就去 import，导致这一次记录为 `failed to import`。
把该组合包在插件页/`plugin_manager` 里**关掉再打开**即可（已验证有效）。用 `plugin_manager` 的 `listBundles` 能看到
`dsh-plugin-google` 是否已启用；确认条目 `include:google` 的状态不是 `inactive`。

**改了插件源码但行为没变？**
DSH 对已加载的模块按 URL 缓存，替换已有包后需要**重启进程**才会加载新的 JavaScript 版本（这是 DSH 的既有约定）。
重新开关组合包只对「上次没有加载成功」的情况有效。

**无法删除主日历？**
Google API 本身不允许删除 `primary`，插件会直接拒绝。

**Google Tasks 的截止日期为什么没有具体时间？**
Tasks API 只保存日期、丢弃时刻。插件统一按本地日期写入 UTC 零点并按日期展示，避免跨时区差一天。

**跨列表移动任务可以吗？**
可以，`gtasks_move_task` 传 `destinationListId` 即可（底层是 `tasks.move` 的 `destinationTasklist`）。

**时间解析不符合预期**
用显式的 ISO 时间（如 `2026-10-06T15:00:00+08:00`）更保险；解析失败时工具会返回支持的写法清单。

---

## 8. 开发与测试

```sh
node --test              # 105 个用例，全部走本地模拟的 Google 服务，无需真实凭据
node scripts/check-package.mjs   # 发布前自检（或 npm run pack:check）
```

测试覆盖：令牌刷新与 401 重试、回环 OAuth 全流程（含 state 校验与拒绝授权）、日历与任务的 CRUD 往返、
忙闲查询与空闲时段计算、自然语言时间解析、时区换算、代理隧道、只读与二次确认策略、错误翻译，
以及「发布产物不得含本机路径/个人信息」的守卫。

验证发布产物是否自包含：

```sh
npm pack --pack-destination /tmp
tar -xzf /tmp/dsh-plugin-google-*.tgz -C /tmp
cd /tmp/package && node --test
```

目录结构：

```
dsh-plugin-google/
├─ index.js              # 插件入口：Config、工具注册、系统提示词
├─ cordis.patch.yml      # bundle 层：**只放通用默认值**，不含任何机器信息
├─ lib/
│  ├─ http.js            # 零依赖 HTTP/HTTPS 客户端（含代理 CONNECT 隧道）
│  ├─ auth.js            # OAuth 2.0：凭据解析、令牌刷新、授权码交换
│  ├─ oauth-flow.js      # 本地回环回调服务（两步式授权）
│  ├─ api-core.js        # 统一鉴权、401 重试与错误翻译
│  ├─ calendar-api.js    # Calendar v3 客户端
│  ├─ tasks-api.js       # Tasks v1 客户端
│  ├─ time.js            # 时区换算与自然语言时间解析
│  ├─ format.js          # 中文渲染
│  ├─ guard.js           # 只读 / 二次确认策略
│  └─ tools/             # 工具规格（纯对象，便于独立测试）
├─ scripts/
│  └─ authorize.mjs      # 命令行授权助手（复用 lib/，不经过对话）
└─ test/                 # node:test 测试与模拟 Google 服务
```

工具规格与 DSH 注册刻意分离：`lib/tools/*` 只导出普通对象，`index.js` 统一包装成 `defineTool`，
因此工具逻辑可以在没有 DSH 运行时的情况下被 Node 直接测试。

---

## 9. 发布与分发

### 发布到 npm

```sh
npm login                 # 首次：登录你的 npm 账号
npm run pack:check        # 自检：不含本机路径、元数据齐备、bundle 层干净
npm publish               # 公开发布（package.json 已声明 publishConfig.access=public）
```

发布新版本：

```sh
npm version patch         # 或 minor / major
npm publish
```

包名 `dsh-plugin-google` 目前未被占用。若你想发布到自己的 scope（例如 `@alex007/dsh-plugin-google`），
改 `package.json` 的 `name` 即可，`publishConfig.access=public` 已经为 scoped 包准备好。

### 插件市场会**自动**收录

DSH 社区插件市场（`dsh-plugin-shop-catalog`，约 1.4 万条目）由脚本抓取 npm 上带
`dsh-plugin` / `deepseek-harness` 关键词的包，**不需要提交、不需要 PR**。

它的准入门槛里有两条值得注意：

1. **必须声明 `license`** —— 本包已是 MIT；
2. **必须有可访问的仓库地址** —— 即 `package.json` 的 `repository`，
   所以发布前请把它填成你的 GitHub 仓库地址（`npm run pack:check` 会以 `!` 提示这一项）。

另外建议填 `dsh.catalog`（本包已填）：`category` + 中英双语 `summary` + `capabilities`，
市场页面会直接展示这些内容。**收录前 Marketplace 不做人工审核**，安装时会按社区来源提示确认。

### 别人的电脑上怎么装

```sh
dsh plugin --profile <profile> add dsh-plugin-google
```

或者不用 npm，直接分发 tarball：

```sh
npm pack                                     # 产出 dsh-plugin-google-1.0.0.tgz
dsh plugin --profile <profile> add ./dsh-plugin-google-1.0.0.tgz
```

### ⚠️ 关于让同学/同事也能用：OAuth 客户端是每人的

这是唯一需要提前说清楚的边界 —— **插件可以一键装，但 Google 授权凭据不是插件的一部分**。

Google 的 OAuth 客户端属于**创建它的那个 Google Cloud 项目**。所以有两条路：

| 方式 | 做法 | 代价 |
|---|---|---|
| **各自创建**（推荐） | 每人按第 3 节建自己的 OAuth 客户端（约 5 分钟），授权进各自的项目 | 每人一次配置 |
| **共用一份** | 你把 `google-oauth-client.json` 发给可信的同事 | 所有人的授权都算在**你的**项目下，共享 100 用户上限与配额；不应公开发布该文件 |

无论哪种方式，**都不要**把 `google-oauth-client.json` 或 `google-oauth-token.json` 提交进仓库或打进 npm 包
（本包的 `files` 白名单与自检脚本都会拦住这类文件）。
