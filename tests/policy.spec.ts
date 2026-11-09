/**
 * 本测试文件覆盖策略模块（src/policy.ts 与 app/migration.ts）：
 * 来源范围（监听/观察/私聊开关/插件未装载/配置损坏/来源停用）、准入门（名单显式强度、
 * 各来源自己的名单、有工单线程上的跟进评估、被观察消息的推断强度、非人/未知/未点名拒绝）、
 * 准入表（未设格时复现旧行为、陌生点名按格升降级、名单内未点名可忽略、未监听不读表、
 * other 行、Eval 关闭时拒绝推断、显式格在任何模式都受理、跟进不受表约束、
 * 授权随格削弱而失效、格变化改变策略版本）、授权重验的表驱动穷举（docs/002 规则）、
 * 显式/规则授权的重验条件与版本变更范围、设置迁移（成员身份进来源分区、旧字段清理、
 * 旧群列表与暂停迁移、观察群不入来源、prepare 命令变量改名、mergeCli 丢弃）、
 * 评估结果（auto 才受理推断、逐规则判定、意图证据必需）、准入表设置校验、
 * 显式候选不受模式影响、名单内机器人、重复判定拒绝、策略变更对工单的影响
 * （规则改动/停用/删除、名单增删、模式退出 auto、交回格削弱）、机器人与无发送者事件
 * （GitHub 名单机器人、CI 行、飞书机器人）、以及 GitHub 接收范围行的命名。
 * 测试策略：纯函数直测——SettingsSchema 解析 + settingsPolicy/assessmentOutcome/policyEffects，
 * 不起运行时；迁移用 migrateSettings 幂等性对照。
 */
import { describe, expect, it } from 'vitest'
// vitest 断言与用例（it.each 穷举授权重验的格组合）。
import { SettingsSchema, assessmentOutcome, policyEffects, settingsPolicy, policyVersion, allowedSender, anyoneAllowed, type Settings } from '../src/policy.ts'
// 被测模块：设置 schema、策略构造、评估结果、变更影响、版本哈希与名单助手。
import type { MandateBasis } from '../src/core/index.ts'
// MandateBasis：授权依据类型。
import { migrateSettings } from '../src/app/migration.ts'
// 被测模块：旧设置迁移。
import { SourceRegistry } from '../src/sources/registry.ts'
// SourceRegistry：来源注册表（scope 与 validatePolicy 经它）。
import { feishuKind } from '../src/sources/feishu.ts'
// feishuKind：飞书来源（policy.rows/fields 参与断言）。
import { githubKind } from '../src/sources/github.ts'
// githubKind：GitHub 来源（接收范围行与字段提示）。
import type { Thread, Ticket, Trigger } from '../src/core/index.ts'
// 领域类型：线程、工单、触发器。

const MEMBER = 'ou_alice'
// 名单内的飞书成员。
const CHAT = 'oc_team'
// 名单内监听的群（仅@）。
const OBSERVED = 'oc_1111111111111111111111111111'
// 被观察的群（收全部消息）。
const feishuSource = (config: { chats: { chatId: string; listen: 'mentions' | 'all' }[]; directMessages: boolean }, enabled = true) => ({ enabled, config })
// 构造飞书来源配置。
const base = SettingsSchema.parse({
  policy: { sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'Alice' }] } } },
  eval: { mode: 'auto' },
  sources: { feishu: feishuSource({ chats: [{ chatId: CHAT, listen: 'mentions' }, { chatId: OBSERVED, listen: 'all' }], directMessages: true }) },
})
// 基准设置：名单 Alice、auto 评估、飞书一个仅@群 + 一个全量群、允许私聊。
function setup(settings: Settings = base) {
  // 以给定设置装配来源注册表与策略，返回三者。
  const sources = new SourceRegistry(() => settings)
  sources.register(feishuKind); sources.register(githubKind)
  return { sources, policy: settingsPolicy(settings, sources), version: policyVersion(settings) }
}
const { sources, policy } = setup()
// 全局共用的一套来源与策略（大多数用例直接用它）。
const thread = (subscriptions: string[] = []): Thread => ({ key: 'feishu:x', ref: { source: 'feishu', id: 'x' }, createdAt: '', subscriptions, correlated: [], pending: [], meta: {} })
// 线程 fixture：可带订阅的工单。
const feishu = (overrides: Partial<Trigger> & { meta?: Record<string, unknown> } = {}): Trigger => ({ id: 't', source: 'feishu', threads: [{ source: 'feishu', id: 'x' }], actor: { source: 'feishu', id: MEMBER }, human: true, at: '', text: 'hi', addressed: 'mention', meta: { chatId: CHAT, direct: false, mentioned: true }, ...overrides })
// 飞书触发器 fixture：默认 Alice 在 CHAT 群里点名。
const unaddressed = (overrides: Partial<Trigger> = {}): Trigger => { const { addressed: _addressed, ...rest } = feishu(overrides); return rest }
// 同上但未点名（去掉 addressed 字段）。
const github = (login: string, addressed?: 'mention'): Trigger => ({ id: 'g', source: 'github', threads: [{ source: 'github', id: '1' }], actor: { source: 'github', id: login }, human: true, at: '', text: 'x', ...addressed ? { addressed } : {}, meta: { number: 1, isPr: true } })
// GitHub 触发器 fixture：PR #1 上的消息。
const ticket = { id: 'ticket', ended: { at: '', by: 'executor', reason: 'closed', outcome: 'closed' } } as Ticket
// 已结束工单 fixture（跟进评估语境用）。

