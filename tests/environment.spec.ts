import { execFile, spawn } from 'node:child_process'
// 真实子进程：用于实际执行 shim 与 git。
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
// 文件系统同步操作：搭建临时环境、伪造可执行程序。
import { tmpdir } from 'node:os'
// 系统临时目录。
import { join } from 'node:path'
// 路径拼接。
import { promisify } from 'node:util'
// 把回调式 execFile 转成 Promise。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// vitest 测试原语与环境 stub。
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
// SENSITIVE_ENV_PATTERN：DSH 判定“形似凭据”的变量名模式，用于模拟其对子进程环境的剥离。
import { GIT_LOCATION, agentVariables, credentialHelper, runAsWorker, verifyDirectory, withoutDirectory, workerBin, workerGitConfig, writeEnvironment }
  from '../src/infra/environment.ts'
// 被测模块：环境与 CLI shim（GIT_LOCATION 为 git 定位变量全集）。
import { CliError } from '../src/infra/commands.ts'
// CliError：带退出码与 stderr 的 CLI 错误。
import { testDeployment } from './fixtures/deployment.ts'
// testDeployment：测试部署信息 fixture。
import { gitEnv } from './fixtures/git.ts'
// gitEnv：隔离的 git 环境变量 fixture，避免测试受操作者 git 配置影响。

// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
// 套件并行运行时 git/shell 子进程可能超过默认 5s 超时，放宽到 30s。
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
// Promise 化的子进程执行器。
let dir: string
// 每个用例独享的临时目录。
const program = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
// 伪造一个 sh 脚本可执行程序，返回其路径。
/** Worker shell environment after DSH strips credential-shaped variables. */
// DSH 剥离形似凭据变量后的 worker shell 环境（模拟运行时行为）。
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
// 每个用例前建临时目录，并预置一个真实工具目录 real/。
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
// 用例后清理临时目录。

