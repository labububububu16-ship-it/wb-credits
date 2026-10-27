# wb-credits — WorkBuddy 积分查询插件 设计

- 日期：2026-10-27
- 位置：独立插件仓库（不依赖任何其他项目）
- 形态：Claude Code mod（hooks 插件）

## 1. 目标

在 Claude Code 里随时看到 WorkBuddy（`com.tencent.workbuddy.mac`）的积分余额：

- `/wb-credits`：打印积分卡片（剩余 / 总量 / 百分比、各积分包与到期日）
- 状态栏常驻一行：`WB 积分 1,234 (62%)`，低于 20% 加警示

## 2. 事实基础

接口与字段取自同仓库 `workbuddy-gateway/src/app/credits.py` 中**已经跑通的实现**，
不是从客户端包里推测的：

| 项 | 值 |
|---|---|
| 企业额度 | `POST {host}/v2/billing/meter/get-enterprise-user-usage` |
| 个人额度 | `POST {host}/v2/billing/meter/get-user-resource`（分页） |
| 企业字段 | `limitNum`/`limit_num`、`credit`/`used_num`；`-1` 表示不限量 |
| 个人字段 | `Accounts[]`，剩余取 `SlicePeriodCapacityRemainPrecise` 等 10 个候选字段，总量取 `SlicePeriodCapacitySizePrecise` 等 13 个 |
| 个人请求体 | `{PageNumber, PageSize:100, ProductCode:'p_tcaca', Status:[0,3], PackageEndTimeRangeBegin, PackageEndTimeRangeEnd}` |
| 请求头 | `authorization: Bearer`、`x-user-id`、`x-domain`、`x-enterprise-id`、`x-tenant-id`、`x-client-platform: web`、`origin`、`referer` |
| 站点分流 | `workbuddy.cn` / `workbuddy.ai` / `codebuddy.ai` / `codebuddy.cn`，其余默认 `codebuddy.cn` |
| 业务码 | `code` 为 `0` 或 `200` 都算成功 |
| 桌面端注入给内嵌 CLI 的变量 | `CODEBUDDY_AUTH_TOKEN` |

## 3. 凭证策略

按优先级取 token：

1. **敏感 userConfig**（`sensitive: true`，存系统安全存储）
2. **插件 store**（`/wb-credits-login <token>` 写入）
3. **环境变量 `CODEBUDDY_AUTH_TOKEN`**

企业 ID / uid / 域名依次取 userConfig → store → 本地登录态文件明文。

**明确不做**：不解析客户端本地的加密凭证，不读取密钥材料。

## 4. 文件

```
wb-credits-plugin/
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── hooks/credits.ts          # 纯逻辑：取数归一化 + 文本排版
├── hooks/register.tsx        # 命令、定时刷新、状态栏
├── hooks/wb-credits.test.ts  # 24 个用例
├── README.md
└── LICENSE
```

不用 `$.state`（状态栏走 `$.ui.status`，快照走 `$.store`），因此没有 `types/index.d.ts`。

## 5. 数据流

```
session.start
  ├─ 注册 wb-credits / wb-credits-login / wb-credits-logout
  ├─ clock.every(10min, refresh)
  └─ refresh()                      ← 首次，不阻塞启动
        ├─ resolveCredentials
        │     └─ 无 token → $.ui.status(undefined)
        ├─ fetchCredits
        │     ├─ 企业额度（有 enterpriseId 时）
        │     └─ 个人额度分页（始终，用于积分包明细）
        ├─ 成功 → $.store.set('snapshot', snap)
        ├─ 失败 → 保留旧快照
        └─ $.ui.status(formatStatus(...))
```

- 企业接口失败但个人成功 → 用个人合计，卡片注明「企业额度暂不可用」
- 两个都失败且无旧快照 → 抛出，命令输出具体原因
- 同一时刻只跑一次取数（`inFlight` 去重）

## 6. 呈现

企业账号卡片：

```
WorkBuddy 积分 · 张三 / 示例事业部（ultimate）
  剩余   1,234 / 2,000   ██████░░░░ 62%
  刷新   刚刚
```

个人账号额外列出积分包：

```
  剩余   1,234 / 2,000   ██████░░░░ 62%
  proMon        800 /    1,200   2026-11-01 到期
  extra         434 /      800
```

状态栏：

| 条件 | 文本 |
|---|---|
| 无 token | `undefined`（清空，不占位） |
| 不限量 | `WB 积分 不限量` |
| 正常 | `WB 积分 1,234 (62%)` |
| 剩余 < 20% | `WB 积分 214 (11%) ⚠` |
| 刷新失败但有旧快照 | `WB 积分 1,234 (62%) · 3 小时前` |
| 401 | `WB 积分 凭证过期` |

## 7. 错误处理

| 情况 | 行为 |
|---|---|
| 无 token | 命令给出三条配置途径；状态栏清空 |
| 401 | 状态栏 `凭证过期`；命令提示换令牌；旧快照保留 |
| 非 200 / 非 JSON / 业务码异常 | 归类为 `http` 失败，保留旧快照，命令给出状态码与路径 |
| 网络异常 | 归类为 `network`，同上 |
| 缺字段 | 该积分包被跳过（剩余为 0 的段不算额度），不抛错 |
| `/wb-credits-login` 无参数 | 输出用法与取令牌的位置 |

## 8. 测试（24 个，全过）

纯函数：状态栏 6 类分支、卡片两种形态、千分位/百分比/进度条/日期/年龄、错误描述。
取数：企业 `limitNum` 换算、`-1` 不限量、个人多包合并、缺字段、企业 500 降级、401 抛出、
请求体与请求头、站点分流。
凭证：三级优先级、企业 ID 来源顺序、uid/域名透传、只读明文身份。
命令：登录后能取数、无 token 不发请求、401 后旧值保留且可重复读、本地身份驱动企业接口。

## 9. 不做（YAGNI）

- 不解析客户端本地加密凭证、不读密钥材料
- 不做侧边常驻面板
- 不做充值 / 签到 / 消耗明细 / 多账号切换
- 不改 WorkBuddy 客户端任何状态

## 10. 已知风险

| 风险 | 缓解 |
|---|---|
| 接口是客户端内部接口，升级可能改路径/字段 | 取数集中在 `fetchCredits`；字段用候选列表；失败保留旧快照并报错 |
| token 约 30 天过期 | 401 明确提示；README 写清三种换令牌方式 |
| 企业/个人字段命名不一致 | 归一化层吸收（两种命名都收） |
| 插件 store 明文存令牌 | 优先走敏感 userConfig；store 兜底，可 `/wb-credits-logout` 清除 |
