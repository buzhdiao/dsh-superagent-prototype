/** Open a DSH Session in the workspace after ensuring the session catalog is loaded. */
// 在确保会话目录已加载后，于工作区打开一个 DSH 会话（Session）。
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// ISessions：会话控制器客户端接口。
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// SessionId：会话 ID 类型。

/**
 * Thrown by `openKnownSession` when the host Session catalog is not ready or does not list the target Session.
 * The management panel catches it to display a localized error message.
 */
export class SessionNavigationError extends Error {
  // 由 openKnownSession 抛出：会话目录未就绪或未列出目标会话；管理面板捕获后显示本地化错误。
  constructor(readonly code: 'not-ready' | 'not-listed') { super(code) }
  // code 区分两种失败原因。
}

/** Select `id` in the workspace once the catalog lists it, unless aborted first. */
export async function openKnownSession(sessions: Pick<ISessions, 'list' | 'refresh'>, id: SessionId, open: (id: SessionId) => void, signal: AbortSignal): Promise<boolean> {
  // 等目录列出该会话后在工作区选中它；可被 AbortSignal 提前中止。
  if (signal.aborted) return false
  // 已中止则直接放弃。
  if (sessions.list.getSnapshot().phase !== 'ready' || !sessions.list.getSnapshot().byId[id]) await sessions.refresh()
  // 目录未就绪或未包含目标会话时，先刷新目录。
  if (signal.aborted) return false
  // 刷新期间被中止则放弃。
  const list = sessions.list.getSnapshot()
  if (list.phase !== 'ready') throw new SessionNavigationError('not-ready')
  // 刷新后目录仍未就绪。
  if (!list.byId[id]) throw new SessionNavigationError('not-listed')
  // 目录中仍无该会话。
  open(id)
  // 执行打开动作。
  return true
  // 成功。
}
