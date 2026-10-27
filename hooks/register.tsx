/**
 * wb-credits —— 在 Claude Code 里查看 WorkBuddy 的积分余额。
 *
 * `/wb-credits`         打印积分卡片，并顺手刷新一次
 * `/wb-credits-login`   用粘贴的令牌覆盖插件内保存的令牌
 * `/wb-credits-logout`  清掉插件内保存的令牌与快照
 *
 * 状态栏常驻一行，`session.start` 与每 10 分钟刷新一次。
 * 令牌优先级：userConfig（系统安全存储）→ 插件 store → CODEBUDDY_AUTH_TOKEN。
 */
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  asText,
  billingHost,
  describeError,
  fetchCredits,
  formatCard,
  formatNumber,
  formatStatus,
  isOwnStoreName,
  parseAuthInfo,
  parseStore,
  pickCredentials,
  pollLogin,
  refreshTokens,
  startLogin,
  STORE_DIR,
  STORE_PREFIX,
  toFetchError,
  type Credentials,
  type FetchDeps,
  type FetchError,
  type Identity,
  type LoginStart,
  type Snapshot,
  type StoreSnapshot,
} from './credits'

const KEY_TOKEN = 'token'
const KEY_REFRESH = 'refreshToken'
const KEY_ENTERPRISE = 'enterpriseId'
const KEY_SNAPSHOT = 'snapshot'
const KEY_IDENTITY = 'identity'

const REFRESH_MS = 10 * 60 * 1000

/** 扫码登录的轮询节奏与总时限。 */
const QR_POLL_MS = 3000
const QR_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 客户端本地登录态的位置（相对用户目录）。
 *
 * 只用来读组织名、企业 ID 这类明文展示字段，省得用户手填；
 * 读不到也不影响使用。
 */
const AUTH_INFO_PATH =
  'Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'

type Engine = EngineInterface

type RefreshResult = {
  snapshot?: Snapshot
  error?: FetchError
  now: number
}

/** 一次会话内的可变状态；模块重载即重置。 */
type ModState = {
  timer?: { cancel: () => void }
  inFlight?: Promise<RefreshResult>
  /** 正在等的扫码会话；换会话或超时后置空，轮询看到就退出。 */
  login?: { state: string }
  loginSignal?: AbortSignal
}

export const register: Register = (on, options) => {
  const state: ModState = {}

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wb-credits',
      description: '查看 WorkBuddy 积分余额',
    })
    await $.command.register({
      name: 'wb-credits-login',
      description: '保存 WorkBuddy 访问令牌：/wb-credits-login <token>',
      argumentHint: '<token>',
    })
    await $.command.register({
      name: 'wb-credits-logout',
      description: '清除保存的 WorkBuddy 令牌与缓存',
    })

    $.ui.status('WorkBuddy积分 读取中…')

    state.timer?.cancel()
    state.timer = $.clock.every(REFRESH_MS, () => {
      void refreshOnce($, options, state)
    })

    void refreshOnce($, options, state)

    return next(e)
  })

  on('session.end', ($, e, next) => {
    state.timer?.cancel()
    state.timer = undefined
    return next(e)
  })

  on('command.run', { command: 'wb-credits' }, async $ => {
    const result = await refreshOnce($, options, state)

    if (!result.snapshot) {
      return { text: missingSnapshotText(result.error) }
    }

    return { text: formatCard(result.snapshot, result.error, result.now) }
  })

  on('command.run', { command: 'wb-credits-login' }, async ($, e) => {
    const token = asText(e.args)

    if (!token) return startQrLogin($, options, state)

    await $.store.set(KEY_TOKEN, token)
    const result = await refreshOnce($, options, state)

    if (!result.snapshot) {
      return { text: `令牌已保存。\n\n${missingSnapshotText(result.error)}` }
    }

    return {
      text: `令牌已保存。\n\n${formatCard(result.snapshot, result.error, result.now)}`,
    }
  })

  on('command.run', { command: 'wb-credits-logout' }, async $ => {
    for (const key of [KEY_TOKEN, KEY_REFRESH, KEY_ENTERPRISE, KEY_SNAPSHOT, KEY_IDENTITY]) {
      await $.store.delete(key).catch(() => undefined)
    }

    state.timer?.cancel()
    state.timer = undefined
    if (!asText(options.token)) $.ui.status(undefined)

    return {
      text: asText(options.token)
        ? '已清除插件内保存的令牌与缓存。插件配置里还填着 token，请用 /config 一并清除。'
        : '已清除插件内保存的令牌与缓存。',
    }
  })

}

/** 同一时刻只留一次取数，避免定时器与命令叠在一起。 */
function refreshOnce($: Engine, options: PluginOptions, state: ModState): Promise<RefreshResult> {
  const running = state.inFlight
  if (running) return running

  const started = refresh($, options).finally(() => {
    if (state.inFlight === started) state.inFlight = undefined
  })
  state.inFlight = started

  return started
}

