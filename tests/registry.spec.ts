/**
 * 本测试文件覆盖 src/sources/registry.ts 的 SourceRegistry：已安装 Source kind 的注册表、
 * 实例配置校验、线程上下文/频道的分发，以及健康条目的认领与注销清理。
 * 测试策略：用极小的自定义 kind（probe）与真实的 github/feishu kind 搭配，
 * 通过 SettingsSchema.parse 构造内存设置，逐个验证注册表对实例、策略、回复路由的规则。
 */
import { describe, expect, it, vi } from 'vitest'
// vitest 测试原语：describe/it 组织用例，expect 断言，vi 创建 spy。
import { z } from 'zod'
// zod：为 probe kind 声明配置 schema。
import { SettingsSchema } from '../src/policy.ts'
// SettingsSchema：全局设置的 zod 模式，用于生成带默认值的设置对象。
import { SourceRegistry } from '../src/sources/registry.ts'
// 被测模块：Source 注册表。
import type { SourceKind } from '../src/sources/kind.ts'
// SourceKind：Source 插件种类接口。
import type { Agent } from '@deepseek-ai/dsh-agent'
// Agent：DSH 会话代理类型（仅用于 image 调用签名）。
import type { OutboundMessage } from '../src/core/index.ts'
// OutboundMessage：外发消息结构。
import { Commands } from '../src/infra/commands.ts'
// Commands：CLI 命令执行器（发消息时传给 Source）。
import { HealthBoard } from '../src/infra/health.ts'
// HealthBoard：健康状态板，Source 在此认领健康条目。
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
// sourceContextOf：从宿主依赖构造 kind 的健康上报上下文。
import { feishuChannel, feishuTrigger, feishuTriggerId } from '../src/sources/feishu-trigger.ts'
// feishuTrigger：把飞书回调事件转成 Trigger；feishuTriggerId：飞书线程 id；feishuChannel：飞书频道引用。
import { testDeployment } from './fixtures/deployment.ts'
// testDeployment：测试用部署信息 fixture。
import { feishuKind } from '../src/sources/feishu.ts'
// 真实飞书 Source kind。
import { githubKind } from '../src/sources/github.ts'
// 真实 GitHub Source kind。

const probe: SourceKind<{ interval: number }> = {
  // 最小可用的自定义 kind：只有一个 interval 数字配置，无 channel/上下文/健康条目。
  kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
  schema: z.object({ interval: z.number().int().min(1).default(5) }).strict(),
  // schema：整数、最小 1、默认 5，且拒绝未知字段（strict）。
  fields: [{ key: 'interval', type: 'number', min: 1, max: 60, label: { zh: '间隔', en: 'Interval' } }],
}

