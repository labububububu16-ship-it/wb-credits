import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

/** 测试体收到的 `$`，就是引擎自己那个。 */
type Engine = Parameters<TestBody>[0]

import {
  billingHost,
  describeError,
  fetchCredits,
  formatAge,
  formatBar,
  formatCard,
  formatDate,
  formatNumber,
  formatShortDate,
  formatStatus,
  parseAuthInfo,
  percentOf,
  pickCredentials,
  isOwnStoreName,
  parseStore,
  pollLogin,
  refreshTokens,
  startLogin,
  type FetchDeps,
  type Snapshot,
} from './credits'

const NOW = 1_790_000_000_000

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    fetchedAt: NOW,
    scope: 'enterprise',
    left: 1234,
    total: 2000,
    unlimited: false,
    packages: [],
    identity: { displayName: '张三', enterpriseName: '示例事业部', accountType: 'ultimate' },
    enterpriseFailed: false,
    ...overrides,
  }
}

/** 按路径回固定应答的假 fetch；键是路径，值是一次或多次应答。 */
function fakeFetch(
  replies: Record<string, { status?: number; body?: unknown } | { throw: string }>,
): { fetch: FetchDeps['fetch']; calls: string[]; bodies: string[] } {
  const calls: string[] = []
  const bodies: string[] = []

  return {
    calls,
    bodies,
    fetch: async (url, init) => {
      calls.push(url)
      bodies.push(init.body)
      const path = url.replace(/^https:\/\/[^/]+/, '').split('?')[0] ?? ''
      const reply = replies[path]

      if (!reply) throw new Error(`unexpected ${path}`)
      if ('throw' in reply) throw new Error(reply.throw)

      const status = reply.status ?? 200
      return { status, ok: status === 200, text: JSON.stringify(reply.body ?? {}) }
    },
  }
}

const deps = (
  fetch: FetchDeps['fetch'],
  identity: FetchDeps['identity'] = {},
): FetchDeps => ({ fetch, now: async () => NOW, identity })

/** 测试里调命令要带全引擎要求的输入；`origin`/`presentation` 固定即可。 */
function runCommand(
  $: Engine,
  command: string,
  args = '',
): Promise<{ text?: string; context?: readonly string[] }> {
  return $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
}

const RESOURCE = '/v2/billing/meter/get-user-resource'
const ENTERPRISE = '/v2/billing/meter/get-enterprise-user-usage'

/** 一条标准的个人额度响应，包在 `data.Accounts` 里。 */
function resourceBody(accounts: unknown[]): unknown {
  return { code: 0, data: { Accounts: accounts } }
}

// ------------------------------------------------------------ 状态栏

test('状态栏：没有令牌时不占位', async () => {
  expect(formatStatus(undefined, { kind: 'no-token' }, NOW)).toBeUndefined()
  expect(formatStatus(undefined, undefined, NOW)).toBeUndefined()
})

test('状态栏：不限量、正常、低于阈值三种数值形态', async () => {
  expect(formatStatus(snapshot({ unlimited: true }), undefined, NOW)).toBe(
    'WorkBuddy积分 不限量',
  )
  expect(formatStatus(snapshot(), undefined, NOW)).toBe('WorkBuddy积分 1,234/2,000 (62%)')
  expect(formatStatus(snapshot({ left: 214 }), undefined, NOW)).toBe(
    'WorkBuddy积分 214/2,000 (11%) ⚠',
  )
})

test('状态栏：刷新失败时附上数据年龄', async () => {
  const old = snapshot({ fetchedAt: NOW - 3 * 60 * 60 * 1000 })
  expect(formatStatus(old, { kind: 'network', message: 'boom' }, NOW)).toBe(
    'WorkBuddy积分 1,234/2,000 (62%) · 3 小时前更新失败',
  )
})

test('状态栏：令牌失效', async () => {
  expect(formatStatus(snapshot(), { kind: 'auth', status: 401 }, NOW)).toBe('WorkBuddy积分 凭证过期')
})

// ------------------------------------------------------------ 卡片

test('卡片：企业账号只有总额', async () => {
  const lines = formatCard(snapshot(), undefined, NOW).split('\n')

  expect(lines[0]).toBe('WorkBuddy积分 · 张三 / 示例事业部（ultimate）')
  expect(lines[1]).toBe('  剩余   1,234 / 2,000   ██████░░░░ 62%')
  expect(lines[2]).toBe('  刷新   刚刚')
})

