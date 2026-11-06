/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
// 探测仓库与账号 CLI，配置 worker 执行环境与命令 shim（command shim），并跟踪 setup 就绪状态。
import type { Context } from '@deepseek-ai/cordis'
// UserError：用户错误
import { UserError } from '../core/index.ts'
// SETUP_FIELDS：setup 相关的设置字段清单；resolveDeployment/resolveFeishuBot：解析 GitHub 部署与飞书机器人；workerProbe：按 worker 方式探测 CLI
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
// 环境工具：agentVariables 生成隔离环境变量、applyEnvironment 应用并返回恢复函数、verifyEnvironment 校验、
// withoutDirectory 从 PATH 去掉某目录、workerBin worker shim 目录、writeEnvironment 写入环境文件
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
// SetupError 与 SetupProblem：setup 错误与问题描述
import { SetupError, type SetupProblem } from '../setup.ts'

// SetupHost：Setup 所需的宿主依赖
export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  // 生命周期取消信号
  readonly lifetime: AbortSignal
  // 触发进程内重启
  restart(): void
}

// setupFields：把"setup 相关字段"序列化（缺失以空串占位），用于判断这些字段是否变化
const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
// setupChanged：两个设置版本的 setup 相关字段是否不同
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
// 通过探测 CLI 解析目标仓库、GitHub 账号与可选飞书机器人，然后写入并应用 worker 进程使用的隔离 git 与 shim 环境。
// Runtime 在启动时运行它以把守编排就绪；Settings 用它校验账号变更、更新被禁命令 shim 并安排重启。
export class Setup {
  // 已解析的部署（undefined 表示 setup 尚未完成）
  private resolved?: Deployment
  // setup 问题（非飞书部分）
  problem?: SetupProblem
  // 飞书专属问题
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  // 去掉 worker shim 目录后的 PATH：宿主自己的 CLI 调用走真实二进制
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  // 让 agent 子进程指向隔离 git 配置与命令 shim 的环境变量
  private readonly variables: Record<string, string | undefined>
  // 当前已应用环境的恢复函数
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    // 计算去掉 shim 目录的 PATH
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    // 生成指向隔离 git/shim 的环境变量
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  // 宿主命令环境：附加 agent git 变量、PATH 排除 worker shim 目录
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  // 部署信息：setup 未完成时抛错（附原因）
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  // setup 是否已完成
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  // 解析部署账号并应用 worker 环境；SetupError 记入 problem 并返回 false（未就绪），其他错误原样上抛
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      // 非 SetupError 属于意外错误，直接上抛
      if (!(error instanceof SetupError)) throw error
      // 记录问题并报告"未就绪"
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  // 触发重启以重新 setup；若 setup 与飞书均已健康则拒绝（避免打断运行中的派工）
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  // 把重启推迟到下一个宏任务：让当前 HTTP/工具调用方先拿到响应
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  // 保存前校验被修改源块的账号 CLI；属于其他块的 setup 错误忽略
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    // 按块选择探测目标：飞书源查飞书机器人，其余（GitHub）查部署
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
      : resolveDeployment(machine, settings.sources.github?.config, this.probe())
    // 出错时：只抛与本块相关的 SetupError（错误 place 与块名匹配），其他块的问题忽略
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  // 更新被禁命令 shim（setup 完成且有部署信息时才可写）
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  // 恢复（撤销）已应用的环境修改（停机时用）
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  // 以 worker shell 的方式探测 CLI；用 stateDir 作为 cwd——即使仓库克隆尚不可用它也存在
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  // resolve：完整解析部署（GitHub + 可选飞书），并写入/应用/校验隔离环境
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    // 构造探测器
    const probe = this.probe()
    // 解析 GitHub 部署（失败即整体失败）
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe)
    // 解析飞书机器人：失败只记录 feishuProblem 并继续（飞书是可选的）
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    // 合并部署信息（含可选飞书）
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    // machineProblem：把非 SetupError 的环境错误统一包装为 SetupError
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    // 写入隔离环境（git 配置与命令 shim）
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    // 把环境变量应用到当前进程（记下恢复函数）
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    // 校验环境真实可用；失败则先恢复环境再报错
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    // 返回解析结果
    return resolved
  }
}
