/**
 * wb-credits 的纯逻辑：把 WorkBuddy 的计费响应归一化成快照，再把快照排成卡片与状态栏文本。
 *
 * 这里不碰 `$`：网络、时钟、账号身份都由调用方注入，`claude plugin test` 可以直接验证。
 *
 * 接口与字段沿用 workbuddy-gateway（`app/credits.py`）里已经跑通的实现：
 * 个人额度走 `/v2/billing/meter/get-user-resource`（分页 + ProductCode），
 * 企业额度走 `/v2/billing/meter/get-enterprise-user-usage`（limitNum/credit）。
 */

/** 一次查询要用的凭证与账号坐标。 */
export type Credentials = {
  token: string
  enterpriseId?: string
  uid?: string
  domain?: string
}

/** 从 WorkBuddy 客户端本地文件读到的明文身份（不含任何加密字段）。 */
export type Identity = {
  uid?: string
  displayName?: string
  enterpriseName?: string
  accountType?: string
  enterpriseId?: string
  domain?: string
}

/** 一个积分包的剩余、总量与到期时间。 */
export type CreditPackage = {
  code: string
  label: string
  left: number
  total: number
  expiresAt?: number
}

/** 一次成功取数的结果，也是写进 `$.store` 的快照。 */
export type Snapshot = {
  fetchedAt: number
  scope: 'enterprise' | 'personal'
  left: number
  total: number
  unlimited: boolean
  resetAt?: number
  packages: CreditPackage[]
  identity: Identity
  /** 企业额度接口失败、当前数值来自个人额度。 */
  enterpriseFailed: boolean
  /** 今日实际扣除的积分与请求数；接口不可用时没有。 */
  today?: TodayUsage
}

/** 今日用量：实际扣除的积分与请求次数。 */
export type TodayUsage = { credits: number; requests: number }

/** 一次失败的原因，够拼出给人看的一句话。 */
export type FetchError =
  | { kind: 'no-token' }
  | { kind: 'auth'; status: number }
  | { kind: 'http'; status: number; path: string; message: string }
  | { kind: 'network'; message: string }

/** 把 `FetchError` 当异常抛出去时的载体。 */
export class CreditsError extends Error {
  readonly detail: FetchError

  constructor(detail: FetchError) {
    super(describeError(detail))
    this.name = 'CreditsError'
    this.detail = detail
  }
}

/** 某个值当令牌/企业 ID 用时是不是有效文本。 */
export function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 插件 store 在用户目录下的位置；同一插件不同加载路径会落到不同文件。 */
export const STORE_DIR = '.claude/plugins/store'
export const STORE_PREFIX = 'wb-credits_'

/**
 * 从真实 store 文件名里认出属于本插件的那些。
 *
 * 同一份插件经 `plugin install` 与 `CLAUDE_CODE_PLUGIN_DIRS` 加载时名字不同
 * （`wb-credits-local` 与 `inline`），令牌会各存一份；这里跨路径复用。
 */
export function isOwnStoreName(name: string): boolean {
  return name.startsWith(STORE_PREFIX) && name.endsWith('.json')
}

export type StoreSnapshot = { token?: string; refreshToken?: string }

/** 解析一份 store 文件，只认令牌字段。 */
export function parseStore(text: string): StoreSnapshot | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }

  const root = asObject(parsed)
  if (!root) return undefined

  const token = asText(root['token'])
  const refreshToken = asText(root['refreshToken'])
  if (!token && !refreshToken) return undefined

  return {
    ...(token ? { token } : {}),
    ...(refreshToken ? { refreshToken } : {}),
  }
}

