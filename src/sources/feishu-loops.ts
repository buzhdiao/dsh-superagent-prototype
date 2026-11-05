/** Feishu background loops: live event stream consumer, chat/topic history backfill, chat name refresh, and subscribed thread polling. */
// 飞书的后台循环：实时事件消费者（lark-cli 子进程）、群/话题历史补收、群名刷新、订阅 Thread 轮询。
// 四个循环并行跑，各自独立失败（Promise.allSettled 不互相拖垮）。
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey, type Thread, type Trigger } from '../core/index.ts'
import { feishuChatLink } from './feishu-channel.ts'
import type { FeishuBot } from '../deployment.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { readFeishu, type FeishuRef } from './feishu-read.ts'
import { feishuRef, feishuTime, feishuTrigger, HistoricalMessageSchema, historyEvent, HistoryPageSchema, SOURCE, topicEvent }
  from './feishu-trigger.ts'
import { health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, POLL_HORIZON_MS, polled, pollThreads as pollEach } from './poll.ts'
import type { FeishuConfig } from './feishu.ts'

// runFeishu：飞书主入口——三个循环（事件消费 / 历史补收 / 群名刷新）并行。
export const runFeishu = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.allSettled([watch, backfillLoop, chatNamesLoop].map(loop => loop(ctx, signal)))
// enabled：当前实例配置（Source 关闭时为 undefined）。
const enabled = (ctx: SourceContext): FeishuConfig | undefined => ctx.config<FeishuConfig>(SOURCE)
// bot：解析出的机器人 CLI 信息；没有则报错（调用方决定如何处理）。
const bot = (ctx: SourceContext): FeishuBot => {
  const resolved = ctx.deployment.feishu
  if (!resolved) throw new Error('The Feishu Source has no working bot CLI')
  return resolved
}
// receive：接收一个 Trigger 并维护 Thread 元数据（群链接、群名/私聊事实）——面板与评估都用得上。
async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const chatId = String(trigger.meta.chatId ?? '')
  if (!chatId) return
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[chatId] ?? chatId
  const chat = trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { url: chatLink(ctx, chatId), facts: { chat } })
}
// chatLink：拼飞书会话链接（品牌可配置，默认 feishu）。
const chatLink = (ctx: SourceContext, chatId: string): string => feishuChatLink(ctx.deployment.feishu?.brand ?? 'feishu', chatId)
// available：setup 是否就绪、bot CLI 是否可用；不就绪时报 paused 健康。
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.feishu) return true
  const waiting = health('paused', ctx.configured() ? 'feishuCliUnset' : 'setupPending')
  ctx.report('feishu', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}