test('卡片：列出积分包与到期日，失败时给出处理办法', async () => {
  const text = formatCard(
    snapshot({
      scope: 'personal',
      packages: [
        { code: 'proMon', label: '专业版月付', left: 800, total: 1200, expiresAt: Date.UTC(2026, 10, 1) },
        { code: 'extra', label: '加购包', left: 434, total: 800 },
      ],
    }),
    { kind: 'http', status: 500, path: RESOURCE, message: 'HTTP 500' },
    NOW,
  )

  expect(text).toContain('proMon')
  expect(text).toContain('2026-11-01 到期')
  expect(text).toContain('extra')
  expect(text).toContain('本次刷新失败')
  expect(text).toContain('/wb-credits-login <token>')
})

// ------------------------------------------------------------ 取数

test('企业响应：limitNum 与 credit 换算成剩余', async () => {
  const fake = fakeFetch({
    [ENTERPRISE]: { body: { code: 0, data: { limitNum: 2000, credit: 766, cycleResetTime: 0 } } },
    [RESOURCE]: { body: resourceBody([]) },
  })

  const result = await fetchCredits(deps(fake.fetch), { token: 't', enterpriseId: 'e1' })

  expect(result.scope).toBe('enterprise')
  expect(result.left).toBe(1234)
  expect(result.total).toBe(2000)
  expect(result.unlimited).toBe(false)
})

test('企业响应：limit_num 为 -1 表示不限量', async () => {
  const fake = fakeFetch({
    [ENTERPRISE]: { body: { code: 0, data: { limit_num: -1 } } },
    [RESOURCE]: { body: resourceBody([]) },
  })

  const result = await fetchCredits(deps(fake.fetch), { token: 't', enterpriseId: 'e1' })

  expect(result.unlimited).toBe(true)
})

test('个人响应：按字段优先级抽段并合并', async () => {
  const fake = fakeFetch({
    [RESOURCE]: {
      body: resourceBody([
        {
          PackageCode: 'proMon',
          PackageName: '专业版月付',
          CycleCapacityRemainPrecise: 800,
          CycleCapacitySizePrecise: 1200,
          PackageEndTime: '2026-11-01 00:00:00',
        },
        {
          PackageCode: 'extra',
          PackageName: '加购包',
          SlicePeriodCapacityRemain: 434,
          SlicePeriodCapacitySize: 800,
        },
      ]),
    },
  })

  const result = await fetchCredits(deps(fake.fetch), { token: 't' })

  expect(result.scope).toBe('personal')
  expect(result.left).toBe(1234)
  expect(result.total).toBe(2000)
  expect(result.packages).toHaveLength(2)
  expect(result.packages[0]?.code).toBe('proMon')
  expect(result.packages[0]?.expiresAt).toBe(Date.parse('2026-11-01 00:00:00'))
})

test('缺字段：剩余为 0 的段被丢掉，不抛错', async () => {
  const fake = fakeFetch({
    [RESOURCE]: { body: resourceBody([{ PackageCode: 'x' }]) },
  })

  const result = await fetchCredits(deps(fake.fetch), { token: 't' })

  expect(result.left).toBe(0)
  expect(result.total).toBe(0)
  expect(result.packages).toEqual([])
  expect(formatNumber(result.left)).toBe('0')
})

test('企业接口 500 时降级到个人额度', async () => {
  const fake = fakeFetch({
    [ENTERPRISE]: { status: 500, body: {} },
    [RESOURCE]: {
      body: resourceBody([
        { PackageCode: 'proMon', CycleCapacityRemain: 40, CycleCapacitySize: 100 },
      ]),
    },
  })

  const result = await fetchCredits(deps(fake.fetch), { token: 't', enterpriseId: 'e1' })

  expect(result.scope).toBe('personal')
  expect(result.enterpriseFailed).toBe(true)
  expect(result.left).toBe(40)
})

test('401 直接抛鉴权错误', async () => {
  const fake = fakeFetch({ [ENTERPRISE]: { status: 401, body: {} } })

  await expect(
    fetchCredits(deps(fake.fetch), { token: 't', enterpriseId: 'e1' }),
  ).rejects.toThrow(/令牌被拒绝/)
})