describe('source scope', () => {
  // describe 所测：来源范围判定（scope）。
  it('listens to configured chats, reads every message only where configured, and follows the direct-message switch', () => {
    // 监听配置里的群；只有配置为 all 的群才“观察”每条消息；私聊开关独立生效。
    expect(sources.scope(feishu())).toEqual({ listened: true, observed: false, row: CHAT })
    expect(sources.scope(feishu({ meta: { chatId: OBSERVED, direct: false, mentioned: false } }))).toEqual({ listened: true, observed: true, row: OBSERVED })
    expect(sources.scope(feishu({ meta: { chatId: 'oc_other', direct: false, mentioned: true } }))).toEqual({ listened: false, reason: 'chat_not_allowed' })
    expect(sources.scope(feishu({ meta: { chatId: 'p2p', direct: true, mentioned: false } }))).toEqual({ listened: true, observed: false, row: 'direct' })
    expect(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).sources.scope(feishu({ meta: { chatId: 'p2p', direct: true, mentioned: false } }))).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    // 关掉私聊开关后私聊消息被拒。
    expect(sources.scope(github('anyone'))).toEqual({ listened: true, observed: false })
    // GitHub 点名即接收。
  })
  it('listens to nothing from a configured Source whose plugin is not loaded, and keeps an invalid stored configuration disabled', () => {
    // 插件未装载的已配置来源不接收任何消息；损坏的存量配置保持停用而不抛错。
    const bare = new SourceRegistry(() => base)
    expect(bare.scope(feishu())).toEqual({ listened: false, reason: 'source_not_installed' })
    expect(bare.scope(github('anyone'))).toEqual({ listened: true, observed: false })
    // GitHub 不需要 kind 插件即可按点名接收。
    const broken = new SourceRegistry(() => SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { chats: 'oops' } } } }))
    broken.register(feishuKind)
    expect(broken.instance('feishu')).toMatchObject({ enabled: false })
    expect(broken.scope(feishu())).toEqual({ listened: false, reason: 'source_disabled' })
    // 配置非法时来源被禁用，原因标注 source_disabled。
  })
  it('filters everything from a disabled Source', () => {
    // 停用的来源过滤掉一切消息。
    expect(setup({ ...base, sources: { ...base.sources, github: { enabled: false, config: {} } } }).sources.scope(github('anyone'))).toEqual({ listened: false, reason: 'source_disabled' })
  })
})
describe('gate', () => {
  // describe 所测：准入门（gate）的强度与拒绝理由。
  it('grants explicit strength when the sender is allowed in its Source\'s part and the Source marked the Trigger addressed', () => {
    // 名单内发送者且来源标记了点名 → 显式强度，依据带上名单项与范围。
    expect(policy.gate(feishu(), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'addressed', source: 'feishu', sender: 'Alice', addressed: 'mention', scope: { chatId: CHAT } } })
    expect(policy.gate(feishu({ addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { addressed: 'direct' } })
    // 私聊点名同样显式。
    // GitHub logins compare without case; the entry's id names the sender when it has no display name.
    // GitHub 登录名比较不区分大小写；名单项没有显示名时用其 id 当发送者名。
    expect(policy.gate(github('alice', 'mention'), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { source: 'github', sender: 'Alice' } })
  })
  it('checks each Source\'s own list: a Feishu id allows nothing on GitHub', () => {
    // 各来源查自己的名单：飞书 id 在 GitHub 上无效。
    expect(policy.gate(github(MEMBER, 'mention'), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(allowedSender(base, { source: 'github', id: 'ALICE' })).toEqual({ id: 'Alice' })
    expect(allowedSender(base, { source: 'feishu', id: 'Alice' })).toBeUndefined()
    // GitHub 大小写不敏感、飞书敏感（这里匹配不到）。
    expect(anyoneAllowed(base)).toBe(true)
    expect(anyoneAllowed(SettingsSchema.parse({}))).toBe(false)
    // 有名单即“并非人人可发起”；空名单也不等于人人可发起……（此处空设置无名单故为 false）。
  })
  it('assesses follow-ups on Threads with Tickets, explicit from an allowed sender and inferred from anyone else', () => {
    // 有工单的线程上，未点名的消息按跟进评估：名单内显式、其他人推断。
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
    expect(policy.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'followup' } })
    expect(policy.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup', sender: 'Alice' } })
    expect(policy.gate(github('someone'), thread(), [ticket])).toMatchObject({ admissible: true, strength: 'inferred' })
    // 有工单（含已结束）的 GitHub 线程同理。
    // A Thread a ticket follows only for context lends no follow-up: the admission table decides, as on any Thread.
    // 仅“上下文”跟随的线程不外借跟进：像普通线程一样由准入表决定。
    const context = { ...thread(['ticket']), context: ['ticket'] }
    expect(policy.gate(unaddressed(quiet), context, [ticket])).toMatchObject({ admissible: false })
  })
  it('infers strength for allowed senders\' messages the Source observes, unless Eval is off', () => {
    // 来源观察到的名单内消息给推断强度；评估关闭（off）时拒绝。
    const observed = unaddressed({ meta: { chatId: OBSERVED, direct: false, mentioned: false } })
    expect(policy.gate(observed, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission', observation: { mode: 'auto' } } })
    expect(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy.gate(observed, thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
  })
  it('admits no direct message from a sender the Source\'s part does not allow, not even as a follow-up', () => {
    // 名单外发送者的私聊一概不收，即使是跟进。
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(['ticket']), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('rejects automated messages, unknown senders without a Thread, and allowed senders who did not address the agent', () => {
    // 三类硬拒：非人消息、无线程的陌生发送者、名单内但未点名。
    expect(policy.gate(feishu({ human: false }), thread(), [])).toEqual({ admissible: false, reason: 'not_human' })
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' } }), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(policy.gate(unaddressed({ meta: { chatId: CHAT, direct: false, mentioned: false } }), thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
  })
})
describe('admission table', () => {
  // describe 所测：准入表（admission）逐格语义。
  const STRANGER = 'ou_stranger'
  // 名单外的发送者。
  const withTable = (admission: Record<string, Record<string, string>>, config: Record<string, unknown> = {}, mode: 'off' | 'observe' | 'auto' = 'auto') => SettingsSchema.parse({ ...base,
    eval: { ...base.eval, mode },
    sources: { ...base.sources, feishu: { enabled: true, config: { ...base.sources.feishu!.config, ...config } } },
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, admission } } } })
  // 构造带指定准入表（与可选来源配置、评估模式）的设置。
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    // 在指定群里发消息：addressed=false 时去掉点名。
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  it('reproduces the behaviour before the table with every cell unset', () => {
    // 每个格都未设时：行为与准入表出现之前完全一致。
    expect(policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission', row: OBSERVED, cell: 'listedUnaddressed', observation: { mode: 'auto' } } })
    expect(policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(policy.gate(feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    // A listed sender who addresses the agent makes an explicit request whatever the table says.
    // 名单内发送者点名智能体永远是显式请求，无论表格怎么说。
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } })).policy.gate(inChat(CHAT), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit' })
  })
  it('makes an unlisted sender\'s mention explicit or inferred as the row says, and an inferred one waits for a mode that assesses', () => {
    // 陌生人的点名按所在行的格给显式/推断；推断格还需评估模式配合（off 时不收）。
    const explicit = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])
    expect(explicit).toEqual({ admissible: true, strength: 'explicit', basis: { source: 'feishu', scope: { chatId: CHAT, direct: false, mentioned: true }, row: CHAT, via: 'admission', cell: 'unlistedAddressed', addressed: 'mention' } })
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { cell: 'unlistedAddressed' } })
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }, {}, 'off')).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(setup(withTable({ direct: { unlistedAddressed: 'explicit' } })).policy.gate(feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'direct', cell: 'unlistedAddressed' } })
    // direct 行对私聊点名生效。
    expect(setup(withTable({ [OBSERVED]: { unlistedAddressed: 'explicit' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    // 行不匹配的群不受影响。
  })
  it('ignores a listed sender\'s unaddressed message where the row says so, and never reads the table for messages the chat does not receive', () => {
    // 名单内未点名的消息可按格忽略；群收不到的消息根本不读表。
    expect(setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore' } })).policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toEqual({ admissible: false, reason: 'admission_ignored' })
    // An @-only chat receives no unaddressed message, so even an inferred cell does not admit one.
    // 仅@的群收不到未点名消息，因此即使格是 inferred 也不放行。
    expect(setup(withTable({ [CHAT]: { listedUnaddressed: 'inferred' } })).policy.gate(inChat(CHAT, MEMBER, false), thread(), [])).toEqual({ admissible: false, reason: 'no_mention' })
    expect(setup(withTable({ [CHAT]: { unlistedUnaddressed: 'inferred' } })).policy.gate(inChat(CHAT, STRANGER, false), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('listens to mentions in chats that are not listed, as the row other, only when the Feishu card says so', () => {
    // 未列出的群只在其配置 otherChats: 'mentions' 时监听点名（other 行）。
    expect(sources.scope(inChat('oc_elsewhere'))).toEqual({ listened: false, reason: 'chat_not_allowed' })
    const others = setup(withTable({ other: { unlistedAddressed: 'explicit' } }, { otherChats: 'mentions' }))
    expect(others.sources.scope(inChat('oc_elsewhere'))).toEqual({ listened: true, observed: false, row: 'other' })
    expect(others.policy.gate(inChat('oc_elsewhere'), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'other' } })
    expect(others.policy.gate(inChat('oc_elsewhere', STRANGER), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'other', cell: 'unlistedAddressed' } })
    // other 行的格照常生效：名单内显式、陌生人按格。
  })
  it('admits no inferred follow-up while Eval is off, as no other inferred candidate, and still a listed sender\'s', () => {
    // Eval 关闭时推断跟进与其他推断候选一样被拒；名单内发送者的跟进仍显式放行。
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
    const off = setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy
    expect(off.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), []))
      .toEqual({ admissible: false, reason: 'not_a_member' })
    expect(off.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup' } })
  })
  it('makes an explicit request of an unlisted sender\'s message whose cell is explicit, also on a Thread with Tickets, in every mode', () => {
    // 显式格在所有模式下都把陌生人的消息变成显式请求（包括有工单的线程）。
    for (const mode of ['auto', 'observe', 'off'] as const) {
      const open = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }, {}, mode))
      expect(open.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit',
        basis: { via: 'admission', cell: 'unlistedAddressed' } })
      // A cell that is not explicit leaves the follow-up inferred, while Eval is on.
      // 非显式的格把跟进留给推断——只要评估还开着。
      const strict = setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } }, {}, mode))
      expect(strict.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject(mode === 'off'
        ? { admissible: false } : { admissible: true, strength: 'inferred', basis: { via: 'followup' } })
    }
  })
  it('keeps follow-ups on a Thread with Tickets outside the table', () => {
    // 有工单线程上的跟进不受准入表约束（即使表把两个未点名格都设为 ignore）。
    const strict = setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore', unlistedUnaddressed: 'ignore' } }))
    expect(strict.policy.gate(inChat(OBSERVED, MEMBER, false), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'followup' } })
    expect(strict.policy.gate(inChat(OBSERVED, STRANGER, false), thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'followup' } })
  })
  it('invalidates a Mandate once its cell gives less than the strength it was accepted with, and keeps it while the cell holds', () => {
    // 授权重验：所在格给的强度低于受理时即失效；格还维持就继续有效。
    const open = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })
    const gate = setup(open).policy.gate(inChat(CHAT, STRANGER), thread(), [])
    if (!gate.admissible) throw new Error('expected admission')
    const mandate = { strength: gate.strength, policyVersion: 'v', basis: gate.basis, actor: { source: 'feishu', id: STRANGER }, scope: '' }
    expect(setup(open).policy.revalidate(mandate)).toBe(true)
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.revalidate(mandate)).toBe(false)
    expect(setup(withTable({})).policy.revalidate(mandate)).toBe(false)
    // 格降到 inferred 或整行消失都使显式授权失效。
  })
  it('changes the Policy version when a cell changes', () => {
    // 格变化改变策略版本；空表与无表等价（版本不变）。
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).version).not.toBe(setup().version)
    expect(setup(withTable({})).version).toBe(setup().version)
  })
})
describe('revalidating a Mandate from the admission table', () => {
  // describe 所测：从准入表重验授权的穷举矩阵（对应 docs/002 的规则）。
  type Cell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
  const cells: Cell[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
  // 一行的三个格。
  const SENDER = 'ou_sender'
  const origins: { cell: Cell; strength: 'explicit' | 'inferred' }[] = [
    { cell: 'listedUnaddressed', strength: 'inferred' }, { cell: 'unlistedAddressed', strength: 'explicit' },
    { cell: 'unlistedAddressed', strength: 'inferred' }, { cell: 'unlistedUnaddressed', strength: 'inferred' },
  ]
  // 授权可能的来源格与强度组合。
  const cases = origins.flatMap(origin => [true, false].flatMap(listed => (['off', 'observe', 'auto'] as const).flatMap(mode => [true, false].flatMap(rule =>
    (['all', 'mentions', 'none'] as const).flatMap(scope => [true, false].map(holds => ({ ...origin, listed, mode, rule, scope, holds })))))))
  // 穷举：来源格×强度 × 现在是否在名单 × 评估模式 × 规则开关 × 群接收范围 × 格是否仍成立。
  /** docs/002: the Thread must still be received; a listed sender who addresses the agent is explicit; a sender listed since takes the listed cell. */
  // docs/002 的规则：线程仍须被接收；现在在名单且点名的发送者按显式算；
  // 后来进入名单的发送者按名单格（listedUnaddressed）重验。
  function expected({ cell, strength, listed, mode, rule, scope, holds }: typeof cases[number]): boolean {
    // 期望值：手工写出每格组合应得的布尔结果。
    if (scope === 'none') return false
    // 群不再接收 → 失效。
    if (cell === 'unlistedAddressed' && listed) return true
    // 陌生点名受理的授权，发送者进了名单后按点名算显式 → 保持。
    const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
    if ((now === 'listedUnaddressed' && !listed) || !holds) return false
    // 名单格需要发送者确实在名单；格已不成立（变 ignore）→ 失效。
    return strength === 'explicit' || (mode === 'auto' && rule)
    // 显式一直有效；推断需要 auto 模式且规则仍启用。
  }
  it.each(cases)('$cell ($strength), listed now $listed, mode $mode, rule on $rule, chat receives $scope, cell holds $holds', item => {
    // The row gives each cell the strength the Mandate was accepted with, or, when it no longer holds, ignore.
    // 每个格给授权受理时用的强度；格不再成立时是 ignore。
    const grant = (cell: Cell) => !item.holds ? 'ignore' : cell === 'unlistedAddressed' ? item.strength : 'inferred'
    const chats = item.scope === 'none' ? [] : [{ chatId: CHAT, listen: item.scope }]
    const settings = SettingsSchema.parse({
      eval: { mode: item.mode },
      sources: { feishu: feishuSource({ chats, directMessages: true }) },
      policy: {
        rules: [{ id: 'copy', name: 'Copy', enabled: item.rule, instruction: 'x' }],
        sources: { feishu: { allowed: item.listed ? [{ id: SENDER }] : [], admission: { [CHAT]: Object.fromEntries(cells.map(cell => [cell, grant(cell)])) } } },
      },
    })
    // 按用例参数装配设置：发送者是否在名单、表内三格的值。
    const addressed = item.cell === 'unlistedAddressed'
    const observed = item.strength === 'inferred' ? { observation: { mode: 'auto' as const }, rules: ['copy'] } : {}
    const basis: MandateBasis = { via: 'admission', source: 'feishu', scope: { chatId: CHAT, direct: false, mentioned: addressed }, row: CHAT, cell: item.cell,
      ...addressed ? { addressed: 'mention' as const } : {}, ...observed }
    const mandate = { strength: item.strength, policyVersion: 'v', basis, actor: { source: 'feishu', id: SENDER }, scope: '' }
    // 构造受理时的授权（依据记着当时的格与观察）。
    expect(setup(settings).policy.revalidate(mandate)).toBe(expected(item))
  })
})
describe('revalidate and version', () => {
  // describe 所测：非表来源授权的重验与版本哈希的输入。
  it('keeps explicit Mandates while the sender stays allowed and the Source still listens, and rule Mandates only while auto mode and the rules hold', () => {
    // 显式授权在发送者仍在名单、来源仍在监听时有效；规则推断授权只在 auto 模式且规则仍启用时有效。
    const basis: MandateBasis = { via: 'addressed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice', addressed: 'mention' }
    const mandate = { strength: 'explicit' as const, policyVersion: 'v', basis, actor: { source: 'feishu', id: MEMBER }, scope: '' }
    expect(policy.revalidate(mandate)).toBe(true)
    const nobody = { ...base, policy: { ...base.policy, sources: {} } }
    expect(setup(nobody).policy.revalidate(mandate)).toBe(false)
    // 名单清空 → 失效。
    const silent = { ...base, sources: { feishu: feishuSource({ chats: [], directMessages: true }) } }
    expect(setup(silent).policy.revalidate(mandate)).toBe(false)
    // 来源不再监听该范围 → 失效。
    // A Mandate from before the gate recorded how it admitted a Trigger holds while its sender is listed and the Source listens.
    // 旧版授权（via: listed，门未记录受理方式）：只要发送者在名单且来源在监听就有效。
    const listed: MandateBasis = { via: 'listed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice' }
    expect(setup(silent).policy.revalidate({ ...mandate, basis: listed })).toBe(false)
    expect(policy.revalidate({ ...mandate, basis: listed })).toBe(true)
    const inferred = { ...mandate, strength: 'inferred' as const, basis: { via: 'listed', observation: {}, rules: ['copy'] } satisfies MandateBasis }
    expect(policy.revalidate(inferred)).toBe(true)
    expect(setup({ ...base, eval: { ...base.eval, mode: 'observe' } }).policy.revalidate(inferred)).toBe(false)
    expect(setup({ ...base, policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) } }).policy.revalidate(inferred)).toBe(false)
    // 规则授权：模式退出 auto 或所依据规则被停用都失效。
    expect(setup(nobody).policy.revalidate({ ...mandate, basis: { via: 'followup' } })).toBe(true)
    // 跟进授权不依赖名单。
  })
  it('changes the Policy version for rules, accept mode and the Sources\' parts, not for pause, concurrency, models or Source configuration', () => {
    // 版本哈希只吃：规则、受理模式、各来源分区；不吃暂停/并发/模型/来源运行配置。
    const version = setup().version
    expect(setup({ ...base, paused: true, executor: { ...base.executor, maxWorkers: 9 }, eval: { ...base.eval, timeoutSeconds: 300 }, sources: { ...base.sources, github: { enabled: true, config: { pollSeconds: 600 } } } }).version).toBe(version)
    expect(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).version).toBe(version)
    // 来源运行配置（监听哪些群）不影响版本。
    expect(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).version).not.toBe(version)
    expect(setup({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources, github: { allowed: [], admission: {} } } } }).version).not.toBe(version)
    // 模式与来源分区变化都会改版本。
  })
})
describe('settings migration', () => {
  // describe 所测：旧设置迁移（migrateSettings）。
  it('moves each member\'s identity into each Source\'s part of the Policy and drops the fields prompts and the execution environment replaced', () => {
    // 成员身份逐来源进 Policy 分区；被提示词/执行环境取代的字段（成员聊天、自动合并阈值、评审模型等）删除。
    const saved = SettingsSchema.parse(migrateSettings({
      policy: { members: [{ name: 'Alice', feishuId: MEMBER, github: 'alice' }, { name: 'Bob', feishuId: 'ou_bob', github: '' }, { name: 'Carol', feishuId: '', github: 'carol' }], memberChat: CHAT, autoMergeLineLimit: 300,
        rules: [{ id: 'visual', name: 'V', enabled: true, visual: true, instruction: 'x' }] },
      executor: { maxWorkers: 2, reviewer: 'dave', visualReviewer: 'carol', branchPrefix: 'bot/' },
      sources: { feishu: { enabled: true, config: { chats: [], directMessages: true }, authority: { chats: [] } } },
    }))
    expect(saved.policy).toEqual({
      rules: [{ id: 'visual', name: 'V', enabled: true, instruction: 'x' }],
      sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }], syncChat: CHAT, admission: {} }, github: { allowed: [{ id: 'alice' }, { id: 'carol' }], admission: {} } },
    })
    // 规则去掉 visual 字段；成员按其各自的 id 拆进两个来源；memberChat 变 syncChat。
    expect(saved).toMatchObject({ paused: false, executor: { model: null, maxWorkers: 2, directory: '', prepare: '', blockedCommands: [] } })
    expect(saved.sources.feishu).toEqual({ enabled: true, config: { chats: [], directMessages: true } })
    // authority 等旧字段被丢弃。
    expect(SettingsSchema.parse(migrateSettings(saved))).toEqual(saved)
    // 迁移幂等：再迁一次不变。
    expect(SettingsSchema.parse(migrateSettings({ executor: { maxWorkers: 2, paused: true } }))).toMatchObject({ paused: true, executor: { maxWorkers: 2 } })
    // 部分旧设置也能迁（executor.paused 上提到顶层）。
  })
  it('moves pre-domain chat lists into the Feishu Source, the pause into a setting of its own, and members into the Sources\' parts', () => {
    // 更老的扁平设置：allowedChats 按观察拆进飞书、暂停独立、成员进来源分区、admission 块变 eval。
    const migrated = SettingsSchema.parse(migrateSettings({ paused: true, allowedChats: [CHAT, OBSERVED], allowDirectMessages: false, pollSeconds: 120, maxWorkers: 5, members: [{ name: 'A', feishuId: MEMBER, github: 'a' }],
      models: { orchestrator: { provider: 'p', model: 'm' }, worker: null, admission: null }, admission: { mode: 'auto', chats: [OBSERVED], maxEvaluators: 1, timeoutSeconds: 90, rules: [] } }))
    expect(migrated).toEqual({
      paused: true,
      sources: { feishu: feishuSource({ chats: [{ chatId: CHAT, listen: 'mentions' }, { chatId: OBSERVED, listen: 'all' }], directMessages: false }), github: { enabled: true, config: { pollSeconds: 120 } } },
      policy: { rules: [], sources: { feishu: { allowed: [{ id: MEMBER, name: 'A' }], admission: {} }, github: { allowed: [{ id: 'a' }], admission: {} } } },
      eval: { mode: 'auto', timeoutSeconds: 90, model: { provider: 'p', model: 'm' } },
      executor: { model: null, maxWorkers: 5, directory: '', prepare: '', blockedCommands: [] },
    })
    // 全量观察的群 listen: 'all'；admission.chats 里被观察的群也进 all；评估超时与模型归 eval。
    expect(migrateSettings(migrated)).toEqual(migrated)
    // 幂等。
  })
  it('leaves chats that were observed only while admission was off outside the Feishu Source', () => {
    // admission 关闭时仅被观察的群不进飞书来源（关闭即无观察）。
    const migrated = SettingsSchema.parse(migrateSettings({ allowedChats: [CHAT], members: [], admission: { mode: 'off', chats: [OBSERVED] } }))
    expect(migrated.sources.feishu!.config).toEqual({ chats: [{ chatId: CHAT, listen: 'mentions' }], directMessages: true })
  })
})