/** Runs the live event consumer only while the Source is enabled; disabling it stops the consumer within five seconds. */
// watch：事件消费主循环——只在 Source 启用时跑；
// 关闭后 5 秒内停掉消费者；崩溃后按退避重启。
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the bot; until then nothing runs.
  if (!available(ctx)) return
  let retry: number | undefined
  while (!signal.aborted) {
    if (!enabled(ctx)) {
      ctx.report('feishu', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    // 每 5 秒检查一次开关：关了就中止当前消费者。
    const check = setInterval(() => { if (!enabled(ctx)) running.abort() }, 5000)
    const stop = () => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try { await consume(ctx, running.signal) }
    catch (error) { if (!running.signal.aborted) ctx.report('feishu', { state: 'error', detail: String(error) }) }
    finally { clearInterval(check); signal.removeEventListener('abort', stop) }
    // 被开关中止的不算崩溃，直接重开。
    if (running.signal.aborted) continue
    // 崩溃重试间隔。
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
/** Wait before restarting the event consumer: 1s after a run that stayed up for a minute, otherwise exponential backoff up to 60s. */
// consumerRetry：消费者重启前的等待——跑满一分钟视为偶发，等 1s；否则指数退避至多 60s。
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)
// consume：跑一个 lark-cli event consume 子进程，逐行解析事件为 Trigger。
async function consume(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  // 子进程：以 bot 身份订阅 im.message.receive_v1 事件；关掉 CLI 自身的更新/技能提示。
  const child = spawn(bot(ctx).cli, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
  const stdout = createInterface({ input: child.stdout }); const stderr = createInterface({ input: child.stderr })
  // chain：串行化事件处理（事件顺序不能乱）；diagnostic：最近的 stderr 行（报错带上）。
  let chain = Promise.resolve(); let diagnostic = ''; let ready = false
  const stop = (): void => { child.stdin.end(); child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  // 45 秒内没 ready 就停掉重试（防止挂在半死的连接上）。
  const timeout = setTimeout(() => { diagnostic = 'Feishu event consumer did not become ready within 45 seconds'; stop() }, 45_000)
  stderr.on('line', (line: string) => {
    diagnostic = line.slice(0, 4000)
    if (line.startsWith('[event] ready')) {
      // ready：消费者就绪。
      ready = true; clearTimeout(timeout)
      ctx.report('feishu', { state: 'ready', detail: 'Listening for bot events', at: new Date().toISOString() })
    } else if (/WARN|drop|error/.test(line)) ctx.report('feishu', { state: 'error', detail: diagnostic })
  })
  stdout.on('line', (line: string) => {
    // 每行一个事件；串行处理，单个失败只报健康不中断流。
    chain = chain.then(async () => {
      if (line.length > 1_048_576) throw new Error('Feishu event exceeds 1 MiB')
      const trigger = feishuTrigger(JSON.parse(line), bot(ctx).botId, bot(ctx).appId)
      // Events already read when the Source is disabled are dropped; the consumer stops shortly after.
      // Source 关闭后仍在到达的事件直接丢弃（消费者很快会被停掉）。
      if (!trigger || !enabled(ctx)) return
      // 记录"见过哪些群"（含私聊标记）——历史补收循环据此决定补收范围。
      const chats = ctx.state.get(KV.feishu.chats) ?? {}
      chats[String(trigger.meta.chatId)] = trigger.meta.direct === true
      ctx.state.set(KV.feishu.chats, chats)
      await receive(ctx, trigger)
    }).catch(error => { ctx.report('feishu', { state: 'error', detail: String(error) }) })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      const exited = (code: number | null) => new Error(`Feishu event consumer exited (${code}, ready=${ready}): ${diagnostic}`)
      // 正常中止（signal）不算失败。
      child.once('close', (code) => signal.aborted ? resolve() : reject(exited(code)))
    })
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain }
}

/** Refreshes the map of joined chats (`chat_id -> name`); throws on failure so the previously stored list remains intact. */
// refreshChatNames：刷新已加入群的 `chat_id -> 名字` 映射——
// 失败直接抛：保留上次成功的好名单（不拿半份数据覆盖）。
export async function refreshChatNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const commands = ctx.commands.withSignal(signal)
  const result = z.looseObject({ chats: z.array(z.looseObject({ chat_id: z.string(), name: z.string().nullish() })).optional() })
    .parse(await commands.lark(['im', '+chat-list', '--page-all', '--page-size', '100']))
  const names = Object.fromEntries((result.chats ?? []).filter(chat => chat.name).map(chat => [chat.chat_id, chat.name!]))
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
/** Rereads the chat list every minute independently of history backfill (whose rounds can take much longer), so newly joined chats appear within a minute. */
// chatNamesLoop：每分钟刷新一次群名——独立于历史补收（一轮可能很久），
// 保证新加入的群一分钟内出现在面板上。
async function chatNamesLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) return
  while (!signal.aborted) {
    if (enabled(ctx)) {
      try { await refreshChatNames(ctx, signal) }
      catch { /* Names are a display aid; the stored list stays until a later read succeeds. */ }
    }
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}
// backfillLoop：历史补收循环（每分钟一轮）——
// 对配置的群与已知的私聊逐个补收增量；随后轮询订阅 Thread；最后汇总历史健康条目。
async function backfillLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) { ctx.report('history', health('paused', 'feishuBotMissing')); return }
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('history', health('paused', 'sourceOff'))
      await delay(60_000, undefined, { signal }).catch(() => {})
      continue
    }
    // 补收对象：配置的群 + 事件里见过的私聊（开关允许时）。
    const seen = ctx.state.get(KV.feishu.chats) ?? {}
    const known = Object.entries(seen).filter(([, direct]) => direct && config.directMessages)
    const chats = { ...Object.fromEntries(config.chats.map(chat => [chat.chatId, false])), ...Object.fromEntries(known) }
    const errors: string[] = []
    const tally = { skipped: 0 }
    for (const [chatId, direct] of Object.entries(chats)) {
      if (signal.aborted) break
      const started = new Date().toISOString()
      const cursorKey = KV.feishu.history(chatId)
      const since = ctx.state.get(cursorKey)
      // 首次见到该群：只记起点，从现在开始（不读以前的历史）。
      if (since === undefined) { ctx.state.set(cursorKey, started); continue }
      try {
        await backfillChat(ctx, chatId, direct, since, started, signal, tally)
        // 成功后推进该群游标（回拨 5 秒防迟到事件）。
        if (!signal.aborted) ctx.state.set(cursorKey, cursorAt(started))
      } catch (error) { if (!signal.aborted) errors.push(`${chatId}: ${String(error)}`) }
    }
    // 补收完群，再轮询订阅的 Thread。
    await pollThreads(ctx, signal, tally)
    const skipped = tally.skipped ? `; ${tally.skipped} unreadable messages skipped` : ''
    if (!signal.aborted) ctx.report('history', errors.length
      ? { state: 'error', detail: errors.join('\n') }
      : { state: 'ready', detail: `Configured groups and known direct chats recovered${skipped}`, at: new Date().toISOString() })
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}
/**
 * Backfills chat messages and active topic replies between `since` and `until` before the caller advances the chat cursor.
 * Topics are stored as `{ id: lastSeenAt }`, and unsubscribed topics older than the polling horizon are pruned.
 */
