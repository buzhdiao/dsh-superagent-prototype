/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
// 进程环境与 CLI shim：把 git、gh、lark-cli 绑定到部署的账号，并拦截被禁止的命令。
// worker 读取的变量名避开 KEY|PASSWORD|SECRET|TOKEN，因为 DSH 会从子进程环境剥离形似凭据的变量。
// 这里提供的是默认路径上的护栏，而非操作系统级安全边界——worker 运行在操作者的 OS 用户下。
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
// 文件系统异步操作。
import { realpathSync } from 'node:fs'
// realpathSync：解析真实路径用于目录比较。
import { delimiter, join, resolve } from 'node:path'
// 路径工具。
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
// DSH 子进程运行时与输出读取器类型。
import type { Deployment } from '../deployment.ts'
// Deployment：部署信息。
import { SetupError } from '../setup.ts'
// SetupError：结构化初始化错误。
import { CliError } from './commands.ts'
// CliError：CLI 错误。

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
// 本程序写入文件的标记注释，同时用于识别“可安全覆盖”的文件。
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
// 项目旧名（dsh-tag/dsh-go/dsh-freelancer）写入的文件标记；dsh-superagent 同样拥有并替换它们。
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
// worker 必需、不允许被 blockedCommands 拦截的命令：shim 与 git。
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
// worker shim 目录路径。
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
// worker 隔离 git 配置文件路径。
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
// POSIX shell 单引号转义。
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
// gitconfig 双引号转义。
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`
// git 凭据助手定义：调用代理 CLI 的 auth git-credential。

export function sameDirectory(a: string, b: string): boolean {
  // 判断两个路径是否指向同一目录（解析真实路径后比较）。
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  // 路径不存在时退回 resolve 的规范化结果。
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  // 从 PATH 中移除与 dir 相同的条目。
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']
// 告诉 git 操作哪个仓库/工作树/索引的变量。宿主可能继承自 git 环境（如 git rebase --exec），
// 不清除会让代理的 git 误操作那个仓库。GIT_CEILING_DIRECTORIES 不指向仓库且用于限定 git 的向上搜索，故保留。

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  // 返回代理环境变量覆盖：剥离环境中的 GitHub 令牌、交互提示、宿主环境的仓库定位与操作者的 git 身份/配置覆盖。
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // 清除环境中的 GitHub 令牌，代理只能通过凭据助手取凭据。
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    // worker 的 git 一律从目录定位仓库，绝不使用宿主环境的定位变量。
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // 指向隔离的全局 git 配置并禁读系统级配置。
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // 清除环境传递的 git 配置，否则会渗入代理运行的每条 git 命令。
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // 凭据助手无答案时 git 必须失败而非提示；GIT_ASKPASS 置空同时压过 core.askPass 与 SSH_ASKPASS。
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
    // 清除操作者的提交身份变量；提交身份由提示词规定，环境变量会覆盖 worker 设置的值。
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  // 普通文件前两行含本程序（或旧名）标记时为 true；符号链接/目录等其他类型一律不算。
  if (!(await lstat(file)).isFile()) return false
  // lstat 不跟随符号链接。
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  // 取前两行。
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
  // 匹配当前或旧名标记。
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  // 覆盖写入一个本程序拥有的文件；目标存在但非本程序写入时拒绝。
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  // 文件尚不存在视为可写。
  if (foreign) throw new SetupError('foreignFile', { file })
  // 外来文件拒绝覆盖。
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
  // 先写临时文件再原子改名。
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  // 原子写入 worker CLI shim 与隔离 git 配置；拒绝覆盖外来文件。
  // 每个 shim 在 exec 前把 shim 目录从 PATH 移除，使按名字解析 gh/lark-cli 的包装脚本能到达真实二进制。
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  // 确保 shim 目录存在。
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // 目录里已有的每个文件都必须是本程序写入的，否则拒绝继续。
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    // 写单个 shim：临时文件 + 原子改名，避免并发 worker 读到半个文件。
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const withoutShims = [
    // 一段 sh 脚本：从 PATH 里剔除 shim 目录自身。
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  // exec 到目标程序（PATH 已剔除 shim 目录，避免 shim 套 shim）。
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  // 输出错误并退出 1 的 shim。
  await shim('gh', run(github.cli))
  // gh shim：转发到代理配置的 GitHub CLI。
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  // lark-cli shim：有飞书 bot 时转发，否则报错退出。
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
    // 被禁止的命令用报错 shim 占位（worker 必需命令除外）。
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  // 删除本轮未重新写入的旧 shim（清理已解除封锁或已变更的命令）。
  await own(workerGitConfig(stateDir), [
    // 覆盖写入隔离 git 配置。
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    // 要求必须显式设置身份才允许提交，而不是从操作者 OS 用户猜测。
    '[credential]', '\thelper =',
    // 清空默认凭据助手。
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    // GitHub 凭据指向代理 CLI 的凭据助手。
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // 把 SSH 形式的 GitHub 地址改写为 HTTPS，使凭据助手生效。
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
    // 内置 Git LFS 过滤器（操作者全局配置通常有，但这里被隔离忽略）。
  ].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  // 应用环境覆盖并把 worker shim 目录前插到 process.env.PATH，返回恢复回调。
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  // 记录将被覆盖的旧值。
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  // undefined 表示删除变量。
  apply(values)
  return () => { apply(previous) }
  // 调用返回的回调即可恢复原环境。
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  // 经 DSH 子进程运行时启动命令（它会剥离形似凭据的环境变量）。
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  // stdout 上限 1MB、stderr 上限 64KB，宽限期 2 秒。
  const { exitCode } = await handle.done
  // 等待进程结束。
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  // 从头读取收集到的输出。
  if (exitCode === 0) return read(handle.collected.stdout)
  // 成功返回 stdout。
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
  // 失败抛 CliError：优先 stderr 内容，否则描述结束方式。
}

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  // 校验 worker 的 git 调用能解析到部署的 GitHub 凭据助手。
  const { github, stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  // 以 NUL 分隔字段且路径不加引号，便于精确比较；读取失败按空处理。
  if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].join('\0')) throw new SetupError('gitTooOld')
  // 期望输出恰好为“来源=本配置文件 + 凭据助手 + 结尾”；不一致说明 git 过旧读不了该配置。
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  // 校验工单目录的 local/worktree git 配置没有自定义 credential.* 或 http.*extraheader 键——代理的 git 会读取仓库自身配置并执行它们。
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  // 退出码 1 表示没有匹配键，视为通过。
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  // --show-scope 输出为“作用域,键值”对；挑出 local/worktree 作用域的键名。
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
  // 存在这些键则报错并要求移除。
}
