# wb-credits

在 Claude Code 里查看 WorkBuddy 的积分余额：`/wb-credits` 打印一张卡片，状态栏常驻一行。

## 它做什么

- `/wb-credits` —— 剩余 / 总量 / 百分比、各积分包明细与到期日、上次刷新时间
- 底部状态栏常驻：`WorkBuddy积分 3,600/4,000 (90%) · 今日 150 积分 / 800 次 · 11-12 重置`
  低于 20% 加 `⚠`；取数失败时追加「N 分钟前更新失败」
- `/wb-credits-login` —— 扫码登录；`/wb-credits-login <token>` 改为直接粘令牌
- `/wb-credits-logout` —— 清除令牌与缓存

默认启动时刷新一次，之后每 10 分钟刷新一次。取数失败不会清空已有数值，只标注「多久之前」。

信息只在底部状态栏展示，不占用对话区。

## 令牌有效期与自动续期

- **access token 30 天**、**refresh token 60 天**
- 扫码或粘令牌时会把 refresh token 一并存下
- 取数遇到 401 时，插件自动用 refresh token 换一对新令牌并重试，你无需操作
- 只有 refresh token 也过期（约 60 天后）才需要重新扫码

## 安装

```
/plugin install wb-credits --marketplace labububububu16-ship-it/wb-credits
```

或在本地开发时用 `claude --plugin-dir <本目录>`。

安装后如果桌面端没出现命令，执行一次 `/reload-plugins`。

## 配置令牌

**最简单：扫码登录。**

```
/wb-credits-login
```

插件会申请一个登录 state 并打印登录地址，扫码授权后自动保存令牌、刷新积分数（10 分钟内有效）。
真正的扫码动作在浏览器或 WorkBuddy 客户端里完成，插件只负责发起与轮询，不接触你的密码。

其余三种方式：

1. **粘令牌**：`/wb-credits-login <token>`
2. **环境变量**：`CODEBUDDY_AUTH_TOKEN`（WorkBuddy 内嵌终端里本来就有）
3. **插件配置**：`claude plugin configure wb-credits --values-stdin`，存系统安全存储

`enterpriseId` 一般不用填，插件会从 WorkBuddy 客户端的本地登录态文件里读明文的企业 ID。

## 它调用什么

- `POST {站点}/v2/billing/meter/get-enterprise-user-usage`（企业额度，`limitNum` / `credit`，`-1` 表示不限量）
- `POST {站点}/v2/billing/meter/get-user-resource`（个人额度，分页取 `Accounts`）
- `POST /v2/plugin/auth/state` + `GET /v2/plugin/auth/token`（扫码登录，仅在你主动执行时调用）
- `POST {站点}/billing/meter/get-user-request-usage`（今日实际消耗：次数 + 积分，分页）
- `POST /v2/plugin/auth/token/refresh`（401 时自动续期，凭据放 `X-Refresh-Token` 头）

站点按账号域名分流：`workbuddy.cn` / `workbuddy.ai` / `codebuddy.ai` / `codebuddy.cn`。

## 桌面端与 CLI 共用令牌

同一插件经 `plugin install`（名字 `wb-credits-local`）与 `CLAUDE_CODE_PLUGIN_DIRS` / `--plugin-dir`（名字 `inline`）加载时，
store 是两份不同的文件。插件在自身 store 为空时，会只读地扫描
`~/.claude/plugins/store/wb-credits_*.json`，取最新一份的令牌继续用——**扫码一次，两边都能看到积分**。

## 它不做什么

- 不解析 WorkBuddy 客户端的加密凭证，也不读密钥材料
- 不改动 WorkBuddy 客户端的任何状态
- 不做充值、签到、消耗明细、多账号切换

## 开发

```
claude plugin test .        # 24 个用例
claude plugin validate .    # 校验 manifest 与 hooks
```

令牌约 30 天过期，届时状态栏显示「凭证过期」，用 `/wb-credits-login` 换一个即可。
