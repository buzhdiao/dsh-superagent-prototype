/**
 * 本测试文件覆盖 src/infra/commands.ts 的 Commands（CLI 执行器）与 commandError（错误归一）：
 * 账号隔离（代理 CLI、环境变量覆盖）、GitHub/飞书回复投递与错误分流（作废 vs 重试）、
 * 仓库路径限制、分页读取、错误消息脱敏、以及 Abort 信号对子进程的控制。
 * 测试策略：spy 掉 run/gh/pages 模拟 CLI 输出，少数用例真实执行 sh/git 验证信号行为。
 */
import { describe, expect, it, vi } from 'vitest'
// vitest 测试原语与 spy。
import { z } from 'zod'
// zod：为 api/pages 声明响应 schema。
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
// 被测模块：Commands 命令执行器、commandError 错误归一、CliError 类型。
import { feishuKind } from '../src/sources/feishu.ts'
// 飞书 Source kind（取其 channel/link 实现）。
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
// feishuChannel：构造飞书频道引用。
import { githubKind } from '../src/sources/github.ts'
// GitHub Source kind。
import { githubChannel } from '../src/sources/github-trigger.ts'
// githubChannel：构造 GitHub 频道引用（issue 号与可选的 review 讨论）。
import { SourceRegistry } from '../src/sources/registry.ts'
// SourceRegistry：经注册表发送回复（sources.send）。
import { SettingsSchema } from '../src/policy.ts'
// SettingsSchema：空设置的默认解析。
import { key, type OutboundMessage } from '../src/core/index.ts'
// key：类型化 KV 键（断言 link 的 triggerId）；OutboundMessage：外发消息。
import { testDeployment } from './fixtures/deployment.ts'
// testDeployment：测试部署信息 fixture。
const sources = new SourceRegistry(() => SettingsSchema.parse({}))
// 默认设置下的注册表。
sources.register(feishuKind); sources.register(githubKind)
// 注册两类真实 kind。
const send = (commands: Commands, message: OutboundMessage) => sources.send(message, commands)
// 经注册表投递一条回复。
const deployment = testDeployment({ github: { ...testDeployment().github, cli: '/path/agent-gh' } })
// 部署里 GitHub 代理 CLI 指向 /path/agent-gh。
const REPOSITORY = deployment.repository
// 部署限定的唯一仓库。
const reply = { id: 'stable-operation', channel: githubChannel(8), text: 'Done', kind: 'reply' as const }
// 基准回复：GitHub issue #8，稳定操作标记 stable-operation。
describe('account-isolated operations', () => {
  // 账号隔离：全部以 agent 账号执行。
  it('uses the agent account\'s GitHub CLI and preserves literal shell metacharacters in argv', async () => {
    // gh 命令走部署指定的代理 CLI，argv 原样传递（不经过 shell，元字符不被解释）。
    const commands = new Commands(() => deployment, {}, new AbortController().signal); const run = vi.spyOn(commands,'run').mockResolvedValue('{}')
    // spy run，避免真实调用 CLI。
    await commands.gh(['api','some-path','-f','body=`whoami` $(touch x)'])
    expect(run).toHaveBeenCalledWith('/path/agent-gh', ['api','some-path','-f','body=`whoami` $(touch x)'])
    // 反引号与 $() 原样进 argv：既不执行也不转义。
  })
  it('runs every command with its environment over the process environment, where undefined removes a variable', async () => {
    // 每条命令的环境 = 进程环境 + 覆盖项；覆盖值为 undefined 表示删除该变量。
    process.env.GH_TOKEN = 'personal'
    // 预置操作者的个人 token。
    try {
      const output = await new Commands(() => deployment, { GH_TOKEN: undefined, DSH_SUPERAGENT_PROBE: 'agent' }, new AbortController().signal).run('env', [])
      // 覆盖：删 GH_TOKEN、加 DSH_SUPERAGENT_PROBE，然后执行 env 查看环境。
      expect(output).toContain('DSH_SUPERAGENT_PROBE=agent')
      expect(output).not.toContain('GH_TOKEN=')
      // 个人 token 不进子进程环境，注入变量生效。
    } finally { delete process.env.GH_TOKEN }
    // 清理进程环境，不影响其它用例。
  })
  it('refuses Feishu commands when the deployment has no Feishu bot', async () => {
    // 无飞书部署时 lark 命令直接拒绝。
    await expect(new Commands(() => testDeployment({ feishu: undefined }), {}, new AbortController().signal).lark(['im', '+chat-list'])).rejects.toThrow('The Feishu Source has no working bot CLI')
  })
  it('reconciles an uncertain GitHub send with its stable marker', async () => {
    // 幂等对账：回复里带稳定标记，发送前先查已有评论，命中则不再发送。
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    vi.spyOn(commands,'pages').mockResolvedValue([{ body:'<!-- dsh-superagent:stable-operation -->',user:{login:'agent-bot'} }])
    // 已有评论正文含本回复的稳定标记。
    const gh = vi.spyOn(commands,'gh')
    await send(commands, reply); expect(gh).not.toHaveBeenCalled()
    // 对账命中：不再发 POST。
  })
  it('posts the reply as the model wrote it, only to the fixed repository', async () => {
    // 回复正文按模型所写原样发布（披露行由模型写），且只发往部署限定的仓库。
    const commands = new Commands(() => deployment, {}, new AbortController().signal); vi.spyOn(commands,'pages').mockResolvedValue([])
    // 对账查询返回空：没有已有评论。
    const gh = vi.spyOn(commands,'gh').mockResolvedValue({})
    await send(commands, reply)
    // The disclosure line is prompt text: the model writes it, and the host adds nothing.
    // 披露行属于提示词约定，由模型写出；宿主不追加任何内容。
    expect(gh).toHaveBeenCalledWith(['api',`repos/${REPOSITORY}/issues/8/comments`,'--method','POST','-f',expect.stringMatching(/^body=Done\n\n<!-- dsh-superagent:stable-operation -->$/)])
    // POST 到限定仓库的 issue #8，正文以稳定标记结尾。
    await expect(new Commands(() => deployment, {}, new AbortController().signal).pages(z.unknown(),
      '../../someone/else/issues')).rejects.toThrow()
    // 越出限定仓库的路径被拒绝。
  })
  it('routes review-comment replies to the root review comment', async () => {
    // 对 review 讨论的回复：POST 到根评论的 replies 端点，而非 issue 评论端点。
    const commands = new Commands(() => deployment, {}, new AbortController().signal); vi.spyOn(commands,'pages').mockResolvedValue([])
    const gh = vi.spyOn(commands,'gh').mockResolvedValueOnce({ id: 7, in_reply_to_id: 3 }).mockResolvedValueOnce({})
    // 第一次响应带 in_reply_to_id=3（该评论本身是回复，根是 3）。
    await send(commands, { ...reply, channel: githubChannel(8, `https://github.com/${REPOSITORY}/pull/8#discussion_r7`) })
    expect(gh.mock.calls[1]![0]).toEqual(['api', `repos/${REPOSITORY}/pulls/8/comments/3/replies`, '--method', 'POST', '-f', expect.stringContaining('Done')])
    // 回复落在根评论 3 之下。
  })
  it('uses Feishu bot identity and one idempotency key on retries', async () => {
    // 飞书回复以 bot 身份发送，幂等键取消息 id（重试也用同一个键）。
    const commands = new Commands(() => deployment, {}, new AbortController().signal); const run = vi.spyOn(commands,'run').mockResolvedValue('{"ok":true,"data":{}}')
    await send(commands, { ...reply, channel: feishuChannel('oc_1', 'om_1') })
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--as','bot','--idempotency-key','stable-operation','--message-id','om_1']))
    // --as bot + 幂等键 + 目标消息 id 都正确。
  })
})