test('请求体带上官方过滤条件与会话坐标', async () => {
  const fake = fakeFetch({
    [ENTERPRISE]: { body: { code: 0, data: { limitNum: 10, credit: 0 } } },
    [RESOURCE]: { body: resourceBody([]) },
  })

  await fetchCredits(deps(fake.fetch), {
    token: 't',
    enterpriseId: 'e1',
    uid: 'u1',
    domain: 'www.workbuddy.cn',
  })

  expect(fake.calls[0]).toBe(`https://www.workbuddy.cn${ENTERPRISE}`)
  expect(fake.bodies[0]).toBe('{}')

  const resource = JSON.parse(fake.bodies.find((body, index) => fake.calls[index]?.endsWith('/get-user-resource')) ?? '{}')
  expect(resource.ProductCode).toBe('p_tcaca')
  expect(resource.Status).toEqual([0, 3])
  expect(resource.PageSize).toBe(100)
})

test('计费站点按域名分流', async () => {
  expect(billingHost('www.workbuddy.cn')).toBe('https://www.workbuddy.cn')
  expect(billingHost('www.workbuddy.ai')).toBe('https://www.workbuddy.ai')
  expect(billingHost('www.codebuddy.ai')).toBe('https://www.codebuddy.ai')
  expect(billingHost(undefined)).toBe('https://www.codebuddy.cn')
})

// ------------------------------------------------------------ 凭证

test('凭证优先级：userConfig > store > 环境变量', async () => {
  expect(pickCredentials({ tokenFromConfig: 'c', tokenFromStore: 's', tokenFromEnv: 'e' })).toEqual({
    token: 'c',
  })
  expect(pickCredentials({ tokenFromStore: 's', tokenFromEnv: 'e' })).toEqual({ token: 's' })
  expect(pickCredentials({ tokenFromEnv: 'e' })).toEqual({ token: 'e' })
  expect(pickCredentials({})).toBeUndefined()
})

test('凭证：企业 ID 依次取 userConfig、store、本地文件', async () => {
  expect(
    pickCredentials({
      tokenFromStore: 't',
      enterpriseIdFromStore: 's',
      identity: { enterpriseId: 'file' },
    }),
  ).toEqual({ token: 't', enterpriseId: 's' })
  expect(pickCredentials({ tokenFromStore: 't', identity: { enterpriseId: 'file' } })).toEqual({
    token: 't',
    enterpriseId: 'file',
  })
})

test('凭证：uid 与域名一并带上', async () => {
  expect(
    pickCredentials({ tokenFromStore: 't', identity: { uid: 'u1', domain: 'www.workbuddy.cn' } }),
  ).toEqual({ token: 't', uid: 'u1', domain: 'www.workbuddy.cn' })
})

test('本地登录态：只读明文身份字段', async () => {
  const text = JSON.stringify({
    auth: {
      accessToken: { $wbEncrypted: 1, envelope: 'secret' },
      domain: 'www.workbuddy.cn',
    },
    account: {
      uid: 'u1',
      nickname: { $wbEncrypted: 1, envelope: 'secret' },
      displayName: '张三',
      enterpriseId: 'ent-demo-0001',
      enterpriseName: '示例事业部',
      type: 'ultimate',
    },
  })

  expect(parseAuthInfo(text)).toEqual({
    uid: 'u1',
    displayName: '张三',
    enterpriseId: 'ent-demo-0001',
    enterpriseName: '示例事业部',
    accountType: 'ultimate',
    domain: 'www.workbuddy.cn',
  })
  expect(parseAuthInfo('not json')).toBeUndefined()
  expect(parseAuthInfo('{}')).toBeUndefined()
})

// ------------------------------------------------------------ 命令与刷新

/** 会话启动需要的桩：注册命令、读本地文件。store/clock/env 由 `mock` 供给。 */
function stubs(on: On, home?: string): void {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('fs.exists', () => ({ value: home !== undefined }))
  on('fs.read', () => ({ value: home ?? '' }))}

test('wb-credits-login 存下的令牌，刷新时能用上', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  stubs(on)

  const requested: string[] = []
  on('http.fetch', (_, e) => {
    requested.push(e.url)
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify(resourceBody([
          { PackageCode: 'proMon', CycleCapacityRemain: 60, CycleCapacitySize: 100 },
        ])),
      },
    }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const result = await runCommand($, 'wb-credits-login', 'tok-123')

  expect(requested.length).toBeGreaterThanOrEqual(1)
  expect(result.text).toContain('令牌已保存')
  expect(result.text).toContain('60 / 100')
})