/** 按「userConfig → 插件 store → 环境变量」的优先级挑出令牌，其余坐标尽力补全。 */
export function pickCredentials(sources: {
  tokenFromConfig?: string
  tokenFromStore?: string
  tokenFromEnv?: string
  enterpriseIdFromConfig?: string
  enterpriseIdFromStore?: string
  identity?: Identity
}): Credentials | undefined {
  const token = sources.tokenFromConfig ?? sources.tokenFromStore ?? sources.tokenFromEnv
  if (!token) return undefined

  const identity = sources.identity ?? {}
  const credentials: Credentials = { token }

  const enterpriseId =
    sources.enterpriseIdFromConfig ?? sources.enterpriseIdFromStore ?? identity.enterpriseId
  if (enterpriseId) credentials.enterpriseId = enterpriseId

  const uid = asText(identity.uid)
  if (uid) credentials.uid = uid

  const domain = asText(identity.domain)
  if (domain) credentials.domain = domain

  return credentials
}

/**
 * 从客户端本地登录态里取出明文身份字段。
 *
 * 只读 `account` 与 `auth` 下的普通字段；加密过的凭证字段一概不碰。
 */
export function parseAuthInfo(text: string): Identity | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }

  const root = asObject(parsed)
  const account = readObject(root, 'account')
  const auth = readObject(root, 'auth')
  if (!account && !auth) return undefined

  const identity: Identity = {
    uid: readString(account, 'uid'),
    displayName: readString(account, 'displayName'),
    enterpriseName: readString(account, 'enterpriseName'),
    accountType: readString(account, 'type'),
    enterpriseId: readString(account, 'enterpriseId'),
    domain: readString(auth, 'domain'),
  }

  const hasSomething = Object.values(identity).some(value => value !== undefined)
  return hasSomething ? identity : undefined
}

/** 把一次失败的调用变成 `FetchError`。 */
export function toFetchError(error: unknown): FetchError {
  if (error instanceof CreditsError) return error.detail
  return { kind: 'network', message: messageOf(error) }
}

/** 一句话说清失败原因。 */
export function describeError(error: FetchError): string {
  if (error.kind === 'no-token') return '还没有配置 WorkBuddy 令牌'
  if (error.kind === 'auth') return `令牌被拒绝（HTTP ${error.status}）`
  if (error.kind === 'http') return `${error.path} 返回 HTTP ${error.status}：${error.message}`
  return `网络请求失败：${error.message}`
}

// ---------------------------------------------------------------- 取数

/** 计费站点按账号域名分流，与网关的 `BILLING_PROFILE_HOSTS` 一致。 */
export function billingHost(domain: string | undefined): string {
  const host = (domain ?? '').toLowerCase()

  if (host === 'www.workbuddy.cn' || host.endsWith('.workbuddy.cn')) return 'https://www.workbuddy.cn'
  if (host === 'www.workbuddy.ai' || host.endsWith('.workbuddy.ai')) return 'https://www.workbuddy.ai'
  if (host === 'www.codebuddy.ai' || host.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return 'https://www.codebuddy.cn'
}

const PATH_RESOURCE = '/v2/billing/meter/get-user-resource'
const PATH_ENTERPRISE = '/v2/billing/meter/get-enterprise-user-usage'

const PATH_USAGE = '/billing/meter/get-user-request-usage'
const PRODUCT_CODE = 'p_tcaca'
const PAGE_SIZE = 100
const USAGE_PAGE_SIZE = 500
const USAGE_MAX_PAGES = 40
const MAX_PAGES = 20

/** 只声明用到的那一面，`$` 与测试里的假实现都能满足。 */
export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; ok: boolean; text: string }>

export type FetchDeps = {
  fetch: HttpFetch
  now: () => Promise<number>
  identity: Identity
}