/** 取数并把结果落到 store 与状态栏；失败时保留上一次的快照。 */
async function refresh($: Engine, options: PluginOptions): Promise<RefreshResult> {
  const now = await $.clock.now()
  const stored = await readSnapshot($)

  let credentials: Credentials | undefined
  try {
    credentials = await resolveCredentials($, options)
  } catch (error) {
    const failure = toFetchError(error)
    await publish($, stored, failure, now)
    return { snapshot: stored, error: failure, now }
  }

  if (!credentials) {
    const failure: FetchError = { kind: 'no-token' }
    await publish($, stored, failure, now)
    return { snapshot: stored, error: failure, now }
  }

  try {
    const identity = (await readIdentity($).catch(() => undefined)) ?? {}
    const deps: FetchDeps = {
      fetch: (url, init) => $.http.fetch(url, init),
      now: () => $.clock.now(),
      identity,
    }

    let snapshot: Snapshot
    try {
      snapshot = await fetchCredits(deps, credentials)
    } catch (error) {
      // 令牌过期时用 refresh token 换一对新的，再试一次；换不成才上报告警。
      if (toFetchError(error).kind !== 'auth') throw error

      const renewed = await renewToken($, options, identity).catch(() => undefined)
      if (!renewed) throw error

      snapshot = await fetchCredits(deps, renewed)
    }

    await $.store.set(KEY_SNAPSHOT, snapshot)
    await publish($, snapshot, undefined, now)
    return { snapshot, now }
  } catch (error) {
    const failure = toFetchError(error)
    await publish($, stored, failure, now)
    return { snapshot: stored, error: failure, now }
  }
}

/** 把最新状态写进状态栏；undefined 会清掉那一行。 */
async function publish(
  $: Engine,
  snapshot: Snapshot | undefined,
  error: FetchError | undefined,
  now: number,
): Promise<void> {
  $.ui.status(formatStatus(snapshot, error, now))
}

/**
 * 用 refresh token 续期，并把新令牌写回原处。
 *
 * 只续插件 store 里的令牌：userConfig 与环境变量是用户自己管的，
 * 悄悄改掉会让配置界面与实际使用不一致。
 */
async function renewToken(
  $: Engine,
  options: PluginOptions,
  identity: Identity,
): Promise<Credentials | undefined> {
  if (asText(options.token)) return undefined

  let refreshToken = asText(await $.store.get(KEY_REFRESH).catch(() => undefined))
  if (!refreshToken) {
    refreshToken = (await readSiblingStore($).catch(() => undefined))?.refreshToken
  }
  if (!refreshToken) return undefined

  const host = billingHost(identity.domain)
  const deps: FetchDeps = {
    fetch: (url, init) => $.http.fetch(url, init),
    now: () => $.clock.now(),
    identity,
  }

  const renewed = await refreshTokens(deps, refreshToken, host)

  await $.store.set(KEY_TOKEN, renewed.token)
  if (renewed.refreshToken) await $.store.set(KEY_REFRESH, renewed.refreshToken)

  return resolveCredentials($, options)
}

/** 取一次凭证：userConfig 最优先，其后是插件 store、环境变量与本地登录态。 */
async function resolveCredentials(
  $: Engine,
  options: PluginOptions,
): Promise<Credentials | undefined> {
  const tokenFromConfig = asText(options.token)
  let tokenFromStore = asText(await $.store.get(KEY_TOKEN).catch(() => undefined))

  // 同一插件的另一加载路径可能已经存过令牌（`--plugin-dir` 与 user 安装名字不同）。
  if (!tokenFromConfig && !tokenFromStore) {
    const borrowed = await readSiblingStore($).catch(() => undefined)
    if (borrowed?.token) {
      tokenFromStore = borrowed.token
      await $.store.set(KEY_TOKEN, borrowed.token).catch(() => undefined)
      if (borrowed.refreshToken) {
        await $.store.set(KEY_REFRESH, borrowed.refreshToken).catch(() => undefined)
      }
    }
  }

  const tokenFromEnv =
    tokenFromConfig || tokenFromStore
      ? undefined
      : asText(await $.env.get('CODEBUDDY_AUTH_TOKEN'))

  if (!tokenFromConfig && !tokenFromStore && !tokenFromEnv) return undefined

  const identity = await readIdentity($).catch(() => undefined)
  const enterpriseIdFromConfig = asText(options.enterpriseId)
  const enterpriseIdFromStore = asText(
    await $.store.get(KEY_ENTERPRISE).catch(() => undefined),
  )

  return pickCredentials({
    tokenFromConfig,
    tokenFromStore,
    tokenFromEnv,
    enterpriseIdFromConfig,
    enterpriseIdFromStore,
    identity,
  })
}

/** 从客户端本地文件读明文身份；读不到不算错误。 */
async function readIdentity($: Engine): Promise<Identity | undefined> {
  const cached = await $.store.get(KEY_IDENTITY).catch(() => undefined)
  const cachedIdentity = asIdentity(cached)
  if (cachedIdentity) return cachedIdentity

  const home = await $.env.get('HOME')
  if (!home) return undefined

  const path = `${home}/${AUTH_INFO_PATH}`
  const exists = await $.fs.exists(path).catch(() => false)
  if (!exists) return undefined

  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') return undefined

  const identity = parseAuthInfo(text)
  if (identity) await $.store.set(KEY_IDENTITY, identity).catch(() => undefined)
  return identity
}