// backfillChat：把 [since, until] 之间的群消息与活跃话题回复补收进来（调用方之后才推进游标）。
// 话题表存 `{ 话题id: 最后见到时间 }`；超出轮询窗口且无人订阅的话题会被修剪。
export async function backfillChat(ctx: SourceContext, chatId: string, direct: boolean, since: string, until: string,
  signal: AbortSignal, tally: Tally = { skipped: 0 }): Promise<void> {
  const commands = ctx.commands.withSignal(signal)
  const topicsKey = KV.feishu.topics(chatId)
  const topics = { ...ctx.state.get(topicsKey) }
  // scan：按时间升序分页拉取一段历史（群或话题），逐条转为 Trigger。
  const scan = async (kind: 'chat' | 'thread', id: string): Promise<void> => {
    let page: string | undefined
    const pages = new Set<string>()
    do {
      if (signal.aborted) throw signal.reason
      const seconds = (time: string) => String(Math.floor(Date.parse(time) / 1000))
      const parameters = { container_id_type: kind, container_id: id, start_time: seconds(since), end_time: seconds(until),
        sort_type: 'ByCreateTimeAsc', page_size: 50, ...(page ? { page_token: page } : {}) }
      const request = ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(parameters)]
      const result = HistoryPageSchema.parse(await commands.lark(request))
      for (const message of validItems(HistoricalMessageSchema, result.items, tally)) {
        // 越界数据（别的群/别的话题）说明 API 行为异常——拒绝而不是悄悄收下。
        const outside = message.chat_id !== chatId || (kind === 'thread' && message.thread_id !== id)
        if (outside) throw new Error('Feishu history returned a message outside the requested chat or thread')
        if (message.deleted) continue
        const at = feishuTime(message.create_time)
        // 记录话题活跃时间（取每话题最新的一条）。
        if (message.thread_id && !(Date.parse(topics[message.thread_id] ?? '') >= Date.parse(at))) topics[message.thread_id] = at
        const trigger = feishuTrigger(historyEvent(message, chatId, direct), bot(ctx).botId, bot(ctx).appId)
        if (trigger) await receive(ctx, trigger)
      }
      // 翻页不前进（游标缺失或回到见过的页）：抛错，避免死循环。
      const stuck = result.has_more && (!result.page_token || pages.has(result.page_token))
      if (stuck) throw new Error('Feishu history pagination did not advance')
      page = result.has_more ? result.page_token : undefined
      if (page) pages.add(page)
    } while (page)
  }
  // 先扫群主时间线，再扫各话题。
  await scan('chat', chatId)
  // A quiet topic is forgotten unless a subscribed Thread that is still polled follows it.
  // 安静的话题会被遗忘——除非还有"仍在窗口内轮询的"订阅 Thread 跟着它。
  const followed = new Set(ctx.threads.subscribed(SOURCE).filter(thread => polled(ctx, thread))
    .map(thread => String(thread.meta.threadId ?? ctx.triggers.latest(thread.key)?.meta.threadId ?? '')))
  for (const [id, seen] of Object.entries(topics)) {
    if (!followed.has(id) && Date.parse(until) - Date.parse(seen) >= POLL_HORIZON_MS) delete topics[id]
  }
  ctx.state.set(topicsKey, topics)
  for (const id of Object.keys(topics)) await scan('thread', id)
  ctx.state.set(topicsKey, topics)
}