/** 查一次积分：企业账号优先走企业额度，个人额度始终用来补积分包明细。 */
export async function fetchCredits(deps: FetchDeps, credentials: Credentials): Promise<Snapshot> {
  const fetchedAt = await deps.now()
  const host = billingHost(credentials.domain ?? deps.identity.domain)
  const headers = buildHeaders(host, credentials)

  let enterprise: { left: number; total: number; unlimited: boolean; resetAt?: number } | undefined
  let enterpriseFailed = false

  if (credentials.enterpriseId) {
    try {
      const payload = await post(deps, `${host}${PATH_ENTERPRISE}`, PATH_ENTERPRISE, headers)
      const parsed = parseEnterpriseUsage(payload)
      if (parsed) {
        enterprise = parsed
      } else {
        enterpriseFailed = true
      }
    } catch (error) {
      if (isAuthFailure(error)) throw error
      enterpriseFailed = true
    }
  }

  const today = await fetchTodayUsage(deps, host, headers).catch(() => undefined)

  let packages: CreditPackage[] = []
  let personalError: unknown

  try {
    packages = await fetchPackages(deps, host, headers)
  } catch (error) {
    if (isAuthFailure(error)) throw error
    personalError = error
  }

  const personalLeft = packages.reduce((sum, item) => sum + item.left, 0)
  const personalTotal = packages.reduce((sum, item) => sum + item.total, 0)

  const base = {
    fetchedAt,
    packages,
    identity: deps.identity,
    enterpriseFailed,
    ...(today ? { today } : {}),
  }

  if (enterprise) {
    return { ...base, scope: 'enterprise', ...enterprise }
  }

  if (personalError === undefined) {
    return {
      ...base,
      scope: 'personal',
      left: personalLeft,
      total: personalTotal,
      unlimited: false,
    }
  }

  throw personalError
}

/**
 * 今日（本地日）的实际扣除：把当天的请求明细合计成「次数 + 积分」。
 *
 * 服务端按时间倒序返回，翻到第一条早于今天就停；
 * 翻页有上限，撞到上限时保留已统计的部分并标记 `partial`。
 */
async function fetchTodayUsage(
  deps: FetchDeps,
  host: string,
  headers: Record<string, string>,
): Promise<TodayUsage | undefined> {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const format = (date: Date): string => {
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  const todayKey = format(start).slice(0, 10)
  let credits = 0
  let requests = 0
  let reachedOlderDay = false

  for (let page = 1; page <= USAGE_MAX_PAGES; page += 1) {
    const payload = await post(deps, `${host}${PATH_USAGE}`, PATH_USAGE, headers, {
      startTime: format(start),
      endTime: format(now),
      pageNum: page,
      pageSize: USAGE_PAGE_SIZE,
    })

    const data = readObject(asObject(payload), 'data')
    const rows = data?.['data']
    if (!Array.isArray(rows) || rows.length === 0) break

    for (const row of rows) {
      const item = asObject(row)
      if (!item) continue

      const time = asText(item['requestTime']) ?? ''
      if (!time.startsWith(todayKey)) {
        // 倒序返回，遇到更早的日期说明今天已经统计完。
        reachedOlderDay = true
        break
      }

      credits += numberOrUndefined(item['credit']) ?? 0
      requests += 1
    }

    if (reachedOlderDay || rows.length < USAGE_PAGE_SIZE) break
  }

  if (requests === 0 && !reachedOlderDay) return undefined
  return { credits: round2(credits), requests }
}

/** 拉完个人额度的所有分页，抽成积分包并按套餐+到期日合并。 */
async function fetchPackages(
  deps: FetchDeps,
  host: string,
  headers: Record<string, string>,
): Promise<CreditPackage[]> {
  const accounts: unknown[] = []

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = await post(
      deps,
      `${host}${PATH_RESOURCE}`,
      PATH_RESOURCE,
      headers,
      buildResourceBody(page),
    )

    const rows = findAccounts(payload)
    if (!rows) {
      throw new CreditsError({
        kind: 'http',
        status: 200,
        path: PATH_RESOURCE,
        message: '响应里找不到 Accounts',
      })
    }

    accounts.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }

  return mergePackages(accounts.flatMap(extractSegments))
}