it('reports Feishu failures with their code and without command arguments', () => {
  // 飞书错误归一：提取 error.code/message，且不把命令参数带进消息。
  const membership = commandError({stderr:'[page 1] fetching...\n'+JSON.stringify({error:{code:232011,message:'operator is not in the chat'}})})
  // stderr 混有进度行，仍要解析出 JSON 错误体。
  expect(membership).toMatchObject({ message: 'operator is not in the chat (232011)', code: 232011 })
  expect(commandError({stderr:JSON.stringify({error:{code:999,message:'scope missing'}})}).message).toBe('scope missing (999)')
  // 消息格式统一为 "<message> (<code>)"。
})
describe('Channels', () => {
  // 频道投递的错误分流：哪些失败作废（'gone'），哪些保留重试。
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
  const feishu = { ...reply, channel: feishuChannel('oc_1', 'om_1') }
  const lark = (code: number, message: string) => commandError({ stderr: JSON.stringify({ error: { code, message } }), code: 1 })
  // 构造带指定 code/message 的飞书命令错误。
  it('drop a Feishu reply to a recalled message or one Feishu no longer finds, and say how to add the bot to a chat', async () => {
    // 消息被撤回/找不到 → 作废；机器人不在群 → 报加群指引；限流 → 原样报错等待重试。
    const value = commands()
    const run = vi.spyOn(value, 'run')
    for (const [code, message] of [[230011, 'The message is recalled'], [230001, 'message not found'], [231003,
      'The message is withdrawn']] as const) {
      run.mockRejectedValueOnce(lark(code, message))
      expect(await send(value, feishu)).toBe('gone')
      // 三种“消息不存在”类错误都作废。
    }
    run.mockRejectedValueOnce(lark(232011, 'operator is not in the chat'))
    const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
    await expect(send(value, feishu)).rejects.toThrow(hint)
    // 非成员错误抛出可操作的加群指引。
    run.mockRejectedValueOnce(lark(99991400, 'rate limited'))
    await expect(send(value, feishu)).rejects.toThrow('rate limited (99991400)')
    // 其它错误原样上抛，保留重试。
  })
  it('keep a Feishu reply whose command timed out for a retry, whatever its text says', async () => {
    // 超时按超时处理（保留重试），即使错误文案里出现“withdrawn”等误导词。
    const value = commands()
    const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '', message: 'Command failed: lark-bot --markdown withdrawn' }
    vi.spyOn(value, 'run').mockRejectedValueOnce(commandError(timedOut, 'lark-bot'))
    await expect(send(value, { ...feishu, text: 'The change was withdrawn' })).rejects.toThrow('lark-bot timed out after 90 s')
    // 识别为超时错误而非内容类错误。
  })
  it('drop a GitHub reply to an Issue that is deleted or locked, and keep others for a retry', async () => {
    // issue 删除/锁定 → 作废；404/500 等其它错误 → 保留重试。
    const value = commands()
    vi.spyOn(value, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(value, 'gh')
    for (const stderr of ['gh: This issue was deleted (HTTP 410)', 'gh: Unable to create comment because issue is locked. (HTTP 403)']) {
      gh.mockRejectedValueOnce(commandError({ stderr, code: 1 }))
      expect(await send(value, reply)).toBe('gone')
    }
    // GitHub also answers 404 for a private repository the agent lost access to, so 404 is retried rather than dropped.
    // 私有仓库失去访问时 GitHub 也回 404，因此 404 归为重试而非作废。
    for (const stderr of ['gh: Not Found (HTTP 404)', 'gh: Server Error (HTTP 500)']) {
      gh.mockRejectedValueOnce(commandError({ stderr, code: 1 }))
      await expect(send(value, reply)).rejects.toThrow(stderr)
    }
  })
  it('reply on the PR\'s conversation when the review comment a reply points at is gone', async () => {
    // review 根评论已删除（404）时，回退到 PR 会话页发 issue 评论。
    const value = commands()
    const pages = vi.spyOn(value, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(value, 'gh')
      .mockRejectedValueOnce(commandError({ stderr: 'gh: Not Found (HTTP 404)', code: 1 })).mockResolvedValueOnce({})
    // 第一次（POST replies）404，第二次成功。
    expect(await send(value, { ...reply, channel: githubChannel(8, `https://github.com/${REPOSITORY}/pull/8#discussion_r7`) })).toBe('sent')
    expect((pages.mock.calls[0] as unknown[])[1]).toBe('issues/8/comments')
    // 先查了该评论是否已存在（对账用）。
    const post = ['api', `repos/${REPOSITORY}/issues/8/comments`, '--method', 'POST', '-f', expect.stringContaining('Done')]
    expect(gh.mock.calls[1]![0]).toEqual(post)
    // 回退 POST 打到 issue #8 的评论端点。
  })
  it('link each address to its page with its label', () => {
    // link：把频道地址变成带标签的落地页链接；缺上下文时退化为空链接。
    const links = { repository: REPOSITORY, feishu: deployment.feishu! }
    expect(githubKind.channel!.link(githubChannel(8).address, links)).toEqual({ url: `https://github.com/${REPOSITORY}/issues/8`,
      label: { zh: 'GitHub #8', en: 'GitHub #8' } })
    const review = `https://github.com/${REPOSITORY}/pull/8#discussion_r7`
    expect(githubKind.channel!.link(githubChannel(8, review).address, links))
      .toEqual({ url: review, label: { zh: 'GitHub #8 的 review 讨论', en: 'Review discussion on GitHub #8' } })
    // review 讨论链接直指 discussion 锚点，标签区分中英文。
    expect(githubKind.channel!.link(githubChannel(8).address, {}).url).toBe('')
    // 缺少仓库上下文：无落地页，返回空 URL。
    const message = feishuChannel('oc_1', 'om_1').address
    expect(feishuKind.channel!.link(message, links)).toEqual({ url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1',
      label: { zh: '飞书消息', en: 'Feishu message' }, triggerId: key('feishu', 'om_1') })
    // 飞书链接跳到会话，并附带可定位触发记录的 triggerId。
  })
})

describe('GitHub calls', () => {
  // gh api 封装：路径限制、响应校验、分页。
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
  it('go only to paths inside the configured repository, and validate what GitHub answers', async () => {
    // api() 只允许限定仓库内的路径，响应按 schema 校验，并通过原始 stdout 透传。
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('{"number":12,"title":"Login fails","extra":true}')
    expect(await value.api(z.looseObject({ number: z.number() }), 'issues/12')).toEqual({ number: 12, title: 'Login fails', extra: true })
    // looseObject：保留额外字段。
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}/issues/12`])
    // 路径被补全为 repos/<限定仓库>/ 前缀。
    await expect(value.api(z.looseObject({ number: z.string() }), 'issues/12')).rejects.toThrow()
    // 响应不符合 schema（number 应为字符串）则拒绝。
    for (const path of ['../other/repo/issues', 'issues/../../x', '/repos/x/y', 'https://api.github.com/x']) {
      await expect(value.api(z.unknown(), path)).rejects.toThrow('restricted to the configured repository')
      // 各种越界写法（相对跳转、绝对路径、完整 URL）都被拒。
    }
    expect(run).toHaveBeenCalledTimes(2)
    // 被拒的路径没有真正执行 CLI（只有前两次成功调用）。
    // An empty path targets the repository root.
    // 空路径指向仓库根。
    await value.api(z.unknown(), '')
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}`])
    // Without a schema, api() returns the raw CLI stdout.
    // 不传 schema 时返回原始 stdout（如下载 raw 文件）。
    run.mockResolvedValue('raw file')
    expect(await value.api('contents/README.md', '-H', 'Accept: application/vnd.github.raw')).toBe('raw file')
  })
  it('read every page of a list, and skip and count an item that does not validate', async () => {
    // pages()：--paginate --slurp 拉全部分页；校验失败的条目跳过并计数；非列表响应报错。
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('[[{"id":1}],[{"id":2}]]')
    // 两页数据被 --slurp 合并成二维数组。
    expect(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments?per_page=100')).toEqual([{ id: 1 }, { id: 2 }])
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}/issues/12/comments?per_page=100`, '--paginate',
      '--slurp'])
    run.mockResolvedValue('[[{"id":1}],[{"id":"two"}]]')
    const tally = { skipped: 0 }
    expect(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments', tally)).toEqual([{ id: 1 }])
    // 第二页的坏条目被跳过。
    expect(tally).toEqual({ skipped: 1 })
    // 跳过计数进 tally（用于健康上报）。
    run.mockResolvedValue('{"message":"not a list"}')
    await expect(value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments')).rejects.toThrow()
    // 响应不是列表则整体失败。
  })
})
it('says how to add the bot to a chat when Feishu answers that it is not a member, and keeps the code', async () => {
  // lark() 对 232011（非成员）附加加群指引，且两种响应形态（stderr JSON / ok:false）都覆盖。
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const membership = JSON.stringify({ error: { code: 232011, message: 'operator is not in the chat' } })
  const run = vi.spyOn(commands, 'run').mockRejectedValueOnce(commandError({ stderr: membership, code: 1 }))
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011, exitCode: 1 })
  // stderr JSON 形态：指引 + 保留 code 与退出码。
  run.mockResolvedValueOnce(JSON.stringify({ ok: false, error: { code: 232011, message: 'operator is not in the chat' } }))
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011 })
  // ok:false 的业务错误形态同样识别。
})
it('names only the program and how it ended when a command prints no diagnostics, never its arguments', async () => {
  // 无诊断输出时错误消息只提程序名与结束方式，绝不回显参数（参数可能含回复正文等敏感内容）。
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const secret = 'secret reply text'
  await expect(commands.run('sh', ['-c', 'exit 3', secret])).rejects.toMatchObject({ message: 'sh exited with code 3', exitCode: 3 })
  await expect(commands.run('sh', ['-c', 'kill -9 $$', secret])).rejects.toMatchObject({ message: 'sh was stopped by SIGKILL' })
  await expect(commands.run('/no/such/program', ['secret reply text'])).rejects.toMatchObject({ message: 'program could not run: ENOENT' })
  // 三种结束方式：退出码 / 信号 / 无法启动，消息里都没有 secret。
  // Timeouts kill the child with SIGTERM; Node's default error message would echo every argument.
  // 超时会以 SIGTERM 杀掉子进程；Node 默认错误消息会回显全部参数，必须改写。
  const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '',
    message: 'Command failed: /path/lark-bot im +messages-reply --markdown withdrawn' }
  expect(commandError(timedOut, '/path/lark-bot')).toMatchObject({ message: 'lark-bot timed out after 90 s' })
  expect(String(commandError(timedOut, '/path/lark-bot'))).not.toContain('withdrawn')
  // 归一后的超时消息既不含参数也不含原始 message。
})
it('reports failures as CliError with the code the CLI names and the exit status', async () => {
  // 错误归一总纲：CliError 携带 CLI 报出的业务码与退出状态；AbortError 原样保留以区分“取消”。
  const notFound = commandError({ stderr: 'gh: Not Found (HTTP 404)\n', code: 1 })
  expect(notFound).toBeInstanceOf(CliError)
  expect(notFound).toMatchObject({ message: 'gh: Not Found (HTTP 404)', code: 404, exitCode: 1 })
  // 从 gh 的 stderr 抽出 HTTP 状态码。
  expect(commandError({ stderr: JSON.stringify({ error: { code: 230011, message: 'The message is recalled' } }),
    code: 1 })).toMatchObject({ message: 'The message is recalled (230011)', code: 230011 })
  // 飞书 JSON 错误体同样归一。
  // A cancelled command stays an AbortError so callers can distinguish cancellation from failure.
  // 被取消的命令保持 AbortError，让调用方能区分“取消”与“失败”。
  const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', stderr: '' })
  expect(commandError(aborted)).toBe(aborted)
  const controller = new AbortController()
  const running = new Commands(() => deployment, {}, controller.signal).run('sleep', ['5'])
  controller.abort()
  await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  // 真实子进程：abort 后命令以 AbortError 拒绝。
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  vi.spyOn(commands, 'run').mockResolvedValue(JSON.stringify({ ok: false, error: { code: 231003, message: 'message not found' } }))
  await expect(commands.lark(['im', '+messages-reply'])).rejects.toMatchObject({ message: 'message not found (231003)', code: 231003 })
  // lark 对 ok:false 的响应体同样抛出归一错误。
})

it('stops a running command when the signal of its work aborts, or the lifetime, and leaves the other work running', async () => {
  // 信号分层：工作信号中止只停该工作的命令；lifetime 中止停所有命令；两者都不误伤无关命令。
  const lifetime = new AbortController(), work = new AbortController()
  const commands = new Commands(() => deployment, {}, lifetime.signal)
  const started = Date.now()
  const running = commands.withSignal(work.signal).run('sleep', ['5'])
  work.abort()
  await expect(running).rejects.toThrow()
  // Only commands bound to the aborted work signal stop.
  // 只有绑定到被中止工作信号的命令会停。
  expect(await commands.run('echo', ['still'])).toBe('still\n')
  const other = commands.withSignal(new AbortController().signal).run('sleep', ['5'])
  lifetime.abort()
  await expect(other).rejects.toThrow()
  // lifetime 中止：即使绑定了别的（未中止的）信号也会停。
  expect(Date.now() - started).toBeLessThan(4000)
  // 全程远小于 5s：说明 sleep 被提前杀掉而非等其自然结束。
})
