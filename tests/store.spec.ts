/**
 * 本测试文件覆盖 Store（src/app/store.ts，SQLite 持久化层）：
 * 拒绝过新 schema 的库并回滚失败的原子操作、按线程查触发器（重复保存替换所在线程）、
 * 工作集（open/active/subscribed）在 SQLite 与内存实现下读法一致、给旧库补建工作集列、
 * 线程按首条人触发器命名、按来源统计触发器与过滤列表、线程链接到来源给的页面、
 * meta 的来源键增删、KV 键只经 KV 注册表拼写（防裸字符串）、afterCommit 的提交/回滚语义、
 * 提交后回调失败不上报丢失、打不开的库必须关闭句柄、设置按修订快照保存、
 * 重定义/废弃工作集列的迁移、两实现顺序一致与嵌套事务回滚、状态目录与库文件的权限、
 * 以及键前缀与搜索里 `%`/`_` 按字面读。测试策略：临时目录起真实 SQLite Store，
 * 与 MemoryRepositories 对照跑同样序列，必要时用原生 DatabaseSync 手工造旧库。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
// 临时目录、枚举源码文件、读文件、清理与查权限。
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 由 import.meta.url 定位 src 目录（KV 键拼写检查用）。
import { DatabaseSync } from 'node:sqlite'
// 原生 SQLite：手工构造旧/异形库。
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
// vitest 断言与用例；vi 监听 close 调用。
import { Store, SCHEMA_VERSION } from '../src/app/store.ts'
// 被测模块：Store 与当前 schema 版本。
import { MemoryRepositories, key, type Assignment, type Decision, type Repositories, type Thread, type Ticket } from '../src/core/index.ts'
// core：内存仓库（与 SQLite 对照）与领域类型；key：输入资源键。
import { threadFacts } from '../src/app/views/records.ts'
// threadFacts：线程事实视图（含链接解析）。
import { KV } from '../src/kv.ts'
// KV：键族注册表。
import { SettingsSchema } from '../src/policy.ts'
// SettingsSchema：最小合法设置。


let directory: string
// 每个用例的状态目录。
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-store-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it('refuses databases newer than this build and rolls back failed atomic work', () => {
  // 拒绝比当前构建更新的库；原子操作失败时写入全部回滚。
  const path = join(directory, 'orchestrator.sqlite')
  const store = new Store(path)
  expect(() => store.atomic(() => { store.set('a', 1); throw new Error('boom') })).toThrow('boom')
  expect(store.get('a')).toBeUndefined()
  // 抛错的 atomic 不留下任何写入。
  store.set('schema', SCHEMA_VERSION + 1); store.close()
  expect(() => new Store(path)).toThrow('Unsupported')
  // schema 更新的库以“Unsupported”拒绝打开。
})
it('finds triggers by thread', () => {
  // 按线程键查触发器：时间升序、跨来源；再次保存只保留新给的线程。
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.triggers.save({ id: 'a', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_%_x' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '2', text: 'later', meta: {} })
  store.triggers.save({ id: 'b', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_%_x' }, { source: 'github', id: '3' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '1', text: 'earlier', meta: {} })
  store.triggers.save({ id: 'c', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_y_x' }], actor: { source: 'feishu', id: 'u' }, human: true, at: '3', text: 'other', meta: {} })
  // % 在键里按字面存储（不展开通配），c 属于另一线程。
  expect(store.read.threadTriggers('feishu:oc_1:om_%_x').map(trigger => trigger.id)).toEqual(['b', 'a'])
  expect(store.read.threadTriggers('github:3').map(trigger => trigger.id)).toEqual(['b'])
  // Saving a Trigger again replaces the Threads it is found on.
  // 再次保存触发器会替换它所在的线程集合。
  store.triggers.save({ ...store.triggers.get('b')!, threads: [{ source: 'github', id: '3' }] })
  expect(store.read.threadTriggers('feishu:oc_1:om_%_x').map(trigger => trigger.id)).toEqual(['a'])
  expect(store.read.threadTriggers('github:3').map(trigger => trigger.id)).toEqual(['b'])
  expect(store.read.subscribedThreads()).toEqual([])
  // 没有工单订阅任何线程。
  store.close()
})
const ticket = (id: string, state: 'open' | 'ended', assignments: Pick<Assignment, 'state'>[], undelivered: string[] = []): Ticket => ({
  id, title: id, decisionId: '', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
  channels: [], assignments: assignments.map((item, index) => ({ id: `${id}-${index}`, createdAt: '', ...item })), inputs: [],
  ...state === 'ended' ? { ended: { at: '', by: 'executor' as const, reason: 'closed', outcome: 'closed' as const } } : {},
  undelivered, createdAt: '', updatedAt: '', origin: { triggerId: '', triggerIds: [] } })
// 工单 fixture：指定派工状态序列与未送达输入，ended 时补结束信息。
const thread = (id: string, source: string, fields: Partial<Thread> = {}): Thread =>
  ({ key: `${source}:${id}`, ref: { source, id }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {}, ...fields })
// 线程 fixture：可覆盖任意字段。
const ids = (items: { id?: string; key?: string }[]) => items.map(item => item.id ?? item.key).sort()
// 取 id/key 并排序（跨实现比较用）。
it('reads the working sets alone, in SQLite as in memory, and follows each save', () => {
  // 工作集（open/active/subscribed）在 SQLite 与内存实现下读法一致，且跟随每次保存。
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  for (const repo of [store, new MemoryRepositories()] as Repositories[]) {
    repo.tickets.save(ticket('running', 'open', [{ state: 'running' }]))
    // A retry or a resume adds a pending Assignment after the ones that ended.
    // 重试或恢复会在已结束的派工之后追加 pending 派工。
    repo.tickets.save(ticket('queued', 'open', [{ state: 'ended' }, { state: 'pending' }]))
    // An ended Ticket a person's message reached without resuming it, which versions before schema 11 left to their next pass.
    // 已结束但被人消息触及、尚未恢复的工单（schema 11 之前的版本留给下一轮处理）也属于 active。
    repo.tickets.save(ticket('waking', 'ended', [{ state: 'ended' }], ['input']))
    repo.tickets.save(ticket('done', 'ended', [{ state: 'ended' }]))
    repo.threads.save(thread('1', 'github', { pending: ['a'] }))
    repo.threads.save(thread('2', 'github', { subscriptions: ['running'], evaluating: { id: 'e', threadKey: 'github:2', triggerIds: ['b'], strength: 'explicit',
      actor: { source: 'github', id: 'alice' }, basis: { via: 'followup' }, policyVersion: '', startedAt: '', deadline: '' } }))
    repo.threads.save(thread('oc:om', 'feishu', { subscriptions: ['done'] }))
    repo.threads.save(thread('3', 'github'))
    // 四类线程：待评估、订阅+评估中、仅订阅已结束工单、闲置。
    expect(ids(repo.tickets.open())).toEqual(['queued', 'running'])
    expect(ids(repo.tickets.active())).toEqual(['queued', 'running', 'waking'])
    expect(ids(repo.threads.active())).toEqual(['github:1', 'github:2'])
    // open 看状态，active 额外收“将醒”的工单；线程 active 看待评估/评估中。
    repo.tickets.save(ticket('running', 'ended', [{ state: 'ended' }]))
    repo.threads.save(thread('1', 'github'))
    expect(ids(repo.tickets.open())).toEqual(['queued'])
    expect(ids(repo.tickets.active())).toEqual(['queued', 'waking'])
    expect(ids(repo.threads.active())).toEqual(['github:2'])
    // 保存后工作集立即跟随变化。
  }
  expect(ids(store.read.subscribedThreads())).toEqual(['feishu:oc:om', 'github:2'])
  expect(ids(store.read.subscribedThreads('github'))).toEqual(['github:2'])
  // 订阅线程视图可按来源过滤。
  store.close()
})
it('adds the working sets to a database that predates them, from the rows it holds', () => {
  // 给缺少工作集列的旧库从已有行补建这些列。
  const path = join(directory, 'orchestrator.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE thread (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  db.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(SCHEMA_VERSION))
  db.prepare('INSERT INTO ticket VALUES (?,?)').run('t', JSON.stringify(ticket('t', 'open', [{ state: 'running' }])))
  db.prepare('INSERT INTO thread VALUES (?,?)').run('github:1', JSON.stringify(thread('1', 'github', { pending: ['a'], subscriptions: ['t'] })))
  db.close()
  // 手工造一个只有基表的旧库，塞入运行中的工单与活跃线程行。
  const store = new Store(path)
  expect([ids(store.tickets.open()), ids(store.tickets.active())]).toEqual([['t'], ['t']])
  expect([ids(store.threads.active()), ids(store.read.subscribedThreads('github'))]).toEqual([['github:1'], ['github:1']])
  // 打开时补建列并从 JSON 行填充，工作集立即可用。
  store.close()
})
it('names a thread by its first human trigger', () => {
  // 线程命名取首条触发器；可选只取人的触发器。
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const base = { source: 'github', threads: [{ source: 'github', id: '5' }], actor: { source: 'github', id: 'x' }, meta: {} }
  store.triggers.save({ ...base, id: 'ci', human: false, at: '1', text: 'GitHub PR #5 CI: {}' })
  store.triggers.save({ ...base, id: 'person', human: true, at: '2', text: 'please look' })
  expect(store.read.firstTrigger('github:5')?.id).toBe('ci')
  expect(store.read.firstTrigger('github:5', true)?.id).toBe('person')
  // 不带参数取最早一条（自动 CI），human=true 时取最早的人消息。
  store.close()
})

it('counts triggers per Source and lists them newest first, optionally only the filtered ones', () => {
  // 按来源统计触发器（截止时间后新收的），列表新者在前，可只列被过滤的。
  const store = new Store(join(directory, 'db.sqlite'))
  const trigger = (id: string, source: string, at: string) => ({ id, source, threads: [{ source, id: 'x' }], actor: { source, id: 'a' }, human: true, at, text: id, meta: {} })
  store.triggers.save(trigger('old', 'feishu', '2026-09-01T00:00:00Z'))
  store.triggers.save(trigger('kept', 'feishu', '2026-09-23T00:00:00Z'))
  store.triggers.save(trigger('dropped', 'feishu', '2026-09-23T01:00:00Z'))
  store.triggers.saveDisposition('dropped', { filtered: { code: 'chat_not_allowed' }, fanout: [], at: '' })
  // dropped 记录“聊天不在准入”的过滤处置。
  store.triggers.save(trigger('gh', 'github', '2026-09-22T00:00:00Z'))
  expect(store.read.triggerStats('2026-09-22T12:00:00Z')).toEqual({ feishu: { received: 2, filtered: 1, lastAt: '2026-09-23T01:00:00Z' }, github: { received: 0, filtered: 0, lastAt: '2026-09-22T00:00:00Z' } })
  // 统计只看截止时间之后收到的：feishu 收 2 过滤 1；github 只收早于截止的一条。
  expect(store.read.triggers({ source: 'feishu' }, 0, 2)).toEqual({ items: [expect.objectContaining({ id: 'dropped' }), expect.objectContaining({ id: 'kept' })], more: true })
  expect(store.read.triggers({ filtered: true }).items.map(item => item.id)).toEqual(['dropped'])
  // 列表按时间倒序分页；filtered 过滤只出被拒的。
  store.close()
})

it('links a Thread to the page its Source named, or else to the message that started it', () => {
  // 线程链接优先用来源在 meta 里给的页面，否则退回发起消息的链接。
  const store = new Store(join(directory, 'links.sqlite'))
  const thread = (keyValue: string, source: string, id: string, meta: Record<string, unknown> = {}) => store.threads.save({ key: keyValue, ref: { source, id }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta })
  thread('github:7', 'github', '7', { url: 'https://github.com/acme/widgets/pull/7' })
  thread('feishu:oc_1:om_1', 'feishu', 'oc_1:om_1')
  store.triggers.save({ id: 'f1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true, at: '1', text: 'hi', url: 'https://applink.feishu.cn/client/message/link/open?token=t', meta: {} })
  expect(threadFacts(store, store.threads.get('github:7')!).url).toBe('https://github.com/acme/widgets/pull/7')
  expect(threadFacts(store, store.threads.get('feishu:oc_1:om_1')!).url).toBe('https://applink.feishu.cn/client/message/link/open?token=t')
  // GitHub 用 meta.url；飞书退回首条触发器的消息链接。
  store.close()
})

it('sets and removes a Source\'s keys in a Thread\'s meta', () => {
  // patchMeta 增改来源键、置 undefined 即删除；不存在的线程不创建。
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.threads.save({ key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: { isPr: true, gone: true } })
  store.threads.patchMeta('github:5', { gone: undefined, title: 'Fix' })
  expect(store.threads.get('github:5')!.meta).toEqual({ isPr: true, title: 'Fix' })
  // gone 键被删除，title 新增，isPr 保留。
  store.threads.patchMeta('github:6', { title: 'none' })
  expect(store.threads.get('github:6')).toBeUndefined()
  // 对不存在的线程 patch 不创建线程。
  store.close()
})
it('spells every kv key in KV alone, so each record is named by its entry there', () => {
  // 所有 KV 键只能经 KV 注册表拼写：源码里不得出现内联的裸键字符串。
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const entries = Object.values(KV).flatMap(group => Object.values(group) as (string | { prefix: string })[])
  // Ignore single-word keys that collide with unrelated string literals.
  // 忽略会与无关字符串字面量撞车的单词键，只检查含 -/: 的复合键。
  const keys = entries.map(entry => typeof entry === 'string' ? entry : entry.prefix).filter(name => /[-:]/.test(name))
  const modules = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter(path => /\.tsx?$/.test(path) && !['kv.ts', join('app', 'migration.ts')].includes(path))
  const spelled = modules.flatMap(path => {
    const text = readFileSync(join(src, path), 'utf8')
    return keys.filter(name => text.includes(`'${name}`) || text.includes(`\`${name}`)).map(name => `${path}: ${name}`)
  })
  expect(spelled).toEqual([])
  // 任何源码文件以引号内联拼写这些键都算违规。
})

it('runs what waits for a commit once the outermost transaction commits, and never what a rolled back one queued', () => {
  // afterCommit 的回调在外层事务提交后执行；回滚事务排队的回调永不执行。
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const ran: string[] = []
  store.atomic(() => {
    store.afterCommit(() => { ran.push('outer') })
    store.atomic(() => { store.afterCommit(() => { ran.push('inner') }) })
    expect(() => store.atomic(() => { store.afterCommit(() => { ran.push('rolled back') }); throw new Error('boom') })).toThrow('boom')
    // Nothing runs before the outermost transaction commits.
    // 最外层事务提交前什么都不执行。
    expect(ran).toEqual([])
  })
  expect(ran).toEqual(['outer', 'inner'])
  // 提交后按排队顺序执行，被回滚的回调消失。
  expect(() => store.atomic(() => { store.afterCommit(() => { ran.push('failed') }); throw new Error('boom') })).toThrow('boom')
  store.afterCommit(() => { ran.push('outside') })
  expect(ran).toEqual(['outer', 'inner', 'outside'])
  // 事务外排队的回调立即执行。
  store.close()
})

it('reports an action that fails after a commit, runs the others, and keeps what committed', () => {
  // 提交后回调抛错：上报错误但不影响其他回调，已提交的数据保留。
  const reported: unknown[] = []
  const store = new Store(join(directory, 'orchestrator.sqlite'), error => { reported.push(error) })
  // 构造带错误上报通道的 Store。
  const ran: string[] = []
  const value = store.atomic(() => {
    store.set(KV.runtime.masterId, 'm')
    store.afterCommit(() => { throw new Error('cancel failed') })
    store.afterCommit(() => { ran.push('next') })
    return 'done'
  })
  expect(value).toBe('done')
  expect(ran).toEqual(['next'])
  // 抛错的回调之后的回调照常执行。
  expect(reported).toEqual([new Error('cancel failed')])
  expect(store.get(KV.runtime.masterId)).toBe('m')
  // 错误被上报，事务数据完好。
  store.close()
})

it('closes a database it cannot open as this version\'s, so a later attempt can open it', () => {
  // 打不开（版本不支持）的库也要关闭句柄，让后续尝试能打开它。
  const path = join(directory, 'orchestrator.sqlite')
  const store = new Store(path)
  store.set(KV.store.schema, SCHEMA_VERSION + 1)
  store.close()
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  try {
    expect(() => new Store(path)).toThrow('Unsupported orchestrator database version')
    expect(close).toHaveBeenCalledOnce()
    // 拒绝打开的同时 close 恰好被调用一次。
  } finally { close.mockRestore() }
})
it('keeps the settings as versions: the current settings are the snapshot of the current revision, kept nowhere else', () => {
  // 设置按版本保存：当前设置即当前修订的快照，不再另存一份。
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  expect(store.settings()).toEqual(SettingsSchema.parse({}))
  store.saveSettings({ ...store.settings(), paused: true }, { source: 'panel', block: 'pause', policyVersion: 'v', policyChanged: false, notified: [] })
  store.saveSettings({ ...store.settings(), executor: { ...store.settings().executor, maxWorkers: 5 } })
  // 面板保存（带 block）与内部保存各产生一个修订。
  expect(store.settings()).toMatchObject({ paused: true, executor: { maxWorkers: 5 } })
  expect(store.settingsHistory().map(version => [version.revision, version.source])).toEqual([[2, 'internal'], [1, 'panel']])
  // 历史新者在前：内部保存记为 internal。
  expect([store.get(KV.settings.revision), store.blockRevision('pause'), store.keys('settings').filter(name => name === 'settings')]).toEqual([2, 1, []])
  // 修订号、暂停块修订号递增；不存在名为 'settings' 的裸键。
  store.close()
})

it('replaces a working-set column an earlier build defined otherwise, and drops one this version no longer has', () => {
  // 重定义旧构建定义不同的工作集列，并删除本版本已不存在的列。
  const path = join(directory, 'orchestrator.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    ALTER TABLE ticket ADD COLUMN open INTEGER AS (CASE WHEN value ->> '$.state' = 'open' THEN 1 END);
    ALTER TABLE ticket ADD COLUMN ref TEXT AS (nullif(value ->> '$.assignments[#-1].ref', ''));
    CREATE INDEX ticket_open ON ticket(open) WHERE open IS NOT NULL; CREATE INDEX ticket_ref ON ticket(ref) WHERE ref IS NOT NULL`)
  db.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(SCHEMA_VERSION))
  db.prepare('INSERT INTO ticket (id, value) VALUES (?,?)').run('t', JSON.stringify(ticket('t', 'open', [{ state: 'running' }])))
  db.close()
  // 手工造一个 open 列定义与当前不同的旧库（不看 ended/assignments）。
  const store = new Store(path)
  // The open set reads the ticket's end now.
  // 现在的 open 集按“工单是否结束”计算。
  expect(ids(store.tickets.open())).toEqual(['t'])
  expect(store.db.prepare("SELECT name FROM pragma_table_xinfo('ticket') WHERE name = 'ref'").all()).toEqual([])
  // 旧库的 ref 列已被删除。
  store.close()
})

it('lists in the same order in SQLite and in memory, and undoes a failed nested transaction alone in both', () => {
  // 两种实现的列表顺序一致；失败的嵌套事务只回滚自己的写入，两种实现一致。
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const order = (items: { id?: string; key?: string }[]) => items.map(item => item.id ?? item.key)
  const decision = (id: string): Decision => ({ id, evalId: '', threadKey: 'github:1', triggerIds: [], policyVersion: '', at: id, kind: 'ignore', reason: [],
    strength: 'explicit' })
  const run = (repo: Repositories) => {
    repo.tickets.save(ticket('first', 'open', [{ state: 'running' }]))
    repo.tickets.save(ticket('second', 'ended', [{ state: 'ended' }]))
    repo.tickets.save(ticket('third', 'open', [{ state: 'pending' }]))
    // Saving a ticket again keeps its place.
    // 再次保存工单保持原有位置。
    repo.tickets.save({ ...repo.tickets.get('first')!, title: 'again' })
    repo.threads.save(thread('1', 'github', { pending: ['a'] })); repo.threads.save(thread('2', 'github')); repo.threads.save(thread('3', 'github', { pending: ['b'] }))
    repo.decisions.save(decision('d2'))
    repo.decisions.save(decision('d1'))
    // A failed nested transaction undoes its own writes; the one around it goes on and keeps its own.
    // 失败的嵌套事务只撤销自己的写入；外层事务继续并保留自己的写入。
    repo.atomic(() => {
      repo.tickets.save(ticket('outer', 'open', []))
      expect(() => repo.atomic(() => { repo.tickets.save(ticket('inner', 'open', [])); throw new Error('boom') })).toThrow('boom')
    })
    return { tickets: order(repo.tickets.list()), open: order(repo.tickets.open()), active: order(repo.tickets.active()), threads: order(repo.threads.list()),
      activeThreads: order(repo.threads.active()), decisions: order(repo.decisions.byThread('github:1')) }
  }
  const memory = run(new MemoryRepositories())
  expect(memory).toEqual({ tickets: ['outer', 'third', 'second', 'first'], open: ['outer', 'third', 'first'], active: ['third', 'first'],
    threads: ['github:1', 'github:2', 'github:3'], activeThreads: ['github:1', 'github:3'], decisions: ['d2', 'd1'] })
  expect(run(store)).toEqual(memory)
  // SQLite 实现与内存实现输出完全一致（含顺序与回滚结果）。
  store.close()
})

it('creates the state directory for its owner alone, and the database readable by its owner alone', () => {
  // 状态目录 0700、数据库文件 0600：仅属主可读写。
  const path = join(directory, 'state', 'orchestrator.sqlite')
  new Store(path).close()
  expect([statSync(dirname(path)).mode & 0o777, statSync(path).mode & 0o777]).toEqual([0o700, 0o600])
})

it('reads `%` and `_` in a key prefix and a search query as written, not as patterns', () => {
  // 键前缀与搜索词里的 % / _ 按字面匹配，不当 SQL 通配符。
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  for (const name of ['a%b', 'axb', 'a_c', 'abc']) store.set(name, 1)
  expect([store.keys('a%').sort(), store.keys('a_').sort()]).toEqual([['a%b'], ['a_c']])
  // 前缀 'a%' 只匹配字面含 % 的键。
  const said = (id: string, text: string) => ({ id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'u' },
    human: true, at: '2026-10-01T00:00:00.000Z', text, meta: {} })
  for (const [id, text] of [['p', 'grew 50% today'], ['q', 'grew 500 today'], ['r', 'see a_b'], ['s', 'see axb']]) store.triggers.save(said(id!, text!))
  expect([store.read.search('50%').map(item => item.id), store.read.search('a_b').map(item => item.id)]).toEqual([['p'], ['r']])
  // 搜索词同样按字面：'50%' 不命中 '500'，'a_b' 不命中 'axb'。
  store.close()
})