/** 官方客户端的活跃套餐过滤条件：只要未过期、未用尽的包。 */
function buildResourceBody(page: number): Record<string, unknown> {
  const format = (date: Date): string => {
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  const begin = new Date()
  const end = new Date(begin.getTime() + 101 * 365 * 86400 * 1000)

  return {
    PageNumber: page,
    PageSize: PAGE_SIZE,
    ProductCode: PRODUCT_CODE,
    Status: [0, 3],
    PackageEndTimeRangeBegin: format(begin),
    PackageEndTimeRangeEnd: format(end),
  }
}

/** 与网关一致的头集合；企业接口少了 tenant 头会直接拒绝。 */
function buildHeaders(host: string, credentials: Credentials): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-client-platform': 'web',
    origin: host,
    referer: `${host}/profile/plans-usage`,
    authorization: `Bearer ${credentials.token}`,
    'x-user-id': credentials.uid ?? '',
    'x-domain': credentials.domain ?? '',
    'x-enterprise-id': credentials.enterpriseId ?? '',
    'x-tenant-id': credentials.enterpriseId ?? '',
  }
}

async function post(
  deps: FetchDeps,
  url: string,
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  let response: { status: number; ok: boolean; text: string }
  try {
    response = await deps.fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (error) {
    throw new CreditsError({ kind: 'network', message: messageOf(error) })
  }

  if (response.status === 401) {
    throw new CreditsError({ kind: 'auth', status: response.status })
  }
  if (response.status !== 200) {
    throw new CreditsError({
      kind: 'http',
      status: response.status,
      path,
      message: `HTTP ${response.status}`,
    })
  }

  let payload: unknown
  try {
    payload = JSON.parse(response.text)
  } catch {
    throw new CreditsError({ kind: 'http', status: response.status, path, message: '响应不是 JSON' })
  }

  const code = numberOrUndefined(asObject(payload)?.['code'])
  if (code !== undefined && code !== 0 && code !== 200) {
    const reason =
      readString(asObject(payload), 'msg') ?? readString(asObject(payload), 'message') ?? `业务码 ${code}`
    throw new CreditsError({ kind: 'http', status: response.status, path, message: reason })
  }

  return payload
}

/** `data.Response.Data.Accounts` / `data.Accounts` / `data.accounts` 都见过。 */
function findAccounts(payload: unknown): unknown[] | undefined {
  const data = readObject(asObject(payload), 'data')
  if (!data) return undefined

  const response = asObject(data['Response'])
  const nested = asObject(data['data'])
  const nestedResponse = asObject(nested?.['Response'])

  for (const candidate of [asObject(response?.['Data']), asObject(nestedResponse?.['Data']), data]) {
    const accounts = candidate?.['Accounts']
    if (Array.isArray(accounts)) return accounts
  }

  const lower = data['accounts']
  return Array.isArray(lower) ? lower : undefined
}

const REMAINING_FIELDS = [
  'SlicePeriodCapacityRemainPrecise',
  'SlicePeriodCapacityRemain',
  'CycleCapacityRemainPrecise',
  'CycleCapacityRemain',
  'CapacityRemainPrecise',
  'CapacityRemain',
  'RemainPrecise',
  'Remain',
  'Remaining',
  'Balance',
]

const TOTAL_FIELDS = [
  'SlicePeriodCapacitySizePrecise',
  'SlicePeriodCapacitySize',
  'CycleCapacitySizePrecise',
  'CycleCapacitySize',
  'CycleCapacityPrecise',
  'CycleCapacity',
  'CapacityPrecise',
  'Capacity',
  'TotalCapacityPrecise',
  'TotalCapacity',
  'PackageCapacity',
  'Quota',
  'Amount',
]

const EXPIRY_FIELDS = [
  'DeductionEndTime',
  'ExpiredTime',
  'SlicePeriodEndTime',
  'PackageEndTime',
  'EndTime',
  'CycleEndTime',
  'ExpireTime',
  'ExpirationTime',
  'ValidEndTime',
  'ValidPeriodEndTime',
  'EndAt',
  'ExpireAt',
]

const LABEL_FIELDS = [
  'PackageName',
  'PackageTypeName',
  'AccountName',
  'ProductName',
  'Name',
  'RuleName',
  'Description',
]

/** 一个账号行可能带 `SlicePeriodUsageDetails`，每段各算一个积分包。 */
function extractSegments(account: unknown): CreditPackage[] {
  const row = asObject(account)
  if (!row) return []

  const details = row['SlicePeriodUsageDetails']
  const items =
    Array.isArray(details) && details.length > 0
      ? details.map(detail => ({ ...row, ...asObject(detail) }))
      : [row]

  const out: CreditPackage[] = []
  for (const item of items) {
    const left = firstNumber(item, REMAINING_FIELDS)
    if (left === undefined || left <= 0) continue

    const total = firstNumber(item, TOTAL_FIELDS)
    out.push({
      code: asText(item['PackageCode']) ?? asText(item['packageCode']) ?? '',
      label: firstText(item, LABEL_FIELDS) ?? '积分',
      left: round2(left),
      total: round2(total === undefined ? left : Math.max(total, left)),
      expiresAt: firstTimestamp(item, EXPIRY_FIELDS),
    })
  }

  return out
}

/** 套餐与到期日相同的段合并，未知到期日的排在最后。 */
function mergePackages(segments: CreditPackage[]): CreditPackage[] {
  const merged = new Map<string, CreditPackage>()

  for (const segment of segments) {
    const key = `${segment.code || segment.label}|${segment.expiresAt ?? ''}`
    const existing = merged.get(key)

    if (existing) {
      existing.left = round2(existing.left + segment.left)
      existing.total = round2(existing.total + segment.total)
    } else {
      merged.set(key, { ...segment })
    }
  }

  return [...merged.values()].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))
}