/**
 * 找同一插件在另一个加载路径下存的 store。
 *
 * 只读插件 store 目录里属于本插件的条目，取最新的一份；
 * 不新建文件，也不复制令牌到别处。
 */
async function readSiblingStore($: Engine): Promise<StoreSnapshot | undefined> {
  const home = await $.env.get('HOME')
  if (!home) return undefined

  const dir = `${home}/${STORE_DIR}`
  const exists = await $.fs.exists(dir).catch(() => false)
  if (!exists) return undefined

  const entries = await $.fs.list(dir).catch(() => [])
  const candidates = entries
    .filter(entry => entry.kind === 'file' && isOwnStoreName(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const entry of candidates) {
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => undefined)
    if (typeof text !== 'string') continue

    const parsed = parseStore(text)
    if (parsed?.token) return parsed
  }

  return undefined
}

async function readSnapshot($: Engine): Promise<Snapshot | undefined> {
  const value = await $.store.get(KEY_SNAPSHOT).catch(() => undefined)
  if (!value || typeof value !== 'object') return undefined

  const item = value as Snapshot
  return typeof item.fetchedAt === 'number' ? item : undefined
}

function asIdentity(value: unknown): Identity | undefined {
  if (!value || typeof value !== 'object') return undefined

  const item = value as Identity
  const hasSomething =
    asText(item.displayName) !== undefined ||
    asText(item.enterpriseName) !== undefined ||
    asText(item.accountType) !== undefined ||
    asText(item.enterpriseId) !== undefined

  return hasSomething ? item : undefined
}

/** 一次都没取到数时的说明，按失败原因分岔。 */
function missingSnapshotText(error: FetchError | undefined): string {
  if (!error) return '还没有取到积分数据，请稍后再试。'

  if (error.kind === 'no-token') {
    return [
      '还没有配置 WorkBuddy 令牌。三选一：',
      '',
      '1. /wb-credits-login <token>',
      '2. 设置环境变量 CODEBUDDY_AUTH_TOKEN',
      '3. 在插件配置里填 token 字段（存系统安全存储）',
    ].join('\n')
  }

  if (error.kind === 'auth') {
    return `令牌被拒绝（HTTP ${error.status}）。请用 /wb-credits-login <token> 换一个新令牌。`
  }

  return `取数失败：${describeError(error)}`
}

/**
 * `/wb-credits-login` 不带参数时走扫码：
 * 申请 state → 打印登录地址 → 后台轮询 → 拿到令牌后自动刷新。
 */
async function startQrLogin(
  $: Engine,
  options: PluginOptions,
  state: ModState,
): Promise<{ text: string }> {
  const deps: FetchDeps = {
    fetch: (url, init) => $.http.fetch(url, init),
    now: () => $.clock.now(),
    identity: {},
  }

  let started: LoginStart
  try {
    started = await startLogin(deps)
  } catch (error) {
    return { text: `无法发起扫码登录：${describeError(toFetchError(error))}` }
  }

  state.login = { state: started.state }
  void pollUntilAuthorized($, options, state, started.state)

  return {
    text: [
      '请扫码登录（10 分钟内有效）：',
      '',
      `  ${started.url}`,
      '',
      '登录成功后会自动保存令牌并刷新积分；',
      '也可以直接 /wb-credits-login <token> 手动粘贴。',
    ].join('\n'),
  }
}

/** 每 3 秒问一次，拿到令牌就存下并刷新；超时或换会话就停。 */
async function pollUntilAuthorized(
  $: Engine,
  options: PluginOptions,
  state: ModState,
  loginState: string,
): Promise<void> {
  const deps: FetchDeps = {
    fetch: (url, init) => $.http.fetch(url, init),
    now: () => $.clock.now(),
    identity: {},
  }

  const deadline = (await $.clock.now()) + QR_TIMEOUT_MS

  while (state.login?.state === loginState) {
    if ((await $.clock.now()) > deadline) {
      state.login = undefined
      $.ui.toast('扫码登录超时，请重新执行 /wb-credits-login')
      return
    }

    try {
      const result = await pollLogin(deps, loginState)
      if (result) {
        state.login = undefined
        await $.store.set(KEY_TOKEN, result.token)
        if (result.refreshToken) await $.store.set(KEY_REFRESH, result.refreshToken)
        await $.store.delete(KEY_IDENTITY).catch(() => undefined)
        const refreshed = await refreshOnce($, options, state)
        $.ui.toast(
          refreshed.snapshot
            ? `已登录，WorkBuddy 剩 ${formatNumber(refreshed.snapshot.left)} 积分`
            : '已登录，但取积分失败',
        )
        return
      }
    } catch (error) {
      if (toFetchError(error).kind === 'auth') {
        state.login = undefined
        $.ui.toast('扫码登录已失效，请重新执行 /wb-credits-login')
        return
      }
    }

    await $.clock.sleep(QR_POLL_MS, { signal: state.loginSignal })
  }
}
