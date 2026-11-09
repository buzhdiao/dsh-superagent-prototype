/**
 * 数据库迁移测试：把 schema 10 的旧库（旧命名、旧布局、遗留表）迁移到当前 SCHEMA_VERSION。
 * 覆盖：旧于 10 的库拒绝迁移、一次性写出当前形状（无代码再读旧形状）、失败时整个事务回退、
 * 授权依据/决策理由的旧文案转码、提示词版本与技能的改名、KV 冗余记录的清理、
 * outbox 收据与 effect 队列的换装、线程/触发器时间回填。测试策略：手工搭出旧 schema 的原始
 * SQLite 库，用真实 Store 打开并断言迁移结果与幂等性。
 */
import { mkdtempSync, rmSync } from 'node:fs'
// 临时目录。
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
// 直接操作 SQLite：搭建/检查旧 schema 的原始数据库。
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
// 被测：Store 打开即触发迁移；SCHEMA_VERSION 为目标版本。
import { KV } from '../src/kv.ts'
// KV：迁移后的键名。
import { basisOf, reasonsOf, withoutCopies } from '../src/app/migration.ts'
// 被测：授权依据转换、旧文案理由转码、去除派生副本。
import { Prompts, composePrompt, defaultPrompts } from '../src/app/prompts.ts'
// Prompts：提示词版本的读取与迁移改写；composePrompt：拼装完整提示词。
import { masterPrompt } from '../src/app/context.ts'
// masterPrompt：当前内置的主 Session 提示词。

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-migration-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/** Seed a SQLite database in the schema 10 layout (including the legacy `outbox.sent` column and `inbox` table). */
// 搭一个 schema 10 布局的 SQLite 库（含旧的 outbox.sent 列与遗留 inbox 表）。
function schema10(path: string, records: Record<string, unknown>, rows: { ticket?: object[]; decision?: object[]; thread?: object[]; trigger?: object[] } = {}): void {
  new Store(path).close()
  // 先用当前 Store 建出目标 schema 的表结构。
  const db = new DatabaseSync(path)
  db.exec('DROP TABLE outbox; CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)')
  // 换回 schema 10 的 outbox 表（带 sent 列）。
  const set = (name: string, value: unknown) => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
  set('schema', 10)
  // 标记为 schema 10。
  for (const [name, value] of Object.entries(records)) set(name, value)
  for (const ticket of rows.ticket ?? []) db.prepare('INSERT INTO ticket VALUES (?,?)').run((ticket as { id: string }).id, JSON.stringify(ticket))
  for (const decision of rows.decision ?? []) {
    const { id, threadKey } = decision as { id: string; threadKey: string }
    db.prepare('INSERT INTO decision VALUES (?,?,?)').run(id, threadKey, JSON.stringify(decision))
    // schema 10 的 decision 表按 (id, threadKey) 两列存。
  }
  for (const thread of rows.thread ?? []) db.prepare('INSERT INTO thread VALUES (?,?)').run((thread as { key: string }).key, JSON.stringify(thread))
  for (const trigger of rows.trigger ?? []) {
    const { id, at } = trigger as { id: string; at: string }
    db.prepare('INSERT INTO trigger VALUES (?,?,?)').run(id, JSON.stringify(trigger), at)
    // trigger 表第三列是独立的时间列。
  }
  db.exec('CREATE TABLE inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  // schema 6 的遗留表也建出来（迁移必须容忍它存在）。
  db.close()
}
const actor = { source: 'feishu', id: 'ou_alice' }
// 基准角色。
const mandate = (basis: object) => ({ strength: 'explicit', policyVersion: 'v1', basis, actor, scope: 'small' })
// 旧式 mandate：basis 的形状随用例变化。

it('refuses a database older than schema 10 and asks for a new state directory', () => {
  // 版本低于 10 无法迁移：要求换新状态目录。
  const path = join(directory, 'db.sqlite')
  new Store(path).close()
  const schema = (version: number) => { const db = new DatabaseSync(path); db.prepare("UPDATE kv SET value=? WHERE key='schema'").run(String(version)); db.close() }
  schema(9)
  expect(() => new Store(path)).toThrow(/schema 9 predates schema 10, which this version cannot migrate; start with a new state directory/)
})

it('writes a schema 10 database in its current shape once, so nothing reads an older shape', () => {
  // 主迁移用例：一次性把 schema 10 库写成当前形状，之后不再有任何代码读旧形状。
  const path = join(directory, 'db.sqlite')
  const ticket = {
    // schema 10 的工单：meta 平铺各种字段，channels/inputs 是旧形状。
    id: 't1', title: 'Fix', decisionId: 'd1', state: 'open', assignments: [], summary: '', createdAt: '1', updatedAt: '2',
    // In schema 10, a GitHub Channel without a comment link marked a PR that the ticket opened.
    // schema 10 里：不带评论链接的 GitHub Channel 表示该工单打开的 PR。
    channels: [{ source: 'github', thread: 'github:8', address: { number: '8' } }, { source: 'github', thread: 'github:7', address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#issuecomment-1' } }],
    mandate: mandate({ chatId: 'oc_team', direct: false, member: 'ou_alice', mention: true }),
    inputs: [{ id: 'i1', kind: 'reopen', decisionId: 'd2', at: '3' }, { id: 'i2', kind: 'reopen', decisionId: 'd0', at: '0' },
      { id: 'i3', kind: 'trigger', triggerId: 'trig-2', at: '4' }, { id: 'i4', kind: 'trigger', triggerId: 'ci-1', at: '5' }], undelivered: ['i1'],
    meta: { sourceTriggerId: 'trig-1', triggerIds: ['trig-1', 'trig-2'], workspace: '/w/fix-1', name: 'fix-1', sessionId: 'worker-t1', assignment: 'Read trigger/trig-1.',
      prNumber: 7, prUrl: 'https://github.com/acme/widgets/pull/7', branch: 'agent/fix-1', deliveryError: 'offline', recovery: 2, worktreeName: 'fix', scope: 'small' },
  }
  const imported = { ...ticket, id: 't2', state: 'ended', channels: [], inputs: [], undelivered: [], mandate: mandate({ legacyAuthority: 'thread_followup', followup: true }),
    meta: { sourceTriggerId: 'old', workspace: '/w/task-2', sessionId: 'worker-task-2', legacyPrompt: 'Read event/old' },
    ended: { at: '6', by: 'executor', reason: 'merged' } }
  // Ended with a person's message waiting, and with no execution or origin trigger.
  // 一个有人消息在等、但没有执行与来源触发的结束工单。
  const waiting = { ...ticket, id: 't3', state: 'ended', channels: [], ended: { at: '6', by: 'human', reason: 'Not needed' }, inputs: [{ id: 'i5', kind: 'trigger', triggerId: 'trig-2', at: '7' }],
    undelivered: ['i5'], mandate: mandate({ chatId: 'p2p', direct: true, member: 'ou_alice' }), meta: {} }
  const bare = { ...ticket, id: 't4', channels: [], inputs: [], undelivered: [], meta: undefined }
  // 连 meta 都没有的“裸”工单。
  const reopened = { id: 'd2', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-2'], kind: 'reopen', reason: 'follow-up', at: '3', ticketId: 't1', policyVersion: 'v1' }
  const unavailable = { id: 'd3', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-2'], kind: 'unavailable', reason: 'Assessment timed out', at: '5', policyVersion: 'v1' }
  const triggers = [{ id: 'trig-2', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_1' }], actor, human: true, at: '4', text: 'more', meta: {} },
    { id: 'ci-1', source: 'github', threads: [{ source: 'github', id: '7' }], actor: { source: 'github', id: 'ci' }, human: false, at: '5', text: 'CI', meta: {} }]
  const decision = { id: 'd1', threadKey: 'feishu:oc_team:om_1', triggerIds: ['trig-1'], kind: 'accept', reason: '', at: '1', ticketId: 't1', policyVersion: 'v1',
    mandate: mandate({ legacyAuthority: 'proactive_rule', observation: true, rules: ['copy'] }) }
  const evaluating = { id: 'e1', threadKey: 'github:5', triggerIds: ['x'], strength: 'inferred', actor, policyVersion: 'v1', startedAt: '', deadline: '',
    basis: { source: 'github', scope: { number: 5 }, row: 'issues', admission: 'listedUnaddressed', observation: true, mode: 'auto' } }
  const thread = { key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating, meta: {} }
  schema10(path, {
    // KV 记录：设置、历史设置、提示词版本、各来源遗留键、以及应被丢弃的缓存。
    settings: { policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'x', visual: true }] }, executor: { reviewer: 'bob', prepare: 'echo $DSH_TAG_DIR' },
      sources: { 'github-issue': { enabled: true, config: {} }, github: { enabled: true, config: { mergeCli: 'gh' } } } },
    'settings-version:1': { revision: 1, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [],
      settings: { allowedChats: ['oc_team'], members: [], sources: undefined } },
    'settings-version:2': { revision: 2, savedAt: '', source: 'orchestrator-tool', policyVersion: '', policyChanged: false, notified: [],
      settings: { sources: { 'github-issue': { enabled: true, config: {} } } } },
    'prompt-revision': 1,
    'github-ended:8': { at: '2026-09-01T00:00:00Z', reason: 'merged' },
    'problem-dismissed:d3': true,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config: { shared: 's', orchestrator: 'o', worker: 'w', guides: { release: 'Use guide/github and dsh-tag-feishu.' } } },
    'prompt-settings-text': 1,
    'task/t1/input/i0': '{"text":"old input"}',
    // schema 6 task 表对应的输入缓存。
    'task/t1/input/i9': '{"text":"older copy"}', 'ticket/t1/input/i9': '{"text":"kept"}',
    'settings-version:3': { revision: 3, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [], settings: { executor: { maxWorkers: 'many' } } },
    // 一个按当前校验会失败的无效历史设置版本。
    'prompt-version:2': { revision: 2, previousRevision: 1, savedAt: '', source: 'web', config: { communication: 1 } },
    // 一个配置非法的提示词版本。
    'answer-ready:t1:trig-3': true,
    'github-object-state:7': 'open', subscriptions: [], 'settings-before-9': { policy: {} }, 'thread-times-backfilled': true,
    'github-issue-pending': { 1: {} },
    // Caches of reads, which memory keeps now.
    // 读取缓存——现在由内存保存，迁移后必须消失。
    'feishu-read:orchestrator-1:feishu/e1/thread': '{}', 'github-read:worker-t1:github/pulls/7': '{}', 'feishu-source-link:oc_team:om_1': 'https://x',
    'orchestrator-1:prompt-preview/abc': 'prompt',
  }, { ticket: [ticket, imported, waiting, bare], decision: [decision, reopened, unavailable], thread: [thread], trigger: triggers })

  const store = new Store(path)
  expect(store.get('schema')).toBe(SCHEMA_VERSION)
  // 打开即完成迁移并写上当前版本号。
  const settings = store.settings()
  expect(Object.keys(settings.sources)).toEqual(['github'])
  // 已移除的 github-issue 来源被删除。
  expect(settings.sources.github!.config).not.toHaveProperty('mergeCli')
  expect(settings.policy.rules[0]).not.toHaveProperty('visual')
  expect(settings.executor).not.toHaveProperty('reviewer')
  // 废弃字段被剥除。
  expect(settings.executor.prepare).toBe('echo $DSH_SUPERAGENT_DIR')
  // prepare 里的旧项目名变量改写为新名。
  // The current settings are the newest revision, which the migration saved, since the newest saved one differs from them.
  // 当前设置成为最新修订（迁移替它保存的），因为最新已存版本与它不同。
  const [current, , second, first] = store.settingsHistory()
  expect(current).toMatchObject({ revision: 4, source: 'internal', settings })
  expect(store.get('settings')).toBeUndefined()
  // 旧的顶层 settings 键消失（并入版本历史）。
  expect(first).toMatchObject({ source: 'panel', settings: { sources: { feishu: { config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] } } } } })
  // 版本 1 是 web 来源的旧设置，被归为 panel。
  expect(second).toMatchObject({ source: 'tool', settings: { sources: { 'github-issue': { enabled: true } } } })
  // orchestrator-tool 来源被归为 tool。
  expect(store.get('prompt-version:1')).toMatchObject({ legacy: { config: { guides: { release: 'Use guide/github and dsh-tag-feishu.' } } },
    config: { skills: { release: 'Use the github section and dsh-superagent-feishu.' } } })
  // 旧 guides 改写成 skills 并换新命名，原文保留在 legacy 下。
  // An invalid historical prompt version keeps its raw value under legacy and falls back to the preceding version's config.
  // 非法的历史提示词版本：原值挂在 legacy 下，配置回退到前一个版本。
  expect(store.get('prompt-version:2')).toMatchObject({ legacy: { config: { communication: 1 } }, config: store.get<{ config: object }>('prompt-version:1')!.config })
  expect(store.get('settings-version:3')).toMatchObject({ source: 'panel', settings: { executor: { maxWorkers: 'many' } } })
  const migrated = store.tickets.get('t1')!
  expect(migrated).not.toHaveProperty('meta')
  // meta 平铺字段被拆进 origin/execution/delivery 等结构。
  expect(store.keys('github-ended:')).toEqual([])
  // PR 关闭记录并入 follows.closed。
  expect(store.decisions.get('d3')).toMatchObject({ kind: 'unavailable', dismissed: true })
  // problem-dismissed 键并入决策的 dismissed 标记。
  expect(store.keys('problem-dismissed:')).toEqual([])
  expect(migrated).toMatchObject({
    origin: { triggerId: 'trig-1', triggerIds: ['trig-1', 'trig-2'] },
    execution: { name: 'fix-1', directory: '/w/fix-1', assignment: 'Read trigger/trig-1.' },
    delivery: { error: 'offline', at: '2' },
    follows: [{ thread: 'github:8', own: true, closed: { at: '2026-09-01T00:00:00Z', outcome: 'merged' } }, { thread: 'github:7', own: false }],
    // 无评论链接的 channel 变为 own=true 的 PR follow，带关闭结果；有链接的是他人 PR（own=false）。
    channels: [{ source: 'github', thread: 'github:7', address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#issuecomment-1' } }],
    answers: ['trig-3'],
    // answer-ready 键变成 answers 列表。
    mandate: { basis: { via: 'listed', source: 'feishu', scope: { chatId: 'oc_team', direct: false }, sender: 'ou_alice', addressed: 'mention' } },
    // 旧 basis 字段组合转成当前形状（listed + addressed）。
  })
  expect(migrated.inputs[0]).toMatchObject({ id: 'i1', kind: 'text', text: expect.stringContaining('"resumed":true') })
  // 有决策可查的 reopen 输入渲染成 resumed 文本输入。
  expect(migrated.inputs[0]).not.toMatchObject({ text: expect.stringContaining('reopen') })
  // 文本里不再出现“reopen”旧术语。
  expect(migrated.inputs[1]).toEqual({ id: 'i2', kind: 'reopen', decisionId: 'd0', at: '0' })
  // 查不到决策的 reopen 保持原样。
  expect(migrated.inputs.slice(2)).toEqual([{ id: 'i3', kind: 'trigger', triggerId: 'trig-2', at: '4', human: true }, { id: 'i4', kind: 'trigger', triggerId: 'ci-1', at: '5' }])
  // 触发输入补上 human 标记（来自触发器）。
  expect(migrated).not.toHaveProperty('execution.recoveries')
  // recovery 计数不再保留（派生数据）。
  expect(store.tickets.get('t2')).toMatchObject({ execution: { name: 'task-2', assignment: 'Read event/old' },
    mandate: { basis: { via: 'followup', authority: 'thread_followup' } } })
  expect(store.tickets.get('t2')).not.toHaveProperty('follows')
  // An end's reason that only repeats its outcome is not kept.
  // 结束理由若只是重复结果（merged），不再保留。
  expect(store.tickets.get('t2')!.ended).toEqual({ at: '6', by: 'executor', outcome: 'merged' })
  // A ticket a person stopped keeps nothing waiting; a ticket stored without its attributes gets an origin all the same.
  // 人停的工单不留等待输入；缺属性的工单也补上空 origin。
  expect(store.tickets.get('t4')).toMatchObject({ origin: { triggerId: '', triggerIds: [] } })
  expect(store.tickets.get('t3')).toMatchObject({ ended: { outcome: 'stopped' }, undelivered: [], origin: { triggerId: '', triggerIds: [] },
    mandate: { basis: { via: 'listed', source: 'feishu', scope: { chatId: 'p2p', direct: true }, sender: 'ou_alice', addressed: 'direct' } } })
  expect(store.tickets.get('t3')).not.toHaveProperty('execution')
  // A reason is a code; words the assessor wrote stay as written.
  // 理由转成码；评估者写的话按 written 保留。
  expect(store.decisions.get('d2')).toEqual({ ...reopened, reason: [{ code: 'said', values: { text: 'follow-up' } }] })
  expect(store.decisions.get('d3')!.reason).toEqual([{ code: 'timeout' }])
  expect(store.decisions.get('d1')!.mandate!.basis).toEqual({ via: 'listed', rules: ['copy'], observation: {}, authority: 'proactive_rule' })
  expect(store.threads.get('github:5')!.evaluating!.basis).toEqual({ via: 'admission', source: 'github', scope: { number: 5 }, row: 'issues',
    cell: 'listedUnaddressed', observation: { mode: 'auto' } })
  // kv: an Input is rendered from its ticket as it is read, so no body stays; records nothing reads go, and so do the
  // removed Issue Source's, which the migration converted.
  // KV：输入在读取时才从工单渲染，正文不留存；无人读取的记录删除；已移除 Issue 来源的键同样清理。
  expect(store.get('ticket/t1/input/i0')).toBeUndefined()
  expect(store.get('ticket/t1/input/i9')).toBeUndefined()
  expect(store.keys('task/')).toEqual([])
  for (const name of ['answer-ready:t1:trig-3', 'github-object-state:7', 'subscriptions', 'settings-before-9', 'thread-times-backfilled', 'prompt-settings-text',
    'feishu-read:orchestrator-1:feishu/e1/thread', 'github-read:worker-t1:github/pulls/7', 'feishu-source-link:oc_team:om_1', 'orchestrator-1:prompt-preview/abc']) {
    expect(store.get(name)).toBeUndefined()
  }
  expect(store.get('github-issue-pending')).toBeUndefined()
  // The schema 6 tables stay, with the rows the schema 7 import left out.
  // schema 6 的表保留不动（包括 schema 7 导入时漏掉的行）。
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'inbox'").get()).toBeDefined()
  store.close()
  // Migrating the result again changes nothing.
  // 对结果再迁移一次：完全幂等。
  const db = new DatabaseSync(path)
  db.prepare("UPDATE kv SET value='10' WHERE key='schema'").run()
  db.close()
  const again = new Store(path)
  expect(again.tickets.get('t1')).toEqual(migrated)
  again.close()
})

it('keeps each message as a receipt of what became of it, with why one was dropped by the code the panel words it by', () => {
  // outbox 换装：每条消息变成“收据”，被丢弃的原因转成面板文案所用的码。
  const path = join(directory, 'db.sqlite')
  schema10(path, {})
  const db = new DatabaseSync(path)
  const message = (id: string, sent: number, fields: object = {}) => db.prepare('INSERT INTO outbox (id, value, sent) VALUES (?, ?, ?)')
    .run(id, JSON.stringify({ id, channel: { source: 'feishu', thread: 'feishu:oc_1:om_1', address: {} }, text: id, kind: 'reply', attempts: 2,
      error: 'offline', nextAttemptAt: 1, ...fields }), sent)
  message('gone', 1, { dropped: { at: '2026-09-01T00:00:00.000Z', reason: 'The conversation can no longer receive messages' } })
  message('ignored', 1, { dropped: { at: '2026-09-02T00:00:00.000Z', reason: 'The Source no longer listens to this conversation' } })
  message('sent', 1)
  message('waiting', 0)
  db.close()
  const store = new Store(path)
  expect(store.read.droppedReplies().map(item => [item.id, item.dropped.reason])).toEqual([['ignored', 'channelIgnored'], ['gone', 'channelGone']])
  // 旧文案按出现顺序映射到码：不再监听=channelIgnored，会话不可收=channelGone。
  expect(['gone', 'sent', 'waiting'].map(id => store.replyStatus(id))).toEqual(['dropped', 'sent', 'pending'])
  // A receipt holds no attempts: the message that waits has a `reply` effect, which keeps the ones it had and counts on.
  // 收据不带重试计数：等待中的消息由 reply effect 持有，沿用原计数继续累加。
  expect(store.receipts.get('waiting')).toEqual({ id: 'waiting', channel: { source: 'feishu', thread: 'feishu:oc_1:om_1', address: {} }, text: 'waiting',
    kind: 'reply', status: 'pending' })
  expect(store.db.prepare('SELECT kind, key, attempts, error FROM effect').all()).toEqual([{ kind: 'reply', key: 'waiting', attempts: 2, error: 'offline' }])
  expect(store.db.prepare("SELECT name FROM pragma_table_xinfo('outbox')").all().map(row => row.name)).not.toContain('sent')
  // outbox 表的 sent 列消失（由收据状态取代）。
  store.close()
})

it('changes nothing when one step fails: the database stays at schema 10 as it was', () => {
  // 任一步失败即整体回退：库停在 schema 10 原样。
  const path = join(directory, 'db.sqlite')
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd1', channels: [], state: 'open', assignments: [], inputs: [], undelivered: [], summary: '', createdAt: '1',
    updatedAt: '2', mandate: mandate({ via: 'listed' }), meta: { sourceTriggerId: 'trig-1', workspace: '/w/fix-1' } }
  // The current settings must validate; an invalid value aborts the migration transaction.
  // 当前设置必须通过校验；非法值会中止整个迁移事务。
  schema10(path, { settings: { executor: { maxWorkers: 'many' } } }, { ticket: [ticket] })
  expect(() => new Store(path)).toThrow(/^The orchestrator database is unchanged at schema 10: its migration to schema 11 failed: the settings: /)
  const db = new DatabaseSync(path)
  expect(db.prepare("SELECT value FROM kv WHERE key='schema'").get()).toEqual({ value: '10' })
  expect(JSON.parse(String(db.prepare("SELECT value FROM ticket WHERE id='t1'").get()!.value))).toMatchObject({ meta: { workspace: '/w/fix-1' } })
  // schema 仍是 10，工单行未被改动。
  db.close()
})

it('reads every basis an earlier gate recorded in the current shape', () => {
  // basisOf：把早期准入闸门记录的各种 basis 字段组合读成当前形状。
  const scope = { chatId: 'oc_1', direct: false }
  expect(basisOf({ source: 'feishu', scope, row: 'oc_1', sender: 'Alice', addressed: 'mention' })).toEqual({ via: 'addressed', source: 'feishu', scope, row: 'oc_1',
    sender: 'Alice', addressed: 'mention' })
  // addressed + sender 组合 → via: addressed。
  expect(basisOf({ source: 'feishu', scope, followup: true, rules: ['r'] })).toEqual({ via: 'followup', source: 'feishu', scope, rules: ['r'] })
  expect(basisOf({ source: 'feishu', scope, addressed: 'direct', admission: 'unlistedAddressed' })).toEqual({ via: 'admission', source: 'feishu', scope,
    cell: 'unlistedAddressed', addressed: 'direct' })
  // admission 字段 → via: admission（单元格名）。
  // Observed under an earlier gate that recorded no cell: the sender had to be on the list.
  // 早期闸门没记 cell 的观察式准入：发送者必然在名单上。
  expect(basisOf({ source: 'feishu', scope, sender: 'Alice', observation: true, mode: 'auto', rules: ['r'] })).toEqual({ via: 'listed', source: 'feishu', scope,
    sender: 'Alice', rules: ['r'], observation: { mode: 'auto' } })
  expect(basisOf({ chatId: 'oc_1', direct: true, followup: true, member: 'ou_a' })).toEqual({ via: 'followup', source: 'feishu', scope: { chatId: 'oc_1', direct: true },
    sender: 'ou_a' })
  // member 改名为 sender。
  expect(basisOf({ member: 'ou_a', mention: true })).toEqual({ via: 'listed', sender: 'ou_a', addressed: 'mention' })
  expect(basisOf({ legacyAuthority: 'explicit_mention' })).toEqual({ via: 'listed', authority: 'explicit_mention' })
  // legacyAuthority 保留为 authority。
  expect(basisOf({ via: 'followup' })).toEqual({ via: 'followup' })
  // 已是当前形状的原样通过。
})

/** Build a pre-team-sections prompt version where fixed and built-in guides were stored inside the config object. */
// 构造“团队分区出现之前”的提示词版本：固定与内置指南都存在 config 对象里。
const legacyPrompts = (revision: number, guides: Record<string, string> = {}) => ({
  [`prompt-version:${revision}`]: { revision, previousRevision: revision ? revision - 1 : null, savedAt: '', source: 'web',
    config: { shared: 'Legacy shared rule.', orchestrator: 'Legacy orchestrator: only route.', worker: 'Legacy worker.',
      guides: { replies: 'Legacy replies.', dispatch: 'Accept any screenshot.', work: 'Legacy work. Enable auto-merge once it changes fewer than 350 lines (additions plus deletions); and so on.',
        feishu: 'Legacy Feishu skill.', identities: 'Alice is @alice.', ...guides } } },
  'prompt-revision': revision, 'prompt-settings-text': 1,
})
const opened = (records: Record<string, unknown>) => {
  const path = join(directory, `db-${Math.random()}.sqlite`)
  schema10(path, records)
  return new Store(path)
}
// 建库并打开的小工厂（随机文件名避免互相覆盖）。

it('writes a prompt version saved before the team sections in them, keeping its skills and auto-merge threshold, and marks it', () => {
  // 旧版提示词迁移：团队分区按默认写入、技能改名并保留、自动合并阈值保住，历史标记为 legacy。
  const store = opened({ ...legacyPrompts(3, { notes: 'Call orchestrator_create_task with event_id, read event/<id>, follow guide/work and guide/release, load dsh-tag-github, cd "$DSH_TAG_DIR".' }) })
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  const { config } = prompts.version(3)
  expect(config.communication).toBe(defaultPrompts().communication)
  // 没有团队分区：写入默认沟通方式。
  expect(config.delivery).toContain('it changes fewer than 350 lines (additions plus deletions);')
  expect(config.delivery).not.toContain('fewer than 200 lines')
  // 阈值句保留且更新为当前默认（350 行）。
  // Guides that are now fixed or built-in are gone; the team's own skills stay, in current names.
  // 如今固定/内置的 guides 消失；团队自有的技能保留并换成新命名。
  expect(Object.keys(config.skills)).toEqual(['identities', 'notes'])
  expect(config.skills.notes).toBe('Call orchestrator_route (kind accept) with trigger_id, read trigger/<id>, follow the work section and skill dsh-superagent-release, load dsh-superagent-github, cd "$DSH_SUPERAGENT_DIR".')
  // 文本里的旧术语与旧变量名全部改写为新名。
  const prompt = composePrompt(config, 'orchestrator')
  expect(prompt).not.toContain('Legacy orchestrator')
  expect(prompt).toContain(masterPrompt)
  // 旧编排者文本被当前内置提示词取代。
  expect(prompts.current().revision).toBe(3)
  // Read as the built-in text, a legacy version says so instead of listing its differences.
  // 按内置文本读的旧版本：历史里标 ['legacy']，而非列差异。
  expect(prompts.history(0, 1).revisions.map(version => version.changed)).toEqual([['legacy']])
  store.close()
})

it('writes saved team sections and skills under current names: earlier project names, the tools that became reads and the routing tools', () => {
  // 已存的团队分区/技能按当前命名改写：旧项目名→新名、被 orchestrator_read 取代的工具、四个路由工具合一。
  const config = { ...defaultPrompts(), delivery: 'Merge with --repo $DSH_FREELANCER_GITHUB_REPOSITORY.',
    skills: { notes: 'Load dsh-freelancer-github; cd "$DSH_FREELANCER_DIR". List with orchestrator_tickets, then orchestrator_ticket_inspect.',
      routing: 'Accept with orchestrator_ticket_accept; stop with orchestrator_ticket_stop, never orchestrator_trigger_ignore.' } }
  const store = opened({ 'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config }, 'prompt-revision': 1, 'prompt-settings-text': 1 })
  const { config: current } = new Prompts(store, () => 100000, () => undefined, () => true).current()
  expect(current.delivery).toBe('Merge with --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY.')
  expect(current.skills.notes).toBe('Load dsh-superagent-github; cd "$DSH_SUPERAGENT_DIR". List with orchestrator_read tickets, then orchestrator_read ticket/<id>.')
  // The four routing tools are one.
  // 四个路由工具已合为一个 orchestrator_route。
  expect(current.skills.routing).toBe('Accept with orchestrator_route (kind accept); stop with orchestrator_route (kind stop), never orchestrator_route (kind ignore).')
  store.close()
})

it('writes the removed auto-merge threshold and member identities into the prompts as one new version, unless an earlier version did', () => {
  // 已移除的自动合并阈值与成员身份写进提示词（一次性新版本）；默认值/已写过则不动。
  const before = { policy: { autoMergeLineLimit: 350, members: [{ name: 'Alice', feishuId: 'ou_alice', github: 'alice' }, { name: 'Bob', feishuId: 'ou_bob', github: '' }] } }
  const store = opened({ 'settings-before-9': before })
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  const migrated = prompts.current()
  expect(migrated).toMatchObject({ revision: 1, previousRevision: 0, source: 'settings-migration' })
  expect(migrated.config.delivery).toContain('it changes fewer than 350 lines (additions plus deletions);')
  expect(migrated.config.skills.identities).toContain('- Alice (Feishu ou_alice) is @alice on GitHub')
  expect(migrated.config.skills.identities).not.toContain('Bob')
  // Bob 只有一个身份，不写入。
  expect(store.get('settings-before-9')).toBeUndefined()
  // 该键用后即删。
  store.close()
  // The default threshold and nobody with two identities change nothing; other delivery text gains the threshold as its own sentence.
  // 默认阈值且无双重身份者：不产生新版本；自定义 delivery 文本以独立一句追加阈值。
  const unchanged = opened({ 'settings-before-9': { policy: { members: [{ name: 'Bob', feishuId: 'ou_bob', github: '' }] } } })
  expect(new Prompts(unchanged, () => 100000, () => undefined, () => true).current().revision).toBe(0)
  unchanged.close()
  const own = opened({ 'settings-before-9': { policy: { autoMergeLineLimit: 80 } }, 'prompt-revision': 1,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'panel', config: { ...defaultPrompts(), delivery: 'Deliver PRs.' } } })
  expect(new Prompts(own, () => 100000, () => undefined, () => true).current().config.delivery)
    .toBe('Deliver PRs.\nEnable auto-merge only on a PR that changes fewer than 80 lines (additions plus deletions).')
  own.close()
  const done = opened({ 'settings-before-9': before, 'prompt-settings-text': 1 })
  expect(new Prompts(done, () => 100000, () => undefined, () => true).current().revision).toBe(0)
  // prompt-settings-text 标记说明已经写过：不再重复。
  done.close()
})

it('reads a current prompt version that does not read as the one before it, keeping what it said', () => {
  // 读取不了但“形状当前”的版本：原文挂 legacy，配置回退前一版。
  const config = { ...defaultPrompts(), delivery: 'Deliver PRs.' }
  const store = opened({ 'prompt-revision': 2, 'prompt-settings-text': 1,
    'prompt-version:1': { revision: 1, previousRevision: 0, savedAt: '', source: 'web', config },
    'prompt-version:2': { revision: 2, previousRevision: 1, savedAt: '', source: 'web', config: { delivery: ['not text'] } } })
  const prompts = new Prompts(store, () => 100000, () => undefined, () => true)
  expect(prompts.current()).toMatchObject({ revision: 2, config, legacy: { config: { delivery: ['not text'] } } })
  expect(prompts.history(0, 2).revisions.map(version => version.changed)).toEqual([['legacy'], []])
  store.close()
})

/**
 * Create a raw SQLite database matching the exact table DDL of the last schema 10 release (before working-set columns
 * and the `effect` table were added, and with leftover schema 6 `inbox` and `task` tables).
 */
// 搭一个与“最后一个 schema 10 版本”逐列一致的原始 SQLite 库：
// 没有工作集列、没有 effect 表，还带着 schema 6 遗留的 inbox 与 task 表。
function lastSchema10(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL, PRIMARY KEY (thread, id));
    CREATE INDEX trigger_at ON trigger(at);
    CREATE INDEX trigger_thread_at ON trigger_thread(thread, at);
    CREATE INDEX decision_thread ON decision(thread);
    CREATE TABLE inbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE task (id TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  const kv = (name: string, value: unknown) => db.prepare('INSERT INTO kv VALUES (?,?)').run(name, JSON.stringify(value))
  kv('schema', 10); kv('master-id', 'orchestrator-1'); kv('settings', { executor: { maxWorkers: 2 } })
  kv('relay-queue', [{ id: 'report:old', text: '{"kind":"worker_report"}' }])
  // relay-queue 是旧的通知队列（迁移后转为 relay effect）。
  const trigger = { id: 'trig-1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_1' }], actor, human: true, at: '2026-10-01T00:00:00Z', text: 'fix it', meta: {} }
  db.prepare('INSERT INTO trigger VALUES (?,?,?)').run(trigger.id, JSON.stringify(trigger), trigger.at)
  db.prepare('INSERT INTO trigger_thread VALUES (?,?,?,1)').run('feishu:oc_team:om_1', trigger.id, trigger.at)
  const thread = { key: 'feishu:oc_team:om_1', ref: trigger.threads[0], createdAt: trigger.at, subscriptions: ['t1'], correlated: [], pending: [], meta: {} }
  db.prepare('INSERT INTO thread VALUES (?,?)').run(thread.key, JSON.stringify(thread))
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd1', channels: [], state: 'open', summary: '', createdAt: trigger.at, updatedAt: trigger.at,
    mandate: mandate({ source: 'feishu', scope: { chatId: 'oc_team' }, sender: 'Alice', addressed: 'mention' }), inputs: [], undelivered: [],
    assignments: [{ id: 'a1', state: 'running', createdAt: trigger.at }],
    meta: { sourceTriggerId: trigger.id, triggerIds: [trigger.id], workspace: '/w/fix-1', name: 'fix-1', sessionId: 'worker-t1', assignment: 'Read trigger/trig-1.' } }
  db.prepare('INSERT INTO ticket VALUES (?,?)').run(ticket.id, JSON.stringify(ticket))
  const reply = { id: 'reply-1', channel: { source: 'feishu', thread: thread.key, address: { chatId: 'oc_team', messageId: 'om_1' } }, text: '收到', kind: 'reply', attempts: 0, error: '' }
  db.prepare('INSERT INTO outbox VALUES (?,?,0)').run(reply.id, JSON.stringify(reply))
  db.prepare('INSERT INTO inbox VALUES (?,?,0)').run('left-out', '{"id":"left-out"}')
  db.close()
}