test('没有令牌时命令给出三条指引，且不发起请求', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  stubs(on)

  let requests = 0
  on('http.fetch', () => {
    requests += 1
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const result = await runCommand($, 'wb-credits')

  expect(requests).toBe(0)
  expect(result.text).toContain('/wb-credits-login <token>')
})

test('401 之后旧快照仍在，命令继续显示上一次的数值', async ($, on) => {
  const previous = snapshot({ fetchedAt: NOW - 60_000 })
  mock.store(on, { token: 't', snapshot: previous })
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  stubs(on)

  on('http.fetch', () => ({ value: { status: 401, ok: false, headers: {}, text: '{}' } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const result = await runCommand($, 'wb-credits')

  expect(result.text).toContain('1,234')
  expect(result.text).toContain('本次刷新失败')

  const again = await runCommand($, 'wb-credits')
  expect(again.text).toContain('1,234')
})

test('本地登录态提供企业 ID 时走企业接口', async ($, on) => {
  const authInfo = JSON.stringify({
    auth: { domain: 'www.workbuddy.cn' },
    account: { uid: 'u1', displayName: '张三', enterpriseId: 'ent-demo-0001', type: 'ultimate' },
  })
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, { CODEBUDDY_AUTH_TOKEN: 'env-token', HOME: '/home/u' })
  stubs(on, authInfo)

  const seen: { path: string; tenant?: string; uid?: string }[] = []
  on('http.fetch', (_, e) => {
    const path = e.url.replace(/^https:\/\/[^/]+/, '')
    seen.push({ path, tenant: e.init?.headers?.['x-enterprise-id'], uid: e.init?.headers?.['x-user-id'] })

    if (path === ENTERPRISE) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ code: 0, data: { limitNum: 500, credit: 100 } }),
        },
      }
    }

    return {
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify(resourceBody([])) },
    }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const result = await runCommand($, 'wb-credits')

  expect(seen[0]?.path).toBe(ENTERPRISE)
  expect(seen[0]?.tenant).toBe('ent-demo-0001')
  expect(seen[0]?.uid).toBe('u1')
  expect(result.text).toContain('400 / 500')
})

// ------------------------------------------------------------ 单位换算

test('单位换算：千分位、百分比、进度条、日期、年龄', async () => {
  expect(formatNumber(1234)).toBe('1,234')
  expect(formatNumber(1234.56)).toBe('1,234.6')
  expect(formatNumber(Number.NaN)).toBe('--')
  expect(percentOf(1, 0)).toBe(0)
  expect(percentOf(1, 3)).toBe(33)
  expect(formatBar(62)).toBe('██████░░░░')
  expect(formatDate(Date.UTC(2026, 10, 1))).toBe('2026-11-01')
  expect(formatAge(30_000)).toBe('刚刚')
  expect(formatAge(90_000)).toBe('1 分钟前')
  expect(formatAge(3 * 3600_000)).toBe('3 小时前')
  expect(formatAge(2 * 86400_000)).toBe('2 天前')
  expect(formatShortDate(Date.UTC(2026, 10, 1), Date.UTC(2026, 0, 1))).toBe('11-01')
  expect(formatShortDate(Date.UTC(2027, 0, 5), Date.UTC(2026, 0, 1))).toBe('2027-01-05')
})

test('失败原因有可读的描述', async () => {
  expect(describeError({ kind: 'no-token' })).toContain('令牌')
  expect(describeError({ kind: 'auth', status: 401 })).toContain('401')
  expect(describeError({ kind: 'http', status: 500, path: RESOURCE, message: 'HTTP 500' })).toContain(
    RESOURCE,
  )
  expect(describeError({ kind: 'network', message: 'offline' })).toContain('offline')
})

// ------------------------------------------------------------ 扫码登录

const AUTH_STATE = '/v2/plugin/auth/state'
const AUTH_TOKEN = '/v2/plugin/auth/token'

test('扫码：申请 state 并给出登录地址', async () => {
  const fake = fakeFetch({
    [AUTH_STATE]: { body: { code: 0, data: { state: 'st-1', authUrl: 'https://x/login?state=st-1' } } },
  })

  const started = await startLogin(deps(fake.fetch))

  expect(started.state).toBe('st-1')
  expect(started.url).toBe('https://x/login?state=st-1')
  expect(fake.calls[0]).toContain(AUTH_STATE)
})