describe('Source registry', () => {
  // Source 注册表的总体行为。
  it('lists every installed kind with defaults, in id order, followed by stored instances whose kind is not installed', () => {
    // 实例列表：已安装 kind 按默认配置展开并按 id 排序，未安装 kind 的存量实例排在最后且 installed=false。
    const settings = SettingsSchema.parse({ sources: { probe: { enabled: false, config: { interval: 9 } }, retired: { enabled: true, config: { x: 1 } } } })
    // 两个已存实例：probe（已安装，关闭，interval=9）与 retired（kind 未安装，遗留配置 x）。
    const sources = new SourceRegistry(() => settings)
    // 注册表以“读取当前设置”的回调构造。
    sources.register(probe); sources.register(githubKind)
    // 注册 probe 与真实 github kind（github 自带默认配置）。
    expect(sources.instances()).toEqual([
      // 期望：github 排最前（id 序），展开其全部默认配置；probe 保留存储值；retired 标记为未安装。
      { id: 'github', kind: 'github', enabled: true, config: { repository: '', cli: '', pollSeconds: 60, failuresBeforeError: 3,
        observeIssues: false, observePulls: false, observeComments: false, observeCi: false }, installed: true },
      { id: 'probe', kind: 'probe', enabled: false, config: { interval: 9 }, installed: true },
      { id: 'retired', kind: 'retired', enabled: true, config: { x: 1 }, installed: false },
    ])
  })
  it('validates submitted instances with the kind schema and refuses kinds that are not installed', () => {
    // 实例提交校验：按 kind 的 schema 补默认值/拒绝非法值；未安装 kind 直接拒绝。
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    // 空设置起步，仅注册 probe。
    sources.register(probe)
    expect(sources.validate('probe', { enabled: true, config: {} })).toEqual({ enabled: true, config: { interval: 5 } })
    // 空 config 被 schema 默认值补成 interval=5。
    expect(() => sources.validate('probe', { enabled: true, config: { interval: 0 } })).toThrow()
    // interval=0 低于 min(1)，校验失败抛错。
    expect(() => sources.validate('missing', { enabled: true, config: {} })).toThrow('not installed')
    // 未注册的 kind 报“not installed”。
  })
  it('sends, links and reads a kind\'s Threads through its own channel and context, and nothing for a kind without them', async () => {
    // kind 自带 channel/threadContext 时，发送、链接、读上下文都走它；没装的 kind 进入等待；两者皆无的 kind 直接作废。
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { probe: { enabled: true, config: { interval: 7 } } } }))
    // probe 启用，config.interval=7（用于断言上下文读取收到的是配置值）。
    const sent: OutboundMessage[] = []
    // 记录被发送的消息。
    const read: unknown[] = []
    // 记录上下文读取的入参。
    sources.register({ ...probe,
      // 注册一个带 channel 与 threadContext 的 probe 变体。
      channel: { send: async (_host, message) => { sent.push(message); return 'sent' },
        // send：把消息存进 sent 并返回 'sent'。
        link: address => ({ url: `https://probe/${address.room}`, label: { zh: '探针', en: 'Probe' } }) },
        // link：由地址生成可点击链接与标签。
      threadContext: { messageId: trigger => String(trigger.meta.id), read: async (_commands, trigger, part, cursor, config) => {
        // threadContext：messageId 从 Trigger 的 meta 取；read 记录入参并返回一页假消息。
        read.push([trigger.id, part, cursor, config.interval])
        return { messages: [{ id: 'm1', from: 'u', at: '1', text: '' }],
          body: { page: cursor ?? 'first' } }
      } } })
    const commands = {} as Commands
    // 假 Commands：本用例的 channel 实现不使用它。
    const message = (source: string): OutboundMessage => ({ id: 'r1', channel: { source, thread: 'probe:1', address: { room: 'r' } },
      text: 'hi', kind: 'reply' })
    // 构造指定 source 的回复消息工厂。
    expect(await sources.send(message('probe'), commands)).toBe('sent')
    // 发给已安装 kind 的消息被投递并返回 'sent'。
    expect(sent).toEqual([message('probe')])
    // 消息原样传给 channel.send。
    // A kind that is not installed keeps its replies waiting; links to it have no page.
    // 未安装 kind 的回复保持等待；其链接没有落地页。
    expect(await sources.send(message('retired'), commands)).toBe('waiting')
    expect(sources.link(message('probe').channel, {})).toEqual({ url: 'https://probe/r', label: { zh: '探针', en: 'Probe' } })
    // 已安装 kind 的链接由其 channel.link 生成。
    expect(sources.link(message('retired').channel, {})).toEqual({ url: '', label: { zh: 'retired', en: 'retired' } })
    // 未安装 kind 的链接退化为空 URL + kind 名标签。
    const trigger = { id: 't1', source: 'probe', threads: [{ source: 'probe', id: '1' }], actor: { source: 'probe', id: 'u' }, human: true,
      at: '', text: 'hi', meta: { id: 'm1' } }
    // 一个 probe 来源的 Trigger，meta.id 指向消息 m1。
    const context = sources.threadContext(trigger)!
    // 按 kind 取出线程上下文读取器。
    expect(context.messageId).toBe('m1')
    // messageId 即 Trigger 的 meta.id。
    expect(await context.read(commands, 'thread', '2')).toMatchObject({ body: { page: '2' } })
    // read 透传 cursor（'2'）到 body.page。
    expect(read).toEqual([['t1', 'thread', '2', 7]])
    // 读取入参完整：trigger id、部分、cursor、以及配置里的 interval=7。
    expect(context.images('img_x')).toEqual([])
    // 该 kind 不支持图片：列图为空。
    await expect(context.image({} as Agent, commands, { id: 'm1', text: '' }, 'img_x', '',
      new AbortController().signal)).rejects.toThrow('no images')
    // 取单图则 rejects “no images”。
    // A kind without a channel or a context has neither.
    // 没有 channel/上下文的 kind 两者皆无。
    sources.register({ ...probe, kind: 'quiet' })
    expect(await sources.send(message('quiet'), commands)).toBe('gone')
    // 无 channel 的 kind：消息作废（'gone'）。
    expect(sources.threadContext({ ...trigger, source: 'quiet' })).toBeUndefined()
    // 无 threadContext 的 kind：取不到上下文读取器。
  })
  it('refuses a kind that declares a health entry another kind or dsh-superagent itself reports, and gives up its entries at unregister', () => {
    // 健康条目唯一性：kind 不得声明与内置或其它 kind 重名的条目；注销后其条目释放，且迟到的上报被忽略。
    const board = new HealthBoard()
    // Pre-claim built-in health entries; sync:* entries are reserved for settings sync.
    // 先以内置名义认领 runtime/reply（sync:* 保留给设置同步）。
    for (const name of ['runtime', 'reply']) board.claim(name)
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    // 注册表挂上同一块健康板。
    const unregister = sources.register(githubKind)
    // github kind 注册成功，返回其注销函数。
    expect(() => sources.register({ ...probe, health: ['github'] })).toThrow('declares the health entry github')
    // 与 github kind 已占用的 'github' 条目冲突。
    for (const name of ['runtime', 'reply', 'sync:github']) expect(() => sources.register({ ...probe, health: ['probe', name] })).toThrow(name)
    // 与内置 runtime/reply、保留前缀 sync:* 冲突，各自报出条目名。
    expect(sources.kind('probe')).toBeUndefined()
    // 冲突导致注册失败：probe 未进入注册表。
    sources.register({ ...probe, health: ['probe'] })
    // 只声明自己的 'probe' 条目则可注册。
    const context = (kind: { kind: string; health: readonly string[] }) => sourceContextOf({ sources } as unknown as SourceContextDeps, kind)
    // 用 sourceContextOf 造一个可上报健康的上下文。
    const first = context(githubKind)
    first.report('github', { state: 'ready', detail: 'ok' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'ok' })
    // 合法条目的上报直接写入健康板。
    expect(() => first.report('probe', { state: 'ready', detail: '' })).toThrow('has no health entry probe')
    // 上报未声明的条目被拒绝。
    // A report sent after its kind unregisters (such as from an exiting CLI listener) is ignored and does not affect a later registration.
    // kind 注销后的迟到上报（例如退出中的 CLI 监听器发出）被忽略，也不影响后续注册。
    unregister()
    expect(() => first.report('github', { state: 'error', detail: 'WARN exiting' })).not.toThrow()
    expect(board.all.github).toBeUndefined()
    // 迟到上报静默丢弃，板上不再有 github 条目。
    sources.register(githubKind)
    first.report('github', { state: 'error', detail: 'late' })
    expect(board.all.github).toEqual({ state: 'starting', detail: '' })
    // 旧上下文的再次上报仍被忽略：板上保持重新注册后的初始 'starting' 状态。
    context(githubKind).report('github', { state: 'ready', detail: 'again' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'again' })
    // 新上下文的上报正常生效。
  })
  it('names the Trigger whose message a Trigger\'s message answers, where its kind can', () => {
    // repliesTo：kind 能识别“回复关系”时给出被回复 Trigger 的 id，否则 undefined。
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind); sources.register(githubKind)
    const reply = feishuTrigger({ message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', sender_id: 'ou_alice', sender_type: 'user',
      content: 'yes', create_time: '1757376000000', parent_id: 'om_1' }, 'ou_bot', 'cli_bot')!
    // 一条带 parent_id 的群聊飞书消息（回复 om_1）。
    expect(sources.repliesTo(reply)).toBe(feishuTriggerId('om_1'))
    // 识别出它回复的是 om_1 对应的 Trigger。
    expect(sources.repliesTo({ ...reply, meta: { ...reply.meta, parentId: undefined } })).toBeUndefined()
    // 没有父消息的回复关系无从谈起。
    expect(sources.repliesTo({ ...reply, source: 'github' })).toBeUndefined()
    // 换成不支持回复关系的 kind（github）则返回 undefined。
  })
  it('finds what a search query names in each kind\'s terms', () => {
    // find：把查询串解析为各 kind 认领的线程引用（如 issue/会话 id）与剩余搜索词。
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.find('#12')).toEqual({ threads: ['github:12'], terms: [] })
    // '#12' 被 github kind 认作 issue/pull 编号。
    expect(sources.find('https://github.com/acme/widgets/pull/7#issuecomment-3')).toEqual({ threads: ['github:7'], terms: [] })
    // GitHub 评论链接解析到其所属 pull 的线程。
    expect(sources.find('see om_abc and om_abc, om_def')).toEqual({ threads: [], terms: ['om_abc', 'om_def'] })
    // 飞书消息 id 被抽为搜索词并去重，不算线程引用。
    expect(sources.find('login fails')).toEqual({ threads: [], terms: [] })
    // 普通短语既无线程也无抽取词。
    expect(feishuKind.policy!.unnamed).toEqual({ person: { zh: '飞书用户', en: 'Feishu user' }, bot: { zh: '飞书机器人', en: 'Feishu bot' } })
    // 附带验证：飞书 kind 对未命名者有中英文名策略。
  })
  it('refuses a second registration of one kind and forgets a kind after its disposer runs', () => {
    // 重复注册被拒绝；注销函数执行后 kind 与其实例一并失效。
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    const dispose = sources.register(probe)
    expect(() => sources.register(probe)).toThrow('already registered')
    // 同名 kind 二次注册报“already registered”。
    dispose()
    expect(sources.instance('probe')).toBeUndefined()
    // 注销后实例查询不到。
  })
  it('validates each Source\'s part of the Policy with its kind, keeping parts of kinds that are not installed as stored', () => {
    // 策略中 Source 部分的校验：已安装 kind 按其规则校验补全，未安装 kind 的部分原样保留。
    const sources = new SourceRegistry(() => SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } }))
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.validatePolicy({ feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] }, retired: { allowed: [], x: 1 } }))
      .toEqual({ feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: '', admission: {} }, retired: { allowed: [], x: 1 } })
    // feishu 部分经校验补上 syncChat/admission 默认值；retired（未安装）原样透传。
    expect(() => sources.validatePolicy({ feishu: { allowed: [{ id: 'alice' }] } })).toThrow()
    // 飞书要求完整 open id（ou_ 前缀），纯 'alice' 不合法。
    expect(sources.policyPart('feishu')).toEqual({ allowed: [{ id: 'ou_alice' }], syncChat: '', admission: {} })
    // 已安装 kind 读取其策略片段（来自设置）。
    expect(sources.policyPart('github')).toEqual({ allowed: [], admission: {} })
    // 未配置的 github 得到空默认。
    sources.register(probe)
    expect(sources.policyPart('probe')).toBeUndefined()
    // probe 未声明策略片段则返回 undefined。
  })
  it('allows a reply only on a Channel whose Source still listens to its chat', () => {
    // channelAllowed：只有来源 kind 仍监听该会话（且私聊开关允许）时才允许回复。
    const settings = SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }], directMessages: false } } } })
    // 飞书启用：仅监听 oc_team（提及），关闭私聊。
    const sources = new SourceRegistry(() => settings)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_team' } })).toBe(false)
    // kind 未注册时一律不允许（即使设置里配了该会话）。
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_team' } })).toBe(true)
    // 注册后：被监听的会话允许回复。
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_other' } })).toBe(false)
    // 未列入监听的会话不允许。
    // A direct chat's id starts with oc_ too; the address says it is direct, and with direct messages off it gets no reply.
    // 私聊会话 id 同样以 oc_ 开头，由 address.direct 标记；私聊关闭时不允许回复。
    expect(sources.channelAllowed(feishuChannel('oc_dm', 'om_1', true))).toBe(false)
    expect(sources.channelAllowed({ source: 'github', address: { number: '7' } })).toBe(true)
    // github kind 无会话白名单，默认允许。
  })
  it('delivers a reply to a direct message under the default settings', async () => {
    // 默认设置下（未配置监听清单）私聊回复可送达：飞书私聊默认放行。
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind)
    const trigger = feishuTrigger({ message_id: 'om_dm', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: 'ou_alice', sender_type: 'user',
      content: 'fix it', create_time: '1757376000000' }, 'ou_bot', 'cli_bot')!
    // 一条 p2p 私聊消息转成的 Trigger。
    const channel = trigger.channel!
    expect(channel.address).toEqual({ chatId: 'oc_dm', messageId: 'om_dm', direct: 'true' })
    // 私聊频道地址带 direct='true' 标记。
    expect(sources.channelAllowed(channel)).toBe(true)
    // 默认设置允许私聊回复。
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    // 真实 Commands 但用测试部署信息。
    const run = vi.spyOn(commands, 'run').mockResolvedValue('{"ok":true,"data":{}}')
    // spy 掉 run：假装 lark-cli 调用成功返回。
    const reply: OutboundMessage = { id: 'reply-1', channel, text: 'Done', kind: 'reply' }
    expect(await sources.send(reply, commands)).toBe('sent')
    // 经飞书 channel 发送成功。
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['+messages-reply', '--message-id', 'om_dm']))
    // 底层调用确实走了 messages-reply API 且指向原消息 om_dm。
  })
})
