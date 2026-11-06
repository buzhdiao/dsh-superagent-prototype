/** Structured startup and configuration errors with the settings location where the operator can fix them. */
// 结构化的启动/配置错误，并标注操作者可以修复它的设置位置。
import { fill } from './infra/text.ts'
// fill：模板占位符填充工具。

export type SetupPlace = 'deployment' | 'github' | 'feishu'
// 初始化问题所在位置：部署页 / GitHub 来源 / 飞书来源。
export const SETUP_PROBLEMS = {
  // 全部初始化问题码：位置 + 英文描述模板。
  foreignFile: ['deployment', '{file} was not written by dsh-superagent; move it, or choose another state directory.'],
  // 状态目录里出现非本程序写入的文件。
  gitTooOld: ['deployment', 'git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.'],
  // git 版本过旧，读不了写入的凭据配置。
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
  // 代理环境准备失败。
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  // GitHub 来源未配置仓库。
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  // 未配置代理 GitHub CLI。
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  // 代理 GitHub CLI 不存在。
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  // 代理 CLI 读不到账号（未登录）。
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  // CLI 输出中无 GitHub 账号。
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  // 账号无权读取仓库。
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  // CLI 未返回该仓库信息。
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  // 账号无推送权限。
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  // 飞书 bot lark-cli 不可用。
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  // auth status 未报告应用信息。
  feishuBotNotReady: ['feishu', 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.'],
  // 应用 bot 身份未就绪（需配置应用密钥）。
  feishuUserIdentity: ['feishu', 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.'],
  // CLI 允许用户身份（严格模式非 bot），须为 bot 单独配置。
  feishuNoBot: ['feishu', 'The Feishu bot API did not return the bot\'s open_id.'],
  // 机器人 API 未返回 open_id。
} as const satisfies Record<string, readonly [SetupPlace, string]>
// satisfies 确保每个条目都是 [位置, 文案] 且位置合法。
export type SetupCode = keyof typeof SETUP_PROBLEMS
// SetupCode：问题码联合类型。
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }
// SetupProblem：可被面板本地化的问题结构。

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 */
export class SetupError extends Error {
  // 部署与账号校验失败时抛出；Setup 记录它供管理总览展示，HTTP 层返回 problem 供面板本地化。
  readonly place: SetupPlace
  // 修复该问题的设置位置。
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}) {
    const [place, text] = SETUP_PROBLEMS[code]
    // 查出位置与描述模板。
    const sentence = fill(text, values)
    // 用插值填充模板。
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    // 有诊断输出时附在描述之后作为错误消息。
    this.place = place
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
  // 以 problem 结构暴露给 HTTP 层。
}