test('扫码：没给 authUrl 时自己拼一个', async () => {
  const fake = fakeFetch({ [AUTH_STATE]: { body: { data: { state: 'st 2' } } } })
  const started = await startLogin(deps(fake.fetch))

  expect(started.url).toContain('state=st%202')
})

test('扫码：未授权时轮询返回 undefined，授权后返回令牌', async () => {
  let authorized = false
  const fake: { fetch: FetchDeps['fetch']; calls: string[]; bodies: string[] } = {
    calls: [],
    bodies: [],
    fetch: async url => {
      fake.calls.push(url)
      return {
        status: 200,
        ok: true,
        text: JSON.stringify(
          authorized
            ? { code: 0, data: { accessToken: 'tok-abc', uid: 'u1' } }
            : { code: 0, data: {} },
        ),
      }
    },
  }

  expect(await pollLogin(deps(fake.fetch), 'st-1')).toBeUndefined()

  authorized = true
  expect(await pollLogin(deps(fake.fetch), 'st-1')).toEqual({ token: 'tok-abc', uid: 'u1' })
})

test('扫码：state 缺失时报错而不是静默', async () => {
  const fake = fakeFetch({ [AUTH_STATE]: { body: { code: 0, data: {} } } })
  await expect(startLogin(deps(fake.fetch))).rejects.toThrow(/state/)
})

test('扫码：网络失败归类为 network', async () => {
  const fake = fakeFetch({ [AUTH_STATE]: { throw: 'offline' } })
  await expect(startLogin(deps(fake.fetch))).rejects.toMatchObject({
    detail: { kind: 'network' },
  })
})

// ------------------------------------------------------------ 自动续期

const REFRESH = '/v2/plugin/auth/token/refresh'

test('续期：用 refresh token 换新令牌并带上正确请求头', async () => {
  const seen: { url: string; headers?: Record<string, string> }[] = []
  const fake: { fetch: FetchDeps['fetch']; calls: string[]; bodies: string[] } = {
    calls: [],
    bodies: [],
    fetch: async (url, init) => {
      seen.push({ url, headers: init.headers })
      return {
        status: 200,
        ok: true,
        text: JSON.stringify({
          code: 0,
          data: { accessToken: 'new-access', refreshToken: 'new-refresh' },
        }),
      }
    },
  }

  const result = await refreshTokens(deps(fake.fetch), 'old-refresh', 'https://www.codebuddy.cn')

  expect(result).toEqual({ token: 'new-access', refreshToken: 'new-refresh' })
  expect(seen[0]?.url).toBe(`https://www.codebuddy.cn${REFRESH}`)
  expect(seen[0]?.headers?.['x-refresh-token']).toBe('old-refresh')
  expect(seen[0]?.headers?.['x-auth-refresh-source']).toBe('plugin')
})

test('续期：没返回新 refreshToken 时只保留 accessToken', async () => {
  const fake = fakeFetch({ [REFRESH]: { body: { code: 0, data: { accessToken: 'only-access' } } } })
  expect(await refreshTokens(deps(fake.fetch), 'r', 'https://www.codebuddy.cn')).toEqual({
    token: 'only-access',
  })
})

test('续期：refresh token 失效时报错，不当成成功', async () => {
  const fake = fakeFetch({ [REFRESH]: { body: { code: 40001, msg: 'refresh token expired' } } })
  await expect(refreshTokens(deps(fake.fetch), 'r', 'https://www.codebuddy.cn')).rejects.toThrow(
    /refresh token expired/,
  )
})

test('续期：没有 accessToken 时报错', async () => {
  const fake = fakeFetch({ [REFRESH]: { body: { code: 0, data: {} } } })
  await expect(
    refreshTokens(deps(fake.fetch), 'r', 'https://www.codebuddy.cn'),
  ).rejects.toThrow(/accessToken/)
})

test('扫码：令牌响应里带 refreshToken 时一并交出', async () => {
  const fake: { fetch: FetchDeps['fetch']; calls: string[]; bodies: string[] } = {
    calls: [],
    bodies: [],
    fetch: async () => ({
      status: 200,
      ok: true,
      text: JSON.stringify({
        code: 0,
        data: { accessToken: 'a1', refreshToken: 'r1', uid: 'u1' },
      }),
    }),
  }

  expect(await pollLogin(deps(fake.fetch), 'st')).toEqual({
    token: 'a1',
    refreshToken: 'r1',
    uid: 'u1',
  })
})