it('opens a database the last schema 10 build left, adds what this version keeps alongside, and migrates it', () => {
  // 打开最后一个 schema 10 版本留下的库：只增不改地补齐本版本所需，再完成迁移。
  const path = join(directory, 'db.sqlite')
  lastSchema10(path)
  const store = new Store(path)
  expect(store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
  expect(store.tickets.active().map(ticket => ticket.id)).toEqual(['t1'])
  expect(store.read.subscribedThreads('feishu').map(thread => thread.key)).toEqual(['feishu:oc_team:om_1'])
  expect(store.tickets.get('t1')).toMatchObject({ origin: { triggerId: 'trig-1' }, execution: { name: 'fix-1', directory: '/w/fix-1' },
    mandate: { basis: { via: 'addressed', addressed: 'mention' } } })
  expect(store.receipts.waiting().map(item => item.id)).toEqual(['reply-1'])
  // outbox 里未 sent 的回复转为等待中的收据。
  expect(store.db.prepare('SELECT kind, key, generation FROM effect ORDER BY seq').all()).toEqual([{ kind: 'relay', key: 'report:old', generation: 0 },
    { kind: 'reply', key: 'reply-1', generation: 0 }])
  // 旧 relay-queue 与待发回复都进入 effect 表。
  expect(store.db.prepare('SELECT id FROM inbox').all()).toEqual([{ id: 'left-out' }])
  const migrated = store.tickets.get('t1')
  store.close()
  const again = new Store(path)
  expect(again.tickets.get('t1')).toEqual(migrated)
  expect(again.db.prepare('SELECT COUNT(*) AS n FROM effect').get()).toEqual({ n: 2 })
  // 幂等：effect 不重复生成。
  again.close()
})
it('writes the Sources\' records in their current shape once, so no Source converts an earlier one when it reads it', () => {
  // 来源记录一次性写成当前形状：来源代码读取时不再需要转换旧记录。
  const path = join(directory, 'db.sqlite')
  const recent = new Date(Date.now() - 3600_000).toISOString()
  const dm = { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_1' } }
  const evaluating = { id: 'e1', threadKey: 'github:5', triggerIds: ['issue'], strength: 'inferred', actor, policyVersion: 'v1',
    startedAt: '',
    deadline: '', basis: { via: 'listed' } }
  schema10(path, {
    'feishu-chats': { oc_dm: true, oc_team: false }, 'feishu-history:oc_team': '2026-09-01T00:00:00.000Z',
    // Earlier versions kept a chat's topics as a list.
    // 更早版本把会话的 topic 存成列表。
    'feishu-history-threads:oc_team': ['omt_old'],
    'github-thread:7': '2026-09-02T00:00:00.000Z', 'thread-since:github:7': '2026-09-03T00:00:00.000Z',
    'github-thread:8': '2026-09-04T00:00:00.000Z',
    'github-issue-pending': { a: { number: 12, at: recent }, b: { number: 13,
      at: '2026-01-01T00:00:00.000Z' } }, 'github-issues-since': 'x',
  }, {
    trigger: [{ id: 'dm', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_dm:om_1' }], actor, human: true,
      at: '2026-09-01T00:00:00Z',
      text: 'fix', channel: dm, meta: {} },
    { id: 'issue', source: 'github-issue', threads: [{ source: 'github', id: '12' }], actor: { source: 'github', id: 'alice' }, human: true,
      at: '2026-09-01T00:00:00Z', text: 'Login fails', meta: { number: 12 } }],
    thread: [{ key: 'feishu:oc_team:om_9', ref: { source: 'feishu', id: 'oc_team:om_9' }, createdAt: '', subscriptions: [], correlated: [],
      pending: [], meta: {} },
    { key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating,
      meta: {} }],
  })
  const db = new DatabaseSync(path)
  db.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run('r1', JSON.stringify({ id: 'r1', channel: dm, text: 'Done', kind: 'reply',
    attempts: 0, error: '' }))
  // Assessments queued before effects named their Trigger: one whose Eval runs, and one whose Eval ended.
  // effect 尚未记录 Trigger 的时代的排队评估：一个其 Eval 还在跑，一个其 Eval 已结束。
  for (const [seq, evalId] of [[1, 'e1'], [2, 'e2']] as const) {
    db.prepare('INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?)').run('assessment', evalId, '{}', seq, 0,
      '')
  }
  db.close()
  const store = new Store(path)
  expect(store.get(KV.feishu.topics('oc_team'))).toEqual({ omt_old: '2026-09-01T00:00:00.000Z' })
  // topic 列表转成“id → 时间”的映射。
  expect(store.triggers.get('dm')!.channel!.address).toEqual({ chatId: 'oc_dm', messageId: 'om_1', direct: 'true' })
  expect(store.receipts.waiting()[0]!.channel.address).toEqual({ chatId: 'oc_dm', messageId: 'om_1', direct: 'true' })
  // 频道地址补上 direct 标记（feishu-chats 记录它是私聊）。
  expect(store.threads.get('feishu:oc_team:om_9')!.meta.url).toBe('https://applink.feishu.cn/client/chat/open?openChatId=oc_team')
  // 飞书线程补上会话链接。
  expect(store.triggers.get('issue')!.source).toBe('github')
  // github-issue 来源的触发改写为 github。
  // The waiting mention within the polling horizon is read again; the older one is no fresh request.
  // 轮询窗口内等待的提及会再读一次；更旧的不算新请求。
  expect(store.get(KV.github.retries)).toEqual({ 12: { since: recent, pr: false } })
  expect(store.get(KV.github.cursor(7))).toBe('2026-09-03T00:00:00.000Z')
  expect(store.get(KV.github.cursor(8))).toBe('2026-09-04T00:00:00.000Z')
  // thread-since 键并入 cursor 键。
  for (const name of ['github-issue-pending', 'github-issues-since', 'github-thread:7', 'thread-since:github:7', 'github-thread:8']) {
    expect(store.get(name)).toBeUndefined()
  }
  const effects = store.db.prepare("SELECT key, value FROM effect WHERE kind = 'assessment'").all().map(row => [row.key,
    JSON.parse(String(row.value))])
  expect(effects).toEqual([['e1', { triggerId: 'issue' }]])
  // 还在跑的评估补上其 Trigger id；已结束的（e2）被丢弃。
  store.close()
})

it('keeps each fact of a ticket once: its end, its latest report, and no worker Session it can derive', () => {
  // withoutCopies：工单的每个事实只存一份——结束、最新报告；可推导的 worker Session 不存。
  const base = { id: 't', title: 'Fix', decisionId: 'd', channels: [], inputs: [], undelivered: [], createdAt: '1', updatedAt: '2',
    mandate: mandate({ via: 'listed' }), origin: { triggerId: 'x', triggerIds: ['x'] }, execution: { name: 'fix', directory: '/w', session: 'worker-t', assignment: 'Do it.' } }
  const open = withoutCopies({ ...base, state: 'open', summary: 'Working on it',
    assignments: [{ id: 'a1', ticketId: 't', ref: 'worker-t', state: 'running', createdAt: '1' }] })
  expect(open).toEqual({ ...base, execution: { name: 'fix', directory: '/w', assignment: 'Do it.' },
    assignments: [{ id: 'a1', state: 'running', createdAt: '1', report: { state: 'progress', summary: 'Working on it', at: '2' } }] })
  // session 字段并入派工的 ref 语义（可推导）；summary 变为派工的 report。
  // A report the ticket had stays the latest one; an ended ticket without an end record ended closed.
  // 工单已有的报告保持为最新一条；没有结束记录的结束工单按“已关闭”收尾。
  const reported = { id: 'a1', ticketId: 't', ref: '', state: 'ended', createdAt: '1', report: { state: 'ready', summary: 'Done', at: '2' } }
  expect(withoutCopies({ ...base, state: 'ended', summary: 'Done', assignments: [reported] })).toMatchObject({
    ended: { at: '2', by: 'executor', outcome: 'closed' }, assignments: [{ id: 'a1', state: 'ended', report: { summary: 'Done' } }] })
})

it('reads the reasons earlier versions stored in words as codes, and keeps any other words as written', () => {
  // reasonsOf：旧版存的文字理由转成结构化码；认不出的按 written 保留。
  expect(reasonsOf('Assessment timed out')).toEqual([{ code: 'timeout' }])
  expect(reasonsOf('a1: not_a_member; b2: no_mention')).toEqual([{ code: 'not_a_member', triggerId: 'a1' }, { code: 'no_mention', triggerId: 'b2' }])
  // “id: 码; id: 码”形式拆成多条并各带触发 id。
  expect(reasonsOf('Routed to ticket t9')).toEqual([{ code: 'routed', values: { ticket: 't9' } }])
  expect(reasonsOf('Observe mode: would accept (a copy fix)')).toEqual([{ code: 'observed', values: { text: 'a copy fix' } }])
  // An assessor's words may hold a colon or a semicolon; they stay one reason.
  // 评估者的话可能含冒号或分号：仍作为单条理由保留。
  expect(reasonsOf('Not a request: chatter; nothing to do')).toEqual([{ code: 'said', values: { text: 'Not a request: chatter; nothing to do' } }])
  expect(reasonsOf([{ code: 'timeout' }])).toEqual([{ code: 'timeout' }])
  // 已是结构化码的原样通过。
})

const ticket10 = (id: string, fields: Record<string, unknown> = {}) => ({ id, title: 'Fix', decisionId: 'd1', channels: [], state: 'open', assignments: [],
  inputs: [], undelivered: [], summary: '', createdAt: '1', updatedAt: '2', mandate: mandate({ via: 'listed' }), meta: { sourceTriggerId: 'trig-1' }, ...fields })
// schema 10 工单工厂。
/** Populate `trigger_thread` rows for `triggers` as schema 10 did on save. */
// 按 schema 10 保存时的行为填充 trigger_thread 索引行。
function indexed(path: string, triggers: { id: string; at: string; threads: { source: string; id: string }[] }[]): void {
  const db = new DatabaseSync(path)
  for (const { id, at, threads } of triggers) {
    for (const thread of threads) db.prepare('INSERT INTO trigger_thread VALUES (?, ?, ?, 1)').run(`${thread.source}:${thread.id}`, id, at)
  }
  db.close()
}

it('dates each Thread from its Triggers, and keeps every Trigger\'s time in the one form stored times take', () => {
  // 线程时间从其触发器回填；所有时间统一为毫秒精度格式。
  const path = join(directory, 'db.sqlite')
  const comment = (id: string, at: string) => ({ id, source: 'github', threads: [{ source: 'github', id: '7' }], actor, human: true, at, text: id, meta: {} })
  // GitHub wrote its times in whole seconds; a Thread a schema 10 build saved before it knew of activity times has none.
  // GitHub 的时间是整秒精度；schema 10 早期版本保存、尚不知活动时间的线程没有时间。
  const triggers = [comment('first', '2026-10-01T00:00:00Z'), comment('last', '2026-10-09T00:00:00.000Z')]
  schema10(path, {}, { trigger: triggers,
    thread: [{ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-10-05T00:00:00.000Z', subscriptions: [], correlated: [], pending: [], meta: {} }] })
  indexed(path, triggers)
  const store = new Store(path)
  expect(store.threads.get('github:7')).toMatchObject({ createdAt: '2026-10-01T00:00:00.000Z', lastAt: '2026-10-09T00:00:00.000Z' })
  // 线程起止时间来自最早/最晚触发器。
  expect(store.triggers.get('first')!.at).toBe('2026-10-01T00:00:00.000Z')
  expect(store.db.prepare("SELECT at FROM trigger WHERE id = 'first' UNION ALL SELECT at FROM trigger_thread WHERE id = 'first'").all())
    .toEqual([{ at: '2026-10-01T00:00:00.000Z' }, { at: '2026-10-01T00:00:00.000Z' }])
  // 触发器表与索引表里的时间统一为同一格式。
  store.close()
})

it('names the ticket it stopped at when a ticket does not read, and leaves the database at schema 10 as it was', () => {
  // 某张工单读不出来：报错指名该工单，且库保持在 schema 10。
  const path = join(directory, 'db.sqlite')
  const { inputs: _inputs, ...broken } = ticket10('t9')
  // 去掉必填的 inputs 字段，造一张损坏工单。
  schema10(path, {}, { ticket: [broken] })
  expect(() => new Store(path)).toThrow(/^The orchestrator database is unchanged at schema 10: its migration to schema 11 failed: ticket t9: /)
  const db = new DatabaseSync(path)
  expect(db.prepare("SELECT value FROM kv WHERE key='schema'").get()).toEqual({ value: '10' })
  expect(JSON.parse(String(db.prepare("SELECT value FROM ticket WHERE id='t9'").get()!.value))).toEqual(broken)
  db.close()
})

it('makes the newest saved revision the current settings when it holds them, and moves a lagging pointer to it', () => {
  // 设置指针修复：最新已存修订与当前设置一致时，落后的指针被推到最新。
  const path = join(directory, 'db.sqlite')
  const version = (revision: number, settings: object) => ({ revision, savedAt: '', source: 'web', policyVersion: '', policyChanged: false, notified: [], settings })
  schema10(path, { settings: { executor: { maxWorkers: 4 } }, 'settings-revision': 1, 'settings-version:1': version(1, {}),
    'settings-version:2': version(2, { executor: { maxWorkers: 4 } }) })
  const store = new Store(path)
  expect(store.settingsHistory().map(item => item.revision)).toEqual([2, 1])
  expect([store.get(KV.settings.revision), store.settings().executor.maxWorkers, store.get('settings')]).toEqual([2, 4, undefined])
  // 指针从 1 推到 2；设置值来自最新修订；顶层 settings 键消失。
  store.close()
})

it('reads the reasons a Trigger\'s filter and an Assignment\'s end stored in words as codes, and keeps an end\'s reason once', () => {
  // 触发器过滤与派工结束的旧文案转码；结束理由不重复存两份。
  const path = join(directory, 'db.sqlite')
  const assignment = (id: string, endedReason: string) => ({ id, ticketId: 't1', ref: '', state: 'ended', createdAt: '1', endedAt: '2', endedReason })
  schema10(path, {}, { ticket: [ticket10('t1', { assignments: [assignment('a1', 'Retried by a person'), assignment('a2', 'host restarted'),
    { id: 'a3', ticketId: 't1', ref: '', state: 'running', createdAt: '2' }] })] })
  const db = new DatabaseSync(path)
  db.prepare('INSERT INTO disposition VALUES (?, ?)').run('trig-1', JSON.stringify({ filtered: 'Sender is not an authorized human member', fanout: [], at: '' }))
  db.close()
  const store = new Store(path)
  expect(store.tickets.get('t1')!.assignments.map(item => item.endedReason)).toEqual(['retried', 'hostRestarted', undefined])
  // 旧文案分别映射为 retried / hostRestarted；运行中的派工没有结束理由。
  expect(store.triggers.disposition('trig-1')).toMatchObject({ filtered: { code: 'senderNotMember' } })
  store.close()
  // The Assignment an end stopped does not repeat the end's reason, which the end keeps.
  // 被结束停掉的派工不再重复结束的理由；理由由结束记录持有。
  const ended = withoutCopies({ ...ticket10('t2'), state: 'ended', ended: { at: '5', by: 'human', reason: 'Not needed', outcome: 'stopped' },
    assignments: [{ id: 'a1', state: 'ended', createdAt: '1', endedAt: '5', endedReason: 'Not needed' }] })
  expect([ended.ended, ended.assignments[0]]).toEqual([{ at: '5', by: 'human', reason: 'Not needed', outcome: 'stopped' }, { id: 'a1', state: 'ended', createdAt: '1', endedAt: '5' }])
})

it('marks a ticket\'s Channel to a direct Feishu chat as direct, and links a Thread in the Lark brand when Lark links are stored', () => {
  // 频道地址补 direct 标记；检测到 Lark（国际版）链接时线程链接用 Lark 域名。
  const path = join(directory, 'db.sqlite')
  const dm = { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: 'om_1' } }
  const lark = { id: 'lark', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_2' }], actor, human: true, at: '2026-10-01T00:00:00.000Z',
    text: 'hi', url: 'https://applink.larksuite.com/client/message/link/open?token=x', meta: {} }
  // 一条带 Larksuite 域名链接的触发器。
  schema10(path, { 'feishu-chats': { oc_dm: true } }, { ticket: [ticket10('t1', { channels: [dm] })], trigger: [lark],
    thread: [{ key: 'feishu:oc_other:om_9', ref: { source: 'feishu', id: 'oc_other:om_9' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} }] })
  const store = new Store(path)
  expect(store.tickets.get('t1')!.channels).toEqual([{ ...dm, address: { ...dm.address, direct: 'true' } }])
  expect(store.threads.get('feishu:oc_other:om_9')!.meta.url).toBe('https://applink.larksuite.com/client/chat/open?openChatId=oc_other')
  store.close()
})

it('delivers the candidate of an Eval in progress at the upgrade again, so its deadline starts and it can expire', () => {
  // 升级时仍在评估中的候选要重新投递：让评估截止期真正开始计时并可过期。
  const path = join(directory, 'db.sqlite')
  const evaluating = { id: 'e9', threadKey: 'github:9', triggerIds: ['issue-9'], strength: 'explicit', actor, policyVersion: 'v1', startedAt: '1',
    deadline: '2', basis: { via: 'listed' } }
  schema10(path, {}, {
    trigger: [{ id: 'issue-9', source: 'github', threads: [{ source: 'github', id: '9' }], actor, human: true, at: '2026-09-01T00:00:00Z', text: 'Fix it', meta: {} }],
    thread: [{ key: 'github:9', ref: { source: 'github', id: '9' }, createdAt: '', subscriptions: [], correlated: [], pending: [], evaluating, meta: {} }],
  })
  const store = new Store(path)
  const effects = store.db.prepare("SELECT key, value FROM effect WHERE kind = 'assessment'").all().map(row => [row.key, JSON.parse(String(row.value))])
  expect(effects).toEqual([['e9', { triggerId: 'issue-9' }]])
  // 评估中的候选转为带 Trigger 的 assessment effect。
  store.close()
})