it('renames the variables a stored prepare command reads from earlier project names to the current one', () => {
  // 迁移把 prepare 命令里的旧项目变量名改成当前命名。
  const settings = SettingsSchema.parse(migrateSettings({ executor: { prepare: 'git worktree add "$DSH_TAG_DIR" -b "agent/${DSH_GO_NAME}" "refs/x/$DSH_FREELANCER_TICKET"' } }))
  expect(settings.executor.prepare).toBe('git worktree add "$DSH_SUPERAGENT_DIR" -b "agent/${DSH_SUPERAGENT_NAME}" "refs/x/$DSH_SUPERAGENT_TICKET"')
})

it('reads a stored GitHub Source configuration that names a merge account without it', () => {
  // 存量 GitHub 配置里的 mergeCli（合并账号 CLI）被丢弃，其余保留。
  const settings = SettingsSchema.parse(migrateSettings({ sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent', mergeCli: 'gh-merge-account', pollSeconds: 120 } } } }))
  expect(settings.sources.github!.config).toEqual({ repository: 'acme/widgets', cli: 'gh-agent', pollSeconds: 120 })
})

describe('assessment outcomes', () => {
  // describe 所测：评估结果（assessmentOutcome）。
  const settings = (mode: 'auto' | 'observe') => {
    const parsed = SettingsSchema.parse({})
    return { ...parsed, eval: { ...parsed.eval, mode } }
  }
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const judged = (current: ReturnType<typeof settings>, matched: boolean) =>
    current.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched, reason: 'judged' }))
  // 给每条启用规则一条判定。
  const accept = (current: ReturnType<typeof settings>, matched = true) => ({ decision: 'accept' as const, rule_assessments: judged(current, matched),
    direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote', worktree_name: 'fix-copy' })
  // 一份“受理”评估。
  it('accepts an inferred candidate on its matched rules in auto mode only, and the Policy admits only enabled matched rules', () => {
    // 推断候选只在 auto 模式受理；策略只放行“已启用且被匹配”的规则。
    const auto = settings('auto')
    const outcome = assessmentOutcome(accept(auto), auto, 'inferred')
    expect(outcome).toMatchObject({ kind: 'accept', rules: auto.policy.rules.filter(rule => rule.enabled).map(rule => rule.id), name: 'fix-copy' })
    expect(assessmentOutcome(accept(settings('observe')), settings('observe'), 'inferred'))
      .toMatchObject({ kind: 'ignore', reason: { code: 'observed', values: { text: 'asked' } }, audit: { would_accept: true } })
    // 观察模式不受理但记入审计（本会受理）。
    expect(assessmentOutcome(accept(auto, false), auto, 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'noRuleMatched' } })
    expect(() => assessmentOutcome({ ...accept(auto), rule_assessments: [] }, auto, 'inferred')).toThrow('Exactly one assessment for every enabled rule')
    expect(() => assessmentOutcome({ ...accept(auto), intent_evidence: null }, auto, 'inferred')).toThrow('Acceptance requires intent_evidence')
    // 缺判定或缺意图证据的受理被拒。
    const scope = { scope: () => ({ listened: true as const, observed: true }) }
    const enabled = auto.policy.rules.find(rule => rule.enabled)!.id
    expect(settingsPolicy(auto, scope).admitsInferred([enabled])).toBe(true)
    expect(settingsPolicy(auto, scope).admitsInferred(['unknown'])).toBe(false)
    expect(settingsPolicy(auto, scope).admitsInferred([])).toBe(false)
    expect(settingsPolicy(settings('observe'), scope).admitsInferred([enabled])).toBe(false)
    // admitsInferred：只认已启用规则、至少一条、且 auto 模式。
  })
})

describe('admission table settings', () => {
  // describe 所测：准入表的设置校验与显式候选的模式无关性。
  it('refuses an explicit cell for messages that do not address the agent, in the settings and in a submitted Policy', () => {
    // 未点名消息的格不允许显式：schema 与提交的 Policy 校验都拒绝。
    for (const cell of ['listedUnaddressed', 'unlistedUnaddressed']) {
      const part = { allowed: [], admission: { [CHAT]: { [cell]: 'explicit' } } }
      expect(() => SettingsSchema.parse({ policy: { sources: { feishu: part } } })).toThrow()
      expect(() => sources.validatePolicy({ feishu: part })).toThrow()
    }
    expect(sources.validatePolicy({ feishu: { allowed: [], admission: { [CHAT]: { unlistedAddressed: 'explicit' } } } }).feishu)
      .toMatchObject({ admission: { [CHAT]: { unlistedAddressed: 'explicit' } } })
    // 点名格的显式合法。
  })
  it('accepts an explicit candidate whatever the accept mode, which bears only on inferred ones', () => {
    // 显式候选在任何模式下都受理；模式只约束推断候选。
    const rules = SettingsSchema.parse({}).policy.rules.filter(rule => rule.enabled)
    const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
    const assessment = { decision: 'accept' as const, direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote',
      rule_assessments: rules.map((rule, index) => ({ rule_id: rule.id, matched: index === 0, reason: 'judged' })) }
    for (const mode of ['observe', 'off'] as const) {
      const settings = SettingsSchema.parse({ eval: { mode } })
      expect(assessmentOutcome(assessment, settings, 'explicit')).toMatchObject({ kind: 'accept', title: 'Fix' })
      expect(assessmentOutcome(assessment, settings, 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'observed' } })
    }
  })
  it('admits a listed bot that mentions the agent where the Source does not observe its messages, as a listed person\'s mention needs none', () => {
    // 名单内的机器人点名即收（与名单内的人一样，无需来源观察其消息）。
    const settings = SettingsSchema.parse({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources,
      feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts' }] } } } })
    const mention = feishu({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false, meta: { chatId: CHAT, direct: false, mentioned: true } })
    expect(setup(settings).policy.gate(mention, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'bot', addressed: 'mention', row: CHAT } })
  })
})
describe('rule judgements', () => {
  // describe 所测：逐规则判定的完整性校验。
  it('refuses an assessment that judges one enabled rule twice and leaves another unjudged', () => {
    // 同一启用规则判定两次、另一条没判：拒绝；补齐后按匹配的规则受理。
    const parsed = SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
      { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' }] } })
    const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
    const assessment = { decision: 'accept' as const, direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote',
      rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'typo' }, { rule_id: 'copy', matched: false, reason: 'again' }] }
    expect(() => assessmentOutcome(assessment, parsed, 'inferred')).toThrow('Exactly one assessment for every enabled rule')
    const once = { ...assessment, rule_assessments: [assessment.rule_assessments[0]!, { rule_id: 'visual', matched: false, reason: 'no colors' }] }
    expect(assessmentOutcome(once, parsed, 'inferred')).toMatchObject({ kind: 'accept', rules: ['copy'] })
  })
})
describe('policy effects', () => {
  // describe 所测：策略变更对存量工单的影响（policyEffects）。
  const scope = () => ({ scope: () => ({ listened: true as const, observed: true }) })
  const base = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
    { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' }],
    sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } })
  const ticket = (id: string, mandate: object) => ({ id, mandate } as unknown as Ticket)
  // 只带授权的工单 fixture。
  const inferred = ticket('t1', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, basis: { via: 'listed', rules: ['copy'] } })
  const explicit = ticket('t2', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed', source: 'feishu' } })
  it('tells a ticket how a change bears on it, and leaves the others alone', () => {
    // 变更只波及依据它受理的工单；别的工单不受影响。
    const rules = (copy: object, visual: object = {}) => ({ ...base, policy: { ...base.policy, rules: [{ ...base.policy.rules[0]!, ...copy }, { ...base.policy.rules[1]!, ...visual }] } })
    // A rule the ticket was not accepted under changes nothing for it.
    // 工单未据以受理的规则变化与它无关。
    expect(policyEffects([inferred, explicit], base, rules({}, { enabled: false }), scope).size).toBe(0)
    expect(policyEffects([inferred], base, rules({ instruction: 'Fix typos only.' }), scope).get('t1'))
      .toEqual({ rules: [{ id: 'copy', name: 'Copy', change: 'changed', instruction: 'Fix typos only.' }] })
    expect(policyEffects([inferred], base, rules({ enabled: false }), scope).get('t1')).toEqual({ rules: [{ id: 'copy', name: 'Copy', change: 'disabled' }] })
    // 依据规则的指令变化记为 changed、停用记为 disabled。
    // Another sender on the list, as a member sync adds, bears on no ticket; taking the requester off it does.
    // 名单增加发送者（成员同步）不波及任何工单；把请求者移出名单才波及。
    const allowed = (list: { id: string }[]) => ({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, allowed: list } } } })
    expect(policyEffects([inferred, explicit], base, allowed([{ id: 'ou_alice' }, { id: 'ou_bob' }]), scope).size).toBe(0)
    expect(policyEffects([explicit], base, allowed([]), scope).get('t2')).toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'ou_alice' } })
  })
  it('tells an inferred ticket that inferred work is no longer accepted when the accept mode leaves auto, and names a bot it is for', () => {
    // 模式退出 auto 时给推断工单发“不再受理推断工作”的效果；机器人的请求者单独命名。
    const auto = { ...base, eval: { ...base.eval, mode: 'auto' as const } }
    const observe = { ...base, eval: { ...base.eval, mode: 'observe' as const } }
    const rule = ticket('t3', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_alice' },
      basis: { via: 'listed', source: 'feishu', rules: ['copy'], observation: {} } })
    const effects = policyEffects([rule, explicit], auto, observe, scope)
    // Not a sender's removal: the person who wrote it may still start work.
    // 这不算移出名单：写消息的人仍可发起工作。
    expect(effects.get('t3')).toEqual({ proactive: false })
    expect(effects.has('t2')).toBe(false)
    const bot = ticket('t4', { strength: 'explicit', actor: { source: 'feishu', id: 'cli_ci_bot' }, basis: { via: 'listed', source: 'feishu' } })
    const listed = { ...base, policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, allowed: [{ id: 'cli_ci_bot' }] } } } }
    expect(policyEffects([bot], listed, base, scope).get('t4')).toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'cli_ci_bot' } })
    // 机器人不再在名单里：同样按请求者不允许处理。
  })
  it('keeps an inferred follow-up\'s Mandate only while candidates become work and its rules are on, as any inferred one', () => {
    // 推断跟进的授权与任何推断授权一样：只在 auto 模式且规则启用时有效。
    const followup = ticket('t5', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, scope: '',
      basis: { via: 'followup', source: 'feishu', scope: { chatId: 'oc_team' }, rules: ['copy'] } })
    const mode = (value: 'auto' | 'observe' | 'off') => ({ ...base, eval: { ...base.eval, mode: value } })
    const disabled = { ...mode('auto'), policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) } }
    expect(settingsPolicy(mode('auto'), scope()).revalidate(followup.mandate)).toBe(true)
    for (const settings of [mode('observe'), mode('off'), disabled]) expect(settingsPolicy(settings, scope()).revalidate(followup.mandate)).toBe(false)
    expect(policyEffects([followup], mode('auto'), mode('observe'), scope).get('t5')).toEqual({ proactive: false })
    // An explicit follow-up holds whatever the mode.
    // 显式跟进无论什么模式都有效。
    const explicitFollowup = ticket('t6', { ...followup.mandate, strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' } })
    expect(settingsPolicy(mode('off'), scope()).revalidate(explicitFollowup.mandate)).toBe(true)
  })
  it('revokes an inferred ticket whose cell weakens or whose candidates no longer become work, and reports a deleted rule disabled', () => {
    // 准入格削弱 → 撤销并点名请求者；仅模式变化只停推断；删除的规则按 disabled 上报。
    const chat = 'oc_1111111111111111111111111111'
    const table = (cell: 'inferred' | 'ignore', mode: 'auto' | 'observe' = 'auto') => SettingsSchema.parse({ ...base, eval: { ...base.eval, mode },
      policy: { ...base.policy, sources: { feishu: { ...base.policy.sources.feishu!, admission: { [chat]: { unlistedUnaddressed: cell } } } } } })
    const observed = () => ({ scope: () => ({ listened: true as const, observed: true, row: chat }) })
    const proactive = ticket('t3', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, scope: '',
      basis: { via: 'admission', cell: 'unlistedUnaddressed', source: 'feishu', scope: { chatId: chat }, row: chat, rules: ['copy'],
        observation: { mode: 'auto' } } })
    expect(policyEffects([proactive], table('inferred'), table('inferred'), observed).size).toBe(0)
    // A weaker cell takes the work from its sender, whom the effect names; a mode change only stops inferred work.
    // 格变弱会把工作从其发送者手里拿走（效果里点名）；模式变化只停推断工作。
    expect(policyEffects([proactive], table('inferred'), table('ignore'), observed).get('t3'))
      .toEqual({ requesterAllowed: false, requester: { source: 'feishu', id: 'ou_guest' } })
    expect(policyEffects([proactive], table('inferred'), table('inferred', 'observe'), observed).get('t3')).toEqual({ proactive: false })
    const deleted = { ...base, policy: { ...base.policy, rules: base.policy.rules.filter(rule => rule.id !== 'visual') } }
    const visual = ticket('t4', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' },
      basis: { via: 'listed', source: 'feishu', rules: ['visual'] } })
    expect(policyEffects([visual], base, deleted, scope).get('t4')).toEqual({ rules: [{ id: 'visual', name: 'Visual', change: 'disabled' }] })
  })
})
describe('bots and events without a sender', () => {
  // describe 所测：机器人与无发送者事件（GitHub CI）的准入。
  const observing = (config: Record<string, unknown>, part: Record<string, unknown> = {},
    mode: 'auto' | 'off' = 'auto') => SettingsSchema.parse({
    policy: { sources: { github: { allowed: [{ id: 'Alice' }], bots: [{ id: 'dependabot[bot]' }], ...part } } }, eval: { mode },
    sources: { github: { enabled: true, config } } })
  // 构造：GitHub 名单 Alice + 机器人 dependabot，可指定接收配置/分区/模式。
  const comment: Trigger = { id: 'b', source: 'github', threads: [{ source: 'github', id: '1' }],
    actor: { source: 'github', id: 'dependabot[bot]' }, human: false, at: '', text: 'Bump lodash',
    meta: { number: 1, isPr: true, kind: 'conversation' } }
  // 机器人评论 fixture。
  const ci = (meta: Record<string, unknown>): Trigger => ({ id: 'ci', source: 'github', threads: [{ source: 'github', id: 'ci:main' }],
    actor: { source: 'github', id: '' }, human: false, at: '', text: 'CI failed 1/9 on main', meta: { ci: true, ...meta } })
  // 无发送者的 CI 事件 fixture。
  it('admits a bot on its Source\'s list as an inferred candidate where the Source observes its scope, and no other bot', () => {
    // 名单内的机器人在来源观察其范围时按推断候选受理；其他机器人与非观察范围拒绝。
    const { policy } = setup(observing({ observeComments: true }))
    expect(policy.gate(comment, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'bot', source: 'github', sender: 'dependabot[bot]', row: 'comments', observation: { mode: 'auto' } } })
    // A bot that addresses the agent still makes no explicit request; on a Thread with tickets it is no follow-up either.
    // 机器人点名也不构成显式请求；在有工单的线程上也不算跟进。
    expect(policy.gate({ ...comment, addressed: 'mention' }, thread(['ticket']), [ticket])).toMatchObject({ strength: 'inferred',
      basis: { via: 'bot', addressed: 'mention' } })
    expect(policy.gate({ ...comment, actor: { source: 'github', id: 'renovate[bot]' } }, thread(), [])).toEqual({ admissible: false,
      reason: 'not_human' })
    expect(setup(observing({})).policy.gate(comment, thread(), [])).toEqual({ admissible: false, reason: 'not_human' })
    expect(setup(observing({ observeComments: true }, {}, 'off')).policy.gate(comment, thread(), [])).toEqual({ admissible: false,
      reason: 'admission_ignored' })
    // 来源不观察其范围或评估关闭都拒绝。
  })
  it('keeps a bot candidate\'s Mandate while the bot stays on its list and candidates may become work', () => {
    // 机器人候选的授权在机器人仍在名单、候选仍能成为工作时有效。
    const settings = observing({ observeComments: true })
    const mandate = { strength: 'inferred' as const, policyVersion: '', actor: comment.actor, scope: '',
      basis: { via: 'bot' as const, source: 'github', scope: comment.meta, row: 'comments', sender: 'dependabot[bot]',
        observation: { mode: 'auto' as const } } }
    expect(setup(settings).policy.revalidate(mandate)).toBe(true)
    expect(setup(observing({ observeComments: true }, { bots: [] })).policy.revalidate(mandate)).toBe(false)
    expect(setup({ ...settings, eval: { ...settings.eval, mode: 'observe' } }).policy.revalidate(mandate)).toBe(false)
    // 移出机器人名单或模式退出 auto 都失效。
  })
  it('admits the default branch\'s CI through its row once observed and set, and never a PR\'s CI', () => {
    // 默认分支的 CI：来源观察且准入表设了格才受理；PR 的 CI 永不受理。
    const admission = { ci: { unlistedUnaddressed: 'inferred' } }
    const branch = setup(observing({ observeCi: true }, { admission })).policy.gate(ci({ branch: 'main' }), thread(), [])
    expect(branch).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'admission', cell: 'unlistedUnaddressed', row: 'ci', observation: { mode: 'auto' } } })
    // The cell defaults to ignore, so observing the CI changes nothing until the table says so.
    // CI 格默认 ignore：只开观察开关不读表时仍拒绝。
    expect(setup(observing({ observeCi: true })).policy.gate(ci({ branch: 'main' }), thread(), [])).toEqual({ admissible: false,
      reason: 'admission_ignored' })
    const pull = setup(observing({ observeCi: true }, { admission })).policy.gate(ci({ number: 9, isPr: true }), thread(), [])
    expect(pull).toEqual({ admissible: false, reason: 'not_human' })
    // PR 的 CI（非默认分支）一律拒绝。
  })
  it('admits a Feishu bot on its list in a chat the Source observes', () => {
    // 飞书机器人在来源观察的群里（未点名）也按推断受理。
    const settings = SettingsSchema.parse({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources,
      feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts', name: 'Alerts' }] } } } })
    const alert = unaddressed({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false,
      meta: { chatId: OBSERVED, direct: false, mentioned: false } })
    expect(setup(settings).policy.gate(alert, thread(), []))
      .toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'bot', sender: 'Alerts', row: OBSERVED } })
    // In a chat the Source receives only mentions in, a bot's message that does not address the agent is not received.
    // 在仅@的群里，机器人未点名的消息收不到。
    const unobserved = setup(settings).policy.gate({ ...alert, meta: { chatId: CHAT, direct: false, mentioned: false } }, thread(), [])
    expect(unobserved).toEqual({ admissible: false, reason: 'not_human' })
  })
  it('says on the GitHub bot list when a listed bot\'s comment is received: when it mentions the agent, or comments are observed', () => {
    // GitHub 机器人名单字段的提示说明“何时收到其评论”：点名或开了评论观察。
    const field = githubKind.policy!.fields.find(item => item.key === 'bots')!
    const comments = githubKind.fields.find(item => item.key === 'observeComments')!.label
    expect(field.hint!.en).toContain('mentions the agent')
    expect(field.hint!.en).toContain(comments.en)
    expect(field.hint!.zh).toContain(comments.zh)
    // 提示文本引用评论观察开关的标签（中英文）。
  })
  it('names a GitHub Trigger\'s receiving scope, which the Source observes where its switch is on', () => {
    // GitHub 触发器的接收范围命名：开关打开的范围才 observed；CI 行只给默认分支。
    const { sources } = setup(observing({ observeIssues: true }))
    const github = (meta: Record<string, unknown>) => ({ source: 'github', meta })
    expect(sources.scope(github({ kind: 'issue', number: 3 }))).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(sources.scope(github({ kind: 'pull', number: 4, isPr: true }))).toEqual({ listened: true, observed: false, row: 'pulls' })
    expect(sources.scope(github({ kind: 'inline', number: 4 }))).toEqual({ listened: true, observed: false, row: 'comments' })
    expect(sources.scope(github({ ci: true, branch: 'main' }))).toEqual({ listened: true, observed: false, row: 'ci' })
    expect(sources.scope(github({ ci: true, number: 4 }))).toEqual({ listened: true, observed: false })
    // PR 的 CI 没有行。
    const rows = githubKind.policy!.rows!({ observeIssues: true })
    expect(rows.map(row => [row.id, row.cells])).toEqual([
      ['issues', { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }],
      ['pulls', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['comments', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ['ci', { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false }]])
    // 各行提供哪些格：issues 三格全开，PR/评论只有点名格，CI 无格（默认 ignore）。
  })
})