const RESET_FIELDS = ['cycleResetTime', 'CycleResetTime', 'cycle_reset_time']

/** 企业额度：`limitNum`/`limit_num`、`credit`/`used_num`，-1 表示不限量。 */
function parseEnterpriseUsage(
  payload: unknown,
): { left: number; total: number; unlimited: boolean; resetAt?: number } | undefined {
  const data = readObject(asObject(payload), 'data') ?? asObject(payload)
  if (!data) return undefined

  const candidates = [readObject(data, 'data') ?? data, data, asObject(payload)]

  for (const candidate of candidates) {
    if (!candidate) continue

    const limit = firstNumber(candidate, ['limitNum', 'limit_num'])
    if (limit === undefined) continue

    if (limit === -1) {
      return { left: 0, total: 0, unlimited: true, resetAt: firstTimestamp(candidate, RESET_FIELDS) }
    }

    const used = firstNumber(candidate, ['credit', 'used_num']) ?? 0
    return {
      left: round2(Math.max(0, limit - used)),
      total: round2(limit),
      unlimited: false,
      resetAt: firstTimestamp(candidate, RESET_FIELDS),
    }
  }

  return undefined
}

// ---------------------------------------------------------------- 呈现

/** 低于这个百分比，状态栏加警示记号。 */
export const WARN_PERCENT = 20

/** 这条状态栏最长多少字（引擎容忍 2000，这里只求一眼读完）。 */
const MAX_STATUS = 120

/**
 * 状态栏那一行；没有令牌时返回 undefined 让引擎清空它。
 *
 * 一行里尽量放满有用信息：剩余/总量/百分比、已用量、组织、下次重置、
 * 以及取数失败时的数据年龄与低额度警示。
 *
 * @param snapshot 最近一次成功的快照，没有就 undefined
 * @param error 最近一次刷新的失败原因，成功时为 undefined
 * @param now 当前时间（毫秒），用来算「几分钟前」
 */
