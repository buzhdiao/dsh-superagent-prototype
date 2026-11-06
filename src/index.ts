/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
// 插件主入口：挂载 Runtime，并为部署账户变更提供重启回调。
import type { Context } from '@deepseek-ai/cordis'
// Context：宿主（cordis）上下文类型。
import type {} from '@deepseek-ai/dsh-settings'
// 仅引入类型声明副作用，扩展 settings 服务类型。
import { Runtime } from './app/runtime.ts'
// Runtime：插件的运行时实现。
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
// 配置模式与机器设置解析。

export const name = 'dsh-superagent'
// 插件名。
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
// 声明依赖的宿主服务列表。
export { Config }
// 导出配置模式供宿主生成设置页。
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  // 插件加载入口。
  const machine = machineOf(config)
  // 解析并校验机器级设置。
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // 管理面板自带设置 UI，因此关闭 DSH 自动生成的设置页。
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    // 重启回调：重启插件 fiber，完成后触发 settings 的 describe()，
    // 使已打开的配置表单无需刷新页面即可继续编辑（见上方说明）。
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
    // 重启失败记录错误日志。
  }
  const runtime = new Runtime(ctx, machine, restart)
  // 创建运行时。
  ctx.effect(() => async () => { await runtime.stop() })
  // 注册清理副作用：插件卸载时停止运行时。
  await runtime.ready
  // 等待运行时初始化完成。
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
  // 输出就绪或等待初始化的日志。
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
// 转导出部署相关类型。
export * from './core/index.ts'
// 转导出核心层。
