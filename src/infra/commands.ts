/** Subprocess wrapper for running gh, lark-cli, and git commands under the deployment's configured accounts. */
// 子进程包装：以部署配置的账号运行 gh、lark-cli 与 git 命令。
import { execFile } from 'node:child_process'
// execFile：以参数数组方式执行外部命令。
import { basename } from 'node:path'
// basename：取命令名用于错误消息。
import { promisify } from 'node:util'
// promisify：把回调风格 API 转为 Promise。
import { z } from 'zod'
// zod：校验 CLI JSON 输出。
import type { Deployment } from '../deployment.ts'
// Deployment：部署信息（含 CLI 路径与仓库名）。

const exec = promisify(execFile)
// Promise 化的 execFile。
const TIMEOUT_MS = 90_000
// 单条命令的超时时间（90 秒）。
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  // CLI 调用失败抛出的错误：携带 stderr 诊断、API 错误码与退出码，且不回显命令参数。
  // 来源渠道与轮询器据 code 区分“会话已删除”与“可重试失败”。
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
  // code：API/业务错误码；exitCode：进程退出码。
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  // 从失败的子进程提取脱敏错误：不回显 argv（其中可能含消息文本）。
  if (error instanceof Error && error.name === 'AbortError') return error
  // 中止错误原样返回。
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  // 提取进程退出码。
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    // 有 stderr 输出时优先解析。
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    // 从第一个 `{` 开始尝试按 JSON 解析 CLI 错误。
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    // 非 JSON 诊断保留在下方处理。
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // JSON 错误结构：取 message 与 code。
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode)
    // 纯文本 stderr：截取前 2000 字符，并尝试提取 HTTP 状态码（ETag 轮询依赖 304）。
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
  // 兜底：只描述程序名与结束方式。
}
function ended(error: unknown): string {
  // 把子进程结束方式转为人读描述。
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // 输出超过缓冲上限。
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  // execFile 超时以 SIGTERM 结束进程并置 killed。
  if (signal) return `was stopped by ${signal}`
  // 被信号终止。
  if (typeof code === 'number') return `exited with code ${code}`
  // 以退出码结束。
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
  // 无法启动（含错误码字符串）或一般失败。
}
export interface Tally { skipped: number }
// Tally：分页拉取时被跳过项的计数。
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  // 用模式逐项校验数组元素，跳过非法项并累计跳过数。
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  // 记录被跳过的数量。
  return items
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error: unknown): unknown {
  // 把飞书 232011（机器人不在群里）改写为带修复指引的错误。
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
  // 保留错误码，替换消息为修复指引。
}
/**
 * Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  // 命令执行器：带部署凭据、超时与中止信号地执行 gh/lark-cli/git；GitHub API 调用被限制在配置的仓库内。
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  // resolved：延迟取部署信息（初始化未完成时抛错）；environment：每条命令的环境覆盖；signal：全局中止信号。
  get deployment(): Deployment { return this.resolved() }
  // 当前部署信息。
  get repository(): string { return this.deployment.repository }
  // 配置的仓库名。
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this }
  // 派生一个叠加了额外中止信号的执行器（未提供时原样返回）。
  async run(program: string, args: string[], cwd?: string): Promise<string> {
    // 执行任意命令并返回 stdout。
    try {
      const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...this.environment, GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
      // 关闭 gh 提示与 lark-cli 通知，避免输出被污染；缓冲上限 16MB。
      return stdout
    } catch (error) { throw commandError(error, program) }
    // 失败转脱敏错误。
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> { return JSON.parse(await this.run(this.deployment.github.cli, args)) as T }
  // 运行代理的 GitHub CLI 并解析 JSON；一般应优先用 api（限制仓库并校验输出）。
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    // 调用配置仓库内的 GitHub API；提供模式时校验 JSON 输出，否则返回原始输出。
    if (typeof schema === 'string') return this.run(this.deployment.github.cli, ['api', this.path(schema), ...rest])
    // 重载一：不校验，返回原始文本（如原始文件、--include 头）。
    const [path = '', ...flags] = rest
    // 重载二：拆出路径与附加参数。
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
    // 校验并返回解析后的数据。
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    // 拉取配置仓库内某列表 API 的全部分页，跳过校验失败的项。
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    // --paginate + --slurp 让 gh 输出“页数组的数组”。
    return validItems(item, pages.flat(), tally)
    // 摊平后逐项校验。
  }
  private path(path: string): string {
    // 把相对路径限定到配置的仓库，并阻止越界访问。
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    // 拒绝绝对路径、带协议前缀、以及含 `..`/`.` 路径段的写法。
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
    // 拼上 repos/<owner>/<name> 前缀。
  }
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    // 以 bot 身份运行飞书 lark-cli，返回 JSON 的 data 载荷。
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    // 未配置可用的飞书 CLI。
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    // 统一追加 --as bot 与 json 输出格式；错误经 232011 改写。
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
    // 业务失败：以飞书错误码抛 CliError（232011 会被改写）。
    return result.data
    // 成功返回 data。
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
  // 在代理隔离的 git 环境与凭据助手下运行 git。
}