test('401 后自动续期并重试成功（命令层）', async ($, on) => {
  mock.store(on, { token: 'stale', refreshToken: 'r1' })
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  stubs(on)

  let enterpriseCalls = 0
  on('http.fetch', (_, e) => {
    const path = e.url.replace(/^https:\/\/[^/]+/, '').split('?')[0]

    if (path === REFRESH) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ code: 0, data: { accessToken: 'fresh', refreshToken: 'r2' } }),
        },
      }
    }

    enterpriseCalls += 1
    // 第一次用旧令牌 → 401；续期后 → 正常数据
    if (enterpriseCalls === 1) {
      return { value: { status: 401, ok: false, headers: {}, text: '{}' } }
    }

    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify(resourceBody([
          { PackageCode: 'proMon', CycleCapacityRemain: 77, CycleCapacitySize: 100 },
        ])),
      },
    }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const result = await runCommand($, 'wb-credits')

  expect(enterpriseCalls).toBe(2)
  expect(result.text).toContain('77 / 100')
})

test('没有 refreshToken 时 401 仍然报凭证过期', async ($, on) => {
  mock.store(on, { token: 'stale' })
  mock.clock(on, { now: NOW })
  mock.env(on, {})
  stubs(on)

  on('http.fetch', () => ({ value: { status: 401, ok: false, headers: {}, text: '{}' } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const result = await runCommand($, 'wb-credits')

  expect(result.text).toContain('401')
})

// ------------------------------------------------------------ 跨加载路径复用

test('store 文件名只认本插件的', async () => {
  expect(isOwnStoreName('wb-credits_wb-credits-local-a9f465488041.json')).toBe(true)
  expect(isOwnStoreName('wb-credits_inline-8cb000f5eb5b.json')).toBe(true)
  expect(isOwnStoreName('other-plugin_x.json')).toBe(false)
  expect(isOwnStoreName('wb-credits_x.txt')).toBe(false)
})

test('解析 store：只取令牌字段', async () => {
  expect(parseStore(JSON.stringify({ token: 't1', refreshToken: 'r1', snapshot: { big: true } }))).toEqual({
    token: 't1',
    refreshToken: 'r1',
  })
  expect(parseStore(JSON.stringify({ token: 't1' }))).toEqual({ token: 't1' })
  expect(parseStore(JSON.stringify({ snapshot: {} }))).toBeUndefined()
  expect(parseStore('not json')).toBeUndefined()
})

test('自身 store 为空时，从同插件另一加载路径借令牌', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/u' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({
    value: [
      { name: 'other-plugin_x.json', kind: 'file', size: 10, mtimeMs: 3, isLink: false },
      { name: 'wb-credits_inline-abc.json', kind: 'file', size: 10, mtimeMs: 2, isLink: false },
    ],
  }))
  on('fs.read', () => ({ value: JSON.stringify({ token: 'borrowed' }) }))

  let sawAuth = ''
  on('http.fetch', (_, e) => {
    sawAuth = String(e.init?.headers?.authorization ?? '')
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify(resourceBody([
          { PackageCode: 'p', CycleCapacityRemain: 50, CycleCapacitySize: 100 },
        ])),
      },
    }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const result = await runCommand($, 'wb-credits')

  expect(sawAuth).toBe('Bearer borrowed')
  expect(result.text).toContain('50 / 100')
})

test('今日用量：只累计当天的行', async () => {
  const today = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00:00`

  const fake = fakeFetch({
    [RESOURCE]: { body: resourceBody([]) },
    ['/billing/meter/get-user-request-usage']: {
      body: {
        code: 0,
        data: {
          total: 3,
          data: [
            { requestTime: stamp(today), credit: 0.5 },
            { requestTime: stamp(today), credit: 1.25 },
            { requestTime: stamp(new Date(today.getTime() - 3 * 86400_000)), credit: 9 },
          ],
        },
      },
    },
  })

  const result = await fetchCredits(deps(fake.fetch), { token: 't' })

  expect(result.today).toEqual({ credits: 1.75, requests: 2 })
  expect(formatStatus(result, undefined, NOW)).toContain('今日 1.8 积分 / 2 次')
})
