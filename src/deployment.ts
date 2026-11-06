/** Plugin configuration and startup verification for repository access and agent CLI identities. */
// 插件配置与启动校验：仓库访问权限与代理 CLI 身份。
import { LIMITS } from './limits.ts'
// LIMITS：宿主模式与面板表单共享的取值范围。
import { accessSync, constants, statSync } from 'node:fs'
// 文件系统访问检查。
import { delimiter, isAbsolute, join } from 'node:path'
// 路径工具：PATH 分隔符、绝对路径判断、路径拼接。
import type { Volatile } from '@deepseek-ai/cordis'
// Volatile：无需重启即可生效的“易变”配置类型。
import s from '@deepseek-ai/schemastery'
// schemastery：宿主配置模式定义库。
import { z } from 'zod'
// zod：用于校验外部 CLI 输出。
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
// SubprocessRuntime：宿主的子进程服务类型。
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
// 工作进程（worker）环境工具：以 worker 身份运行、路径处理。
import { SetupError } from './setup.ts'
// SetupError：带修复位置的结构化启动错误。

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
// 从任意抛出值提取错误信息文本。
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
// 定义“必须为绝对路径”的字符串配置项模式。
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  // dsh-superagent 入口的插件配置：易变字段每次使用时读取、无需重启；改 stateDir 会重新挂载插件。
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  // 状态目录：数据库、锁、worker shim、代理 git 配置，以及默认的工单目录。
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  // 提示词配置的最大保存字符数（易变）。
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  // 单次评估可读取的线程上下文页数（易变）。
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
  // 单次评估中读取上下文的时限（毫秒，易变）。
})
export type DeploymentConfig = ReturnType<typeof Config>
// DeploymentConfig：配置对象的类型。
export interface Machine {
  // Machine：从配置解析出的机器级设置。
  stateDir: string
  // 状态目录。
  promptMaxChars: Volatile<number>
  // 提示词字符上限（易变读取）。
  admissionContextMaxPages: Volatile<number>
  // 上下文页数上限（易变读取）。
  admissionContextTimeoutMs: Volatile<number>
  // 上下文读取时限（易变读取）。
}
const MOVED: Record<string, string> = {
  // 已废弃配置键的去处说明，用于报错提示。
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  // 读取机器设置，并拒绝未知配置键（指明废弃键已迁移到哪里）。
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  // 找出配置模式中不存在的键。
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  // 存在未知键时报错并列出（废弃键附迁移去向）。
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
  // 仅返回机器级设置。
}

export const GithubAccountsSchema = z.object({
  // GitHub 账户来源配置模式。
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  // 仓库名 owner/name，允许空串（未设置）。
  cli: z.string().trim().default(''),
  // 代理使用的 GitHub CLI 命令。
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
// 飞书机器人来源配置模式：仅一个 CLI 命令。
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }
// 影响部署初始化、修改后需要重启的来源配置键。

export interface Deployment extends Machine {
  // Deployment：机器设置 + 部署校验后的运行时信息。
  repository: string
  // 校验过的规范仓库名。
  github: { cli: string; login: string; noreply: string }
  // GitHub CLI 路径、账号登录名与 noreply 邮箱。
  feishu?: FeishuBot
  // 可选的飞书机器人信息。
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
// FeishuBot：CLI 路径、应用 id、品牌、机器人 open_id 与名称。

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  // 把命令名或绝对路径解析为可执行文件；忽略 worker shim 目录。
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  // 含斜杠但不是绝对路径的写法不允许。
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  // 绝对路径直接作为候选；否则在 PATH 的各绝对目录（排除 exclude）下拼接命令名。
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    // 候选是文件且具备执行权限即返回。
    catch { /* Not an executable file here; try the next PATH directory. */ }
    // 此处不是可执行文件，尝试下一个 PATH 目录。
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
  // 全部候选都不可用时抛错。
}

export type Probe = (argv: string[]) => Promise<string>
// Probe：执行一组命令并返回输出（用于启动探测）。
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  // 通过 DSH 的 worker 子进程服务执行启动检查；从 PATH 中移除 worker shim 目录，让 `gh` 包装脚本找到真实二进制。
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  // 构造去掉 shim 目录后的 PATH。
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
  // 以 env 覆盖 PATH 的方式在 worker 中执行；合并外部信号与 60 秒超时。
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
// GitHub 用户信息模式：登录名与正整数 id。
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
// 仓库访问信息模式：规范名与 push 权限。
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  // 用模式解析 CLI 的 JSON 输出；失败返回 undefined。
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  // 非 JSON 输出返回 undefined，由调用方上报初始化失败。
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
  // 校验失败同样返回 undefined。
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  // 校验代理的 GitHub CLI 身份与对配置仓库的推送权限，产出 Deployment。
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  // 解析 GitHub 账户配置（缺省按空配置处理）。
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  // 未配置仓库名。
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  // 未配置代理 CLI。
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  // 解析代理 CLI 可执行文件（排除 shim 目录），失败转 SetupError。
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  // 查询当前 GitHub 用户，失败视为未登录。
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // 输出无法解析出账号。
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
    // 仓库不可读。
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  // 输出无法解析出仓库信息。
  const repository = access.name
  // 采用 GitHub 返回的规范仓库名，使改名后的仓库仍能匹配通知。
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  // 无推送权限。
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
  // 组装 Deployment：CLI 路径、登录名与 GitHub noreply 邮箱。
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
// 飞书 CLI 认证状态模式：应用 id、品牌与 bot 身份状态。
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
// 机器人信息模式：open_id 与应用名。
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  // 校验配置的飞书 CLI 以 bot 身份认证且被限制在严格模式 bot；未配置 CLI 时返回 undefined。
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  // 未配置 CLI 则跳过飞书来源。
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  // 统一错误转换：SetupError 原样抛出，其余包装为 feishuCliFailed。
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  // 解析 CLI 可执行文件（排除 shim 目录）。
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  // 运行 CLI 的封装：关闭升级/技能通知以免污染输出。
  const text = await run('auth', 'status')
  // 查询认证状态。
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  // 从第一个 `{` 开始解析 JSON（CLI 输出可能带前缀文字）。
  if (!status) return fail(new SetupError('feishuNoApp'))
  // 无法解析出应用信息。
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  // bot 身份未就绪。
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  // 读取严格模式设置。
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // 严格模式不是 bot 会允许 worker 以用户身份行事，必须拒绝。
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  // 查询机器人信息；该端点把载荷放在 bot 字段下，json 格式只解包 data，故用 ndjson 取首行。
  if (!info) return fail(new SetupError('feishuNoBot'))
  // 无法解析出机器人 open_id。
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
  // 组装 FeishuBot 信息。
}
