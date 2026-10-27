# wb-credits

在 Claude Code 里查看 WorkBuddy 的积分余额：`/wb-credits` 打印一张卡片，状态栏常驻一行。

> ## ⚠️ 先读这一段
>
> **本插件只做一件事：统计并展示数据。**
>
> 它不提供账号、不提供额度、不代理请求、不绕过任何计费。所有数字都来自你自己账号在
> WorkBuddy 官方的实际用量。
>
> **至于它从哪里取数、你该用谁的账号 —— 本插件不作任何说明，也不提供指引。**
> 账号与积分的获取方式请自行解决。作者不介入、不回答、不协助与账号来源相关的任何问题。
>
> 如果你没有可用的 WorkBuddy 账号，这个插件对你没有用处。

## 免责声明

- 本插件与腾讯 / WorkBuddy / CodeBuddy 无任何关联，非官方项目。
- 调用的是 WorkBuddy 客户端的内部接口，可能随客户端更新而失效，不保证持续可用。
- 使用本插件产生的任何后果（包括但不限于账号风控、服务条款问题）由使用者自行承担。
- 请遵守你与 WorkBuddy 之间的服务协议。若你的协议不允许此类访问，请勿使用。

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

插件需要一个可用的 WorkBuddy 访问令牌才能取数。**令牌怎么来，本插件不提供说明。**

拿到令牌后，任选一种方式交给插件：

1. **扫码**：`/wb-credits-login` —— 打印一个授权链接，你在已登录的浏览器里完成授权，插件轮询拿令牌
2. **直接给**：`/wb-credits-login <token>`
3. **环境变量**：`CODEBUDDY_AUTH_TOKEN`
4. **插件配置**：`claude plugin configure wb-credits --values-stdin`（存系统安全存储）

`enterpriseId` 一般不用填；插件会尝试从本机客户端登录态里读，读不到就按个人账号处理。

`/wb-credits-logout` 清除已保存的令牌与缓存。

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