export function formatStatus(
  snapshot: Snapshot | undefined,
  error: FetchError | undefined,
  now: number,
): string | undefined {
  if (error?.kind === 'no-token') return undefined
  if (error?.kind === 'auth') return 'WorkBuddy积分 凭证过期'
  if (!snapshot) return error ? 'WorkBuddy积分 ?' : undefined

  const org = snapshot.identity.enterpriseName
  const age = formatAge(now - snapshot.fetchedAt)

  if (snapshot.unlimited) {
    const parts = ['WorkBuddy积分 不限量']
    if (snapshot.today) {
      parts.push(`今日 ${formatNumber(snapshot.today.credits)} 积分 / ${snapshot.today.requests} 次`)
    }
    if (error) parts.push(`${age}更新失败`)
    return truncate(parts.join(' · '))
  }

  const percent = percentOf(snapshot.left, snapshot.total)
  const parts = [
    `WorkBuddy积分 ${formatNumber(snapshot.left)}/${formatNumber(snapshot.total)} (${percent}%)`,
  ]

  if (snapshot.today) {
    parts.push(`今日 ${formatNumber(snapshot.today.credits)} 积分 / ${snapshot.today.requests} 次`)
  }
  if (snapshot.resetAt !== undefined) parts.push(`${formatShortDate(snapshot.resetAt)} 重置`)
  if (error) parts.push(`${age}更新失败`)

  const line = parts.join(' · ')
  return truncate(percent < WARN_PERCENT ? `${line} ⚠` : line)
}

/** 卡片：身份、剩余、积分包明细、刷新时间，失败时附原因与处理办法。 */
export function formatCard(snapshot: Snapshot, error: FetchError | undefined, now: number): string {
  const lines: string[] = []
  const who = formatIdentity(snapshot.identity)
  lines.push(who ? `WorkBuddy积分 · ${who}` : 'WorkBuddy积分')

  if (snapshot.unlimited) {
    lines.push('  剩余   不限量')
  } else {
    const percent = percentOf(snapshot.left, snapshot.total)
    lines.push(
      `  剩余   ${formatNumber(snapshot.left)} / ${formatNumber(snapshot.total)}   ${formatBar(percent)} ${percent}%`,
    )
  }

  for (const item of snapshot.packages) {
    const expiry = item.expiresAt ? `   ${formatDate(item.expiresAt)} 到期` : ''
    lines.push(
      `  ${padName(item.code || item.label)} ${formatNumber(item.left).padStart(8)} / ${formatNumber(item.total).padStart(8)}${expiry}`,
    )
  }

  if (snapshot.today) {
    lines.push(
      `  今日   ${formatNumber(snapshot.today.credits)} 积分 / ${snapshot.today.requests} 次请求`,
    )
  }

  if (snapshot.enterpriseFailed) {
    lines.push('  提示   企业额度暂不可用，以上为个人额度合计')
  }

  const age = formatAge(now - snapshot.fetchedAt)
  if (error) {
    lines.push(`  刷新   ${age} · 本次刷新失败：${describeError(error)}`)
    if (error.kind !== 'http' || error.status === 401 || error.status >= 500) {
      lines.push('  处理   运行 /wb-credits-login <token> 换一个新令牌')
    }
  } else {
    lines.push(`  刷新   ${age}`)
  }

  return lines.join('\n')
}

/** 千分位，最多一位小数；不是有限数时给 `--`。 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '--'

  const rounded = Math.round(value * 10) / 10
  const sign = rounded < 0 ? '-' : ''
  const [whole = '0', fraction] = String(Math.abs(rounded)).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`
}

/** 0–100 的整数百分比；总量不是正数时按 0。 */
export function percentOf(left: number, total: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(total) || total <= 0) return 0
  const raw = Math.round((left / total) * 100)
  return Math.min(100, Math.max(0, raw))
}