describe('worker shims', () => {
  // worker shim（gh/lark-cli 代理与被禁命令拦截）的行为。
  it('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    // shim 内部再调 `gh` 时必须命中真实工具而非 shim 自身，且保留调用方 PATH 的其余条目。
    program(join(dir, 'real', 'gh'), 'echo "{\\"login\\":\\"agent-bot\\",\\"config\\":\\"$GH_CONFIG_DIR\\",\\"path\\":\\"$PATH\\"}"')
    // real/gh 输出自己的 login、GH_CONFIG_DIR 与看到的 PATH。
    const wrapper = program(join(dir, 'gh-agent'), `GH_CONFIG_DIR=${dir}/agent-config exec gh "$@"`)
    // 代理 CLI：设置 GH_CONFIG_DIR 后按名字 exec gh。
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: wrapper }, feishu: undefined }), [])
    // 生成 shim 环境（无飞书、github 用 wrapper），不屏蔽任何命令。
    const bin = workerBin(dir)
    const path = [bin, join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':')
    // PATH：shim 目录在最前，real 目录在后。
    const { stdout } = await exec('gh', ['api', 'user'], { env: { PATH: path }, timeout: 10_000 })
    // 调 shim 的 gh。
    expect(JSON.parse(stdout)).toEqual({ login: 'agent-bot', config: `${dir}/agent-config`, path: [join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin'].join(':') })
    // 断言：wrapper 生效（config 被设置）、exec gh 命中 real/gh，且 shim 目录已从子进程 PATH 中移除。
  })
  it('make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent\'s login', async () => {
    // 无飞书部署时 lark-cli 报不可用；被屏蔽命令报“以 agent-bot 身份使用 gh”。
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    // 屏蔽清单里有 personal-gh。
    const bin = workerBin(dir)
    await expect(exec(join(bin, 'lark-cli'), ['im', '+chat-list'])).rejects.toMatchObject({ code: 1, stderr: 'lark-cli is unavailable: this installation has no Feishu bot.\n' })
    // 无飞书 bot：lark-cli 以退出码 1 与固定文案失败。
    await expect(exec(join(bin, 'personal-gh'), [])).rejects.toMatchObject({ code: 1, stderr: 'personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n' })
    // personal-gh 被拦截并提示改用 gh。
  })
  it('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    // 屏蔽清单即便包含 worker 必需命令，shim 仍要保证 gh/lark-cli 可用，且不给 git 做 shim。
    const gh = program(join(dir, 'gh-agent'), 'echo gh "$@"'), lark = program(join(dir, 'lark-bot'), 'echo lark "$@"')
    // 两个回显参数的假代理 CLI。
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github, cli: gh }, feishu: { ...base.feishu!, cli: lark } }), ['gh', 'git', 'lark-cli'])
    // 屏蔽清单同时写上 gh、git、lark-cli。
    const bin = workerBin(dir)
    expect([(await exec(join(bin, 'gh'), ['api', 'user'])).stdout, (await exec(join(bin, 'lark-cli'), ['im'])).stdout]).toEqual(['gh api user\n', 'lark im\n'])
    // WORKER_COMMANDS（gh/git/lark-cli）不受 blockedCommands 拦截：两个 shim 都把参数透传给代理 CLI。
    expect(readdirSync(bin)).not.toContain('git')
    // git 不生成 shim（有独立隔离配置方案）。
  })
  it('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    // writeEnvironment 只覆盖自己写的文件；占位上出现外来文件/链接/gitconfig 一律拒绝且原样保留。
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    // 先正常生成一次 shim（产生被屏蔽的 old-cli）。
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    // 再以空屏蔽清单重写：只剩 gh 与 lark-cli。
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    // A file that merely contains the marker on a later line, a symlink to a shim, and a foreign gitconfig are all rejected.
    // 首行不含标记的文件、指向 shim 的符号链接、外来 gitconfig 都会被拒绝。
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${readFileSync(join(workerBin(dir), 'gh'), 'utf8').split('\n')[1]}\n`)
    // notes 文件把 shim 的标记行抄在第二行（首行不是标记）。
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    // 标记必须在首行才被认作本程序所写。
    rmSync(join(workerBin(dir), 'notes'))
    symlinkSync(join(workerBin(dir), 'gh'), join(workerBin(dir), 'link'))
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
    // 符号链接不算本程序写入的文件。
    rmSync(join(workerBin(dir), 'link'))
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    // 外来 gitconfig 同样拒绝。
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
    // 拒绝时不破坏外来文件内容。
  })
  it('replaces the files it wrote under the project\'s earlier names', async () => {
    // 旧项目名（dsh-tag/dsh-go/dsh-freelancer）写入的文件也视作可替换。
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    // 把文件标记改成旧项目名。
    legacy(join(workerBin(dir), 'old-cli'), 'dsh-tag'); legacy(join(workerBin(dir), 'older-cli'), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'lark-cli'])
    // 旧标记的 shim 文件被正常替换。
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
    // 旧标记的 gitconfig 也被重写为新标记。
  })
})

describe('agent git configuration', () => {
  // worker 的隔离 git 配置：屏蔽操作者全局/系统配置与身份变量。
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    // worker 的 git 不读操作者配置（改写 URL、签名、凭据助手均不生效），凭据只走代理 CLI。
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    // 操作者配置：HTTPS 改写为 SSH、开启提交签名、设置凭据助手。
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: '/opt/agent tools/gh' } })
    // 代理 CLI 路径带空格，顺带验证凭据助手定义的引号转义。
    await writeEnvironment(deployment, [])
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    // 操作者身份变量与 git 从 OS 用户名回退的身份都不得影响 worker 提交。
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    // 组合：操作者 HOME、注入式 git 配置与身份变量，加上 agentVariables 提供的隔离配置。
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    // insteadOf 改写未生效：push URL 仍是 HTTPS。
    expect(await git('config', '--show-origin', '--get-all', 'credential.https://github.com.helper')).toBe(`file:${workerGitConfig(dir)}\t${credentialHelper('/opt/agent tools/gh')}`)
    // github 凭据助手只来自隔离 gitconfig（且路径带空格被正确加引号）。
    expect(await git('config', '--get-all', 'credential.helper')).toBe('')
    // 通用 credential.helper 没有任何值（osxkeychain 未生效）。
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    // 签名设置未生效。
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    // 注入式 GIT_CONFIG_KEY_0 也没生效。
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    // 形似凭据的身份变量被 DSH 剥离。
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    // 没有身份来源：提交因缺 email 失败。
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
    // 显式 -c 传入的身份可用，且 author 与 committer 一致。
  })
})

it('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  // 凭据助手无答案时应失败，而不是回退询问操作者的 askpass 助手。
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  // askpass 假程序：被调用会写日志并吐出操作者“密钥”。
  const agent = program(join(dir, 'real', 'gh'), 'exit 0')
  // 代理 CLI：什么都不做直接成功（即凭据助手拿不到答案）。
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: agent } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  // 环境里埋了 GIT_ASKPASS/SSH_ASKPASS，且经 DSH 剥离后应消失。
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  // 请求 github 的凭据。
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  // git 因终端提示被禁而失败，而不是拿到操作者密钥。
  expect(() => readFileSync(log, 'utf8')).toThrow()
  // askpass 从未被调用（无日志文件）。
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  // withoutDirectory：按真实路径比较，能移除同目录的各种写法（尾斜杠、符号链接）。
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  symlinkSync(join(dir, 'state'), join(dir, 'link'))
  const bin = join(dir, 'state', 'worker-bin')
  expect(withoutDirectory([`${bin}/`, join(dir, 'link', 'worker-bin'), '/usr/bin', 'node_modules/.bin'].join(':'), bin)).toBe('/usr/bin:node_modules/.bin')
  // 带尾斜杠与经符号链接的两种写法都被移除，其余条目保留（相对路径也保留）。
})

/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
// 用 child_process.spawn 实现的最小 SubprocessRuntime，配隔离的全局 git 配置。
const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }) })
    // 启动子进程：指定全局 gitconfig 并禁用系统配置。
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    // 收集两路输出。
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    // 实现 DSH 的输出读取器接口（一次性读全量）。
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    // done 在进程退出时给出退出码。
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
describe('ticket directory check', () => {
  // verifyDirectory：工单目录不得自带凭据配置的检查。
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  // 在隔离 git 环境里执行 git 命令的辅助函数。
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  // 对 dir 下指定子目录执行被测检查。
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  // 预置一个带凭据助手的全局配置（检查要求仓库不得自带凭据，全局的可以）。
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    // 无凭据配置的仓库目录、以及仓库外的目录都应通过。
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // When no config key matches at all, git config --get-regexp exits with status 1.
    // 一个键都匹配不上时 git config --get-regexp 以退出码 1 结束，检查须视作通过而非失败。
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
    // real/ 不在任何仓库里，也应通过。
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    // 仓库自带凭据设置时，报错要指名具体配置键。
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
    // extraheader 里的认证头被点名拒绝。
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    // git 读不了仓库配置（损坏的 config）必须失败，不能放行。
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
    // git 报 "bad config"，检查应把它当作错误抛出。
  })
  it('reports a failed command\'s exit status', async () => {
    // runAsWorker：命令失败时抛出的 CliError 要带上退出码与 stderr。
    const failing = ['sh', '-c', 'echo nope >&2; exit 3']
    const error = await runAsWorker(subprocess(join(dir, 'global')), failing, dir, signal).catch((e: unknown) => e)
    // 捕获失败结果。
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
    // message 取 stderr，exitCode 为 3。
  })
})

describe('the repository the host\'s environment names', () => {
  // 宿主环境里的 GIT_DIR/GIT_WORK_TREE（如 git rebase --exec 场景）不得波及测试与 worker。
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    // 用一个 scratch 仓库代表“被测仓库”，git rebase --exec 会把它写进 GIT_DIR/GIT_WORK_TREE。
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // 模拟宿主环境指向 scratch 仓库。
    // The operator's limit on git's search for a repository names none, and stays.
    // GIT_CEILING_DIRECTORIES 本身不指向任何仓库，应原样保留。
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      // 测试自己的仓库（工单目录）不受宿主 GIT_DIR 污染。
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // scratch 仓库的配置原封未动。
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      // worker 环境不得携带任何 git 定位变量。
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      // GIT_LOCATION 里的每个定位变量都被剥离。
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
      // 唯有 GIT_CEILING_DIRECTORIES 保留。
    } finally { vi.unstubAllEnvs() }
  })
})