/** Resolves the retained source message reference for polling a subscribed thread. */
// threadRef：解析轮询订阅 Thread 所需的"锚点消息"引用——
// 优先 meta（来源 Trigger/群/消息 id），退而取该 Thread 最新 Trigger。
export function threadRef(ctx: SourceContext, thread: Thread): FeishuRef | undefined {
  const meta = thread.meta as { sourceTriggerId?: string; chatId?: string; messageId?: string }
  if (meta.chatId && meta.messageId && meta.sourceTriggerId) {
    return { triggerId: meta.sourceTriggerId, chatId: meta.chatId, messageId: meta.messageId }
  }
  const trigger = ctx.triggers.latest(thread.key)
  return trigger ? feishuRef(trigger) : undefined
}
/** Polls subscribed Feishu threads within the polling horizon so replies missed by the live stream become triggers. */
// pollThreads：轮询窗口内的已订阅话题——兜住实时流漏掉的回复。
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, tally?: Tally): Promise<void> {
  await pollEach(ctx, SOURCE, () => !!signal?.aborted, thread => pollThread(ctx, thread, signal, tally))
}
// pollThread：轮询一个飞书话题（沿 next_resource 向新翻页）。
async function pollThread(ctx: SourceContext, thread: Thread, signal?: AbortSignal, tally?: Tally): Promise<void> {
  const ref = threadRef(ctx, thread)
  if (!ref) throw new Error('Subscribed thread has no retained source message')
  const config = enabled(ctx)
  // The Source was turned off; the next round polls again.
  // Source 关闭：本轮跳过（下一轮再试）。
  if (!config) return
  const commands = ctx.commands.withSignal(signal)
  const pageSize = config.readPageSize
  // known：本话题已见过的消息 id 集合（防重复）。
  const checkpoint = KV.feishu.seen(thread.key)
  const known = new Set(ctx.state.get(checkpoint) ?? [])
  const initialized = ctx.state.get(KV.feishu.initialized(thread.key))
  if (!initialized) {
    // Mark root and parent messages as seen on first poll so historical context is not ingested as new triggers.
    // 首次轮询：把根消息与父消息标成已见——订阅之前的上下文不该当新 Trigger。
    for (const section of ['root', 'parent']) {
      const result = await readFeishu(commands, ref, `feishu/${ref.triggerId}/${section}`, pageSize)
      if ('message' in result && result.message) known.add(result.message.message_id)
    }
    ctx.state.set(checkpoint, [...known])
  }
  const direct = ctx.state.get(KV.feishu.chats)?.[ref.chatId] === true
  // since：Thread 订阅时刻——初始轮询只收这之后的消息。
  const since = Date.parse(thread.createdAt)
  const root = thread.ref.id.slice(thread.ref.id.indexOf(':') + 1)
  let resource: string | null = `feishu/${ref.triggerId}/thread`
  while (resource) {
    if (signal?.aborted) return
    const result = await readFeishu(commands, ref, resource, pageSize, 'desc')
    if (!('messages' in result)) throw new Error('Expected Feishu thread messages')
    if (tally && 'skipped' in result) tally.skipped += result.skipped ?? 0
    // 补齐话题的真实 thread_id（meta 用）。
    if ('thread_id' in result && result.thread_id && thread.meta.threadId !== result.thread_id) {
      ctx.threads.patch(thread.key, { threadId: result.thread_id })
    }
    // 遇到已见消息 = 翻到了上次的位置，读完这页即可停。
    const encounteredKnown = result.messages.some(message => known.has(message.message_id))
    const { botId, appId } = bot(ctx)
    for (const message of result.messages.filter(item => !known.has(item.message_id) && !item.deleted).reverse()) {
      if (signal?.aborted) return
      const trigger = feishuTrigger(topicEvent(message, ref.chatId, direct, root), botId, appId)
      // Ignore messages older than the thread subscription on initial poll.
      // 初始轮询忽略订阅之前的老消息。
      if (!trigger || (!initialized && Date.parse(trigger.at) < since)) continue
      await receive(ctx, trigger)
    }
    result.messages.forEach(message => known.add(message.message_id))
    ctx.state.set(checkpoint, [...known])
    if (initialized && encounteredKnown) break
    resource = result.next_resource
  }
  ctx.state.set(KV.feishu.initialized(thread.key), true)
}