/** 十格的进度条。 */
export function formatBar(percent: number): string {
  const filled = Math.min(10, Math.max(0, Math.round(percent / 10)))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

/** 「刚刚 / N 分钟前 / N 小时前 / N 天前」。 */
export function formatAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return '刚刚'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`

  return `${Math.floor(hours / 24)} 天前`
}

/** `11-01` 这样的短日期，跨年时带上年份。 */
export function formatShortDate(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '--'

  const pad = (value: number): string => String(value).padStart(2, '0')
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())

  return date.getFullYear() === new Date(now).getFullYear()
    ? `${month}-${day}`
    : `${date.getFullYear()}-${month}-${day}`
}

/** `2026-11-01` 这样的日期。 */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toISOString().slice(0, 10)
}

function formatIdentity(identity: Identity): string {
  const parts: string[] = []
  if (identity.displayName) parts.push(identity.displayName)
  if (identity.enterpriseName) parts.push(identity.enterpriseName)

  const name = parts.join(' / ')
  const type = identity.accountType ? `（${identity.accountType}）` : ''

  if (!name) return type ? (identity.accountType ?? '') : ''
  return `${name}${type}`
}

function padName(name: string): string {
  const trimmed = name.length > 8 ? `${name.slice(0, 7)}…` : name
  return trimmed.padEnd(8)
}

function truncate(text: string): string {
  return text.length <= MAX_STATUS ? text : `${text.slice(0, MAX_STATUS - 1)}…`
}

// ---------------------------------------------------------------- 小工具

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof CreditsError && error.detail.kind === 'auth'
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readObject(value: unknown, key: string): Record<string, unknown> | undefined {
  return asObject(asObject(value)?.[key])
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const item = value?.[key]
  return typeof item === 'string' && item !== '' ? item : undefined
}

function firstNumber(item: Record<string, unknown>, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const value = numberOrUndefined(item[field])
    if (value !== undefined) return value
  }
  return undefined
}

function firstText(item: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = asText(item[field])
    if (value !== undefined) return value
  }
  return undefined
}

/** 时间戳字段可能是秒、毫秒或 ISO 字符串。 */
function firstTimestamp(
  item: Record<string, unknown>,
  fields: readonly string[],
): number | undefined {
  for (const field of fields) {
    const raw = item[field]

    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Date.parse(raw)
      if (!Number.isNaN(parsed)) return parsed
    }

    const value = numberOrUndefined(raw)
    if (value === undefined || value <= 0) continue
    return value < 1e12 ? value * 1000 : value
  }
  return undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

// ---------------------------------------------------------------- 扫码登录

/**
 * 官网的扫码登录是三步：
 *   1. `POST /v2/plugin/auth/state` 拿 state（附带一个登录页 URL）
 *   2. 用户在浏览器里扫码登录
 *   3. `GET /v2/plugin/auth/token?state=` 换 accessToken
 *
 * 这一步不依赖任何其他项目，也不需要 shell；桌面端与 CLI 会话都能跑。
 */
export const LOGIN_STATE_PATH = '/v2/plugin/auth/state'
export const LOGIN_TOKEN_PATH = '/v2/plugin/auth/token'

/** 登录要用的站点：国内版官网。 */
export const LOGIN_HOST = 'https://www.codebuddy.cn'

export type LoginStart = { state: string; url: string }

/** 申请一个登录 state，并给出让用户去扫的地址。 */
export async function startLogin(deps: FetchDeps, host = LOGIN_HOST): Promise<LoginStart> {
  const payload = await getJson(
    deps,
    `${host}${LOGIN_STATE_PATH}?platform=workbuddy`,
    LOGIN_STATE_PATH,
    { method: 'POST', headers: loginHeaders(), body: '{}' },
  )

  const data = readObject(payload, 'data') ?? asObject(payload)
  const state = asText(data?.['state'])
  if (!state) {
    throw new CreditsError({
      kind: 'http',
      status: 200,
      path: LOGIN_STATE_PATH,
      message: '响应里没有 state',
    })
  }

  const url =
    asText(data?.['authUrl']) ?? asText(data?.['auth_url']) ?? asText(data?.['url']) ??
    `${host}/login?state=${encodeURIComponent(state)}`

  return { state, url }
}

/** 轮询交换令牌；还没扫码时返回 undefined。 */
export async function pollLogin(
  deps: FetchDeps,
  state: string,
  host = LOGIN_HOST,
): Promise<{ token: string; refreshToken?: string; uid?: string } | undefined> {
  const path = `${LOGIN_TOKEN_PATH}?state=${encodeURIComponent(state)}`
  const payload = await getJson(deps, `${host}${path}`, LOGIN_TOKEN_PATH, {
    method: 'GET',
    headers: loginHeaders(),
    body: '',
  })

  const data = readObject(payload, 'data') ?? asObject(payload)
  const token = asText(data?.['accessToken']) ?? asText(data?.['access_token'])
  if (!token) return undefined

  const refreshToken = asText(data?.['refreshToken']) ?? asText(data?.['refresh_token'])
  const uid = asText(data?.['uid'])

  return {
    token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(uid ? { uid } : {}),
  }
}

/** 登录接口用的头，与计费接口分开：这里不需要账号坐标。 */
function loginHeaders(): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0',
  }
}

async function getJson(
  deps: FetchDeps,
  url: string,
  path: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<unknown> {
  let response: { status: number; ok: boolean; text: string }
  try {
    response = await deps.fetch(url, init)
  } catch (error) {
    throw new CreditsError({ kind: 'network', message: messageOf(error) })
  }

  if (response.status === 401) throw new CreditsError({ kind: 'auth', status: response.status })
  if (response.status !== 200) {
    throw new CreditsError({
      kind: 'http',
      status: response.status,
      path,
      message: `HTTP ${response.status}`,
    })
  }

  try {
    return JSON.parse(response.text)
  } catch {
    throw new CreditsError({ kind: 'http', status: response.status, path, message: '响应不是 JSON' })
  }
}

// ---------------------------------------------------------------- 自动续期

/**
 * access token 30 天、refresh token 60 天。官方客户端在 401 时用
 * `POST /v2/plugin/auth/token/refresh` 换新令牌，凭据放在 `X-Refresh-Token` 头里。
 */
export const REFRESH_PATH = '/v2/plugin/auth/token/refresh'

export type RefreshedTokens = { token: string; refreshToken?: string }

/** 用 refresh token 换一对新令牌；失败时抛出 `CreditsError`。 */
export async function refreshTokens(
  deps: FetchDeps,
  refreshToken: string,
  host: string,
): Promise<RefreshedTokens> {
  const payload = await getJson(deps, `${host}${REFRESH_PATH}`, REFRESH_PATH, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-refresh-token': refreshToken,
      'x-auth-refresh-source': 'plugin',
      'user-agent': 'Mozilla/5.0',
    },
    body: '{}',
  })

  // 业务码非 0 时先报原因（例如 refresh token 已过期），不要误报成缺字段。
  const code = numberOrUndefined(asObject(payload)?.['code'])
  if (code !== undefined && code !== 0 && code !== 200) {
    const reason =
      readString(asObject(payload), 'msg') ?? readString(asObject(payload), 'message') ?? `业务码 ${code}`
    throw new CreditsError({ kind: 'http', status: 200, path: REFRESH_PATH, message: reason })
  }

  const data = readObject(payload, 'data') ?? asObject(payload)
  const token = asText(data?.['accessToken']) ?? asText(data?.['access_token'])
  if (!token) {
    throw new CreditsError({
      kind: 'http',
      status: 200,
      path: REFRESH_PATH,
      message: '刷新没有返回新的 accessToken',
    })
  }

  const nextRefresh = asText(data?.['refreshToken']) ?? asText(data?.['refresh_token'])
  return nextRefresh ? { token, refreshToken: nextRefresh } : { token }
}
