/**
 * Optimistic settings draft state with sessionStorage persistence and three-way rebase against concurrent saves.
 */
// 乐观（optimistic）设置草稿状态：sessionStorage 持久化，并针对并发保存做三方重定基（rebase）。
import { useEffect, useLayoutEffect, useReducer, useRef, type FormEvent } from 'react'
// 引入 React Hook 与表单事件类型。
import { ApiError } from './api.ts'
// 引入 API 错误（用于区分校验问题与 409 冲突）。
import { usePanel } from './provider.tsx'
// 引入面板上下文（重启回调）。
import { errorText, type T } from './text.ts'
// 引入错误文案与翻译类型。
import { Button } from './controls.tsx'
// 引入按钮组件。

// 深比较两个值是否相同（JSON 序列化后比较）。
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
// 判断是否为普通对象（非数组）。
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
// 可作为数组元素身份（identity）的键。
const LIST_KEYS = ['id', 'chatId']
// named：判断列表每项都是含该字符串字段的记录、且字段值互不相同（可安全作为身份键）。
const named = (list: unknown[], field: string) =>
  list.every(item => isRecord(item) && typeof item[field] === 'string') && new Set(list.map(item => (item as Record<string,
    unknown>)[field])).size === list.length
/**
 * Three-way merge between `base`, local `mine`, and remote `theirs`.
 * Merges objects by key and arrays of keyed records (`id` or `chatId`) by element: a key or element removed by one side is
 * deleted if the other side left it unchanged; a removal against a modification keeps `mine` and is recorded in `conflicts`.
 */
// 三方合并（merge3）：在基线（base）、本地（mine）与远端（theirs）之间合并设置草稿；无法合并的路径记入 conflicts。
export function merge3(base: unknown, mine: unknown, theirs: unknown, conflicts: string[][] = [], path: string[] = []): unknown {
  // 本地未改（相对基线）或与远端相同：直接取远端。
  if (same(mine, base) || same(mine, theirs)) return theirs
  // 远端未改：取本地。
  if (same(theirs, base)) return mine
  // 双方都是数组（基线也为数组或缺省）时，尝试按键身份合并列表。
  if (Array.isArray(mine) && Array.isArray(theirs) && (base === undefined || Array.isArray(base))) {
    // 三个列表（基线可缺省为空数组）。
    const lists = [base ?? [], mine, theirs]
    // 找到一个三方都满足"命名记录"条件的身份字段。
    const field = LIST_KEYS.find(name => lists.every(list => named(list, name)))
    // 找到则走列表合并。
    if (field) return mergeList(lists, field, conflicts, path)
  }
  // 三方不全是对象（或数组）：无法继续合并，记入冲突并保留本地值。
  if (!isRecord(base) || !isRecord(mine) || !isRecord(theirs)) { conflicts.push(path); return mine }
  // 合并结果对象。
  const merged: Record<string, unknown> = {}
  // 遍历双方键的并集，逐键递归合并。
  for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
    // 递归合并该键（带冲突收集与路径）。
    const value = merge3(base[key], mine[key], theirs[key], conflicts, [...path, key])
    // 合并结果为 undefined（表示删除）时不写入。
    if (value !== undefined) merged[key] = value
  }
  // 返回合并结果。
  return merged
}
// 列表三方合并：以身份字段对齐元素，保留远端顺序并回插本地新增元素。
function mergeList([base, mine, theirs]: unknown[][], field: string, conflicts: string[][], path: string[]): unknown[] {
  // 取元素的字符串身份。
  const name = (item: unknown) => String((item as Record<string, unknown>)[field])
  // 三个列表各自转成 身份→元素 的映射。
  const [before, ours, others] = [base!, mine!, theirs!].map(list => new Map(list.map(item => [name(item), item])))
  // 以远端顺序为基准顺序。
  const order = theirs!.map(name)
  // 把本地新增（远端没有）的元素按位置回插到顺序中。
  mine!.forEach((item, index) => {
    // 远端已有的元素跳过。
    if (order.includes(name(item))) return
    // 找本地中它前面最近的一个已存在于远端顺序的元素。
    const previous = mine!.slice(0, index).map(name).reverse().find(key => order.includes(key))
    // 插到该元素之后；前面没有已存在元素则插到最前。
    order.splice(previous === undefined ? 0 : order.indexOf(previous) + 1, 0, name(item))
  })
  // 按最终顺序逐元素三方合并，过滤掉被删除（undefined）的元素。
  return order.flatMap(key => {
    const value = merge3(before!.get(key), ours!.get(key), others!.get(key), conflicts, [...path, key])
    return value === undefined ? [] : [value]
  })
}

// sessionStorage 中存储的草稿结构：基线（base）、当前值、修订号与可选元数据。
interface Stored<V, M> { base: V; value: V; revision: number; meta?: M }
// 读取草稿。
function read<V, M>(key: string | undefined): Stored<V, M> | undefined {
  // 无 key 不读取。
  if (!key) return undefined
  try {
    // 解析 sessionStorage 内容（缺省为 null）。
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Partial<Stored<V, M>> | null
    // Drop drafts without `base` (stored by older versions) because they cannot be three-way merged.
    // 丢弃缺少 base 的旧版本草稿：它们无法参与三方合并；结构不完整（缺 value 或修订号非整数）同样视为无效。
    return stored && 'base' in stored && 'value' in stored && Number.isInteger(stored.revision) ? stored as Stored<V, M> : undefined
  } catch (error) { void error /* An unreadable draft is dropped; the saved value stays authoritative. */; return undefined }
}

// 草稿提示（DraftNotice）类型：恢复、重定基中、已合并、冲突、校验失败、保存失败或未存储。
export type DraftNotice = { kind: 'restored' | 'rebasing' } | { kind: 'merged'; revision: number }
  | { kind: 'conflict'; revision: number; paths: string[][] } | { kind: 'invalid'; fields: string[] }
  | { kind: 'failed' | 'unstored'; error: string }
// 视为"失败类"的提示种类（编辑时会保留展示）。
const FAILURES: ReadonlySet<DraftNotice['kind']> = new Set(['conflict', 'invalid', 'failed', 'unstored'])
// 草稿状态机状态。
export interface DraftState<V, M> {
  phase: 'clean' | 'editing' | 'saving' | 'awaitingRevision'
  draft?: Stored<V, M> | undefined
  sent?: { value: V; revision: number; restarting: boolean } | undefined
  seen?: number | undefined
  notice?: DraftNotice | undefined
}
// 草稿动作类型。
export type DraftAction<V, M> = { type: 'edit'; value: V; meta: M | undefined; saved: V; revision: number | undefined }
  | { type: 'discard' | 'submit' } | { type: 'saved'; revision: number; restarting: boolean } | { type: 'refused'; notice: DraftNotice }
  | { type: 'revisionArrived'; saved: V; revision: number }
/**
 * State machine for a settings draft.
 * Holds submitted values in `awaitingRevision` until the polled revision catches up, and rebases active edits onto newer remote revisions via `merge3`.
 */
// 设置草稿状态机（draftReducer）。
export function draftReducer<V, M>(state: DraftState<V, M>, action: DraftAction<V, M>): DraftState<V, M> {
  // 解构当前阶段、草稿与已见修订号。
  const { phase, draft, seen } = state
  switch (action.type) {
    // edit：用户编辑。
    case 'edit': {
      // 保存中/等待修订号时忽略编辑。
      if (phase === 'saving' || phase === 'awaitingRevision') return state
      // 与已保存值相同则回到干净状态。
      if (same(action.value, action.saved)) return { phase: 'clean', seen }
      // 保留失败类提示（如冲突），其他提示清除。
      const notice = state.notice && FAILURES.has(state.notice.kind) ? state.notice : undefined
      // 进入编辑态：基线取已有草稿基线或已保存值；修订号同理（缺省 0）。
      return { phase: 'editing', seen, notice, draft: { base: draft?.base ?? action.saved, value: action.value,
        revision: draft?.revision ?? action.revision ?? 0, ...action.meta === undefined ? {} : { meta: action.meta } } }
    }
    // discard：保存中/等待修订号时不可丢弃。
    case 'discard': return phase === 'saving' || phase === 'awaitingRevision' ? state : { phase: 'clean', seen }
    // submit：仅编辑态可提交。
    case 'submit': return phase === 'editing' ? { ...state, phase: 'saving' } : state
    // saved：保存成功进入等待修订号阶段，记录已提交值。
    case 'saved': return phase === 'saving' && draft ? { phase: 'awaitingRevision', seen,
      sent: { value: draft.value, revision: action.revision, restarting: action.restarting } } : state
    // refused：被拒——保存中回到编辑态并附提示。
    case 'refused': return { ...state, phase: phase === 'saving' ? 'editing' : phase, notice: action.notice }
    // revisionArrived：轮询到新的远端修订号。
    case 'revisionArrived': {
      // Defer rebasing while a save is running; its completion will either advance to `awaitingRevision` or reload and merge.
      // 保存运行中暂缓重定基；保存完成后要么进入 awaitingRevision，要么重载并合并。
      if (phase === 'saving') return state
      // 取新修订号与远端值。
      const { revision, saved } = action
      // 有已提交值：修订号追上则完成（回干净态），否则仅记录已见。
      if (state.sent) return revision >= state.sent.revision ? { phase: 'clean', seen: revision } : { ...state, seen: revision }
      // 无草稿或草稿基线已是该修订号：仅记录已见。
      if (!draft || draft.revision === revision) return { ...state, seen: revision }
      // 冲突路径收集。
      const paths: string[][] = []
      // 三方合并：本地草稿 vs 远端新值。
      const value = merge3(draft.base, draft.value, saved, paths) as V
      // 合并结果等于远端值（本地无有效修改）则回干净态。
      if (same(value, saved)) return { phase: 'clean', seen: revision }
      // 否则回到编辑态：基线换成远端值；有冲突记冲突提示，否则记已合并提示。
      return { phase: 'editing', seen: revision, draft: { ...draft, base: saved, value, revision },
        notice: paths.length ? { kind: 'conflict', revision, paths } : { kind: 'merged', revision } }
    }
  }
}
// 保存栏自定义文案（可选覆盖默认文案）。
export interface DraftWords {
  merged?: (revision: number) => string
  conflict?: (revision: number, paths: string[][]) => string
  editing?: string
}
// 计算保存栏文案：出错返回 error，否则返回状态文案。
export function saveBarText(t: T, { phase, sent, notice }: DraftState<unknown, unknown>,
  words: DraftWords = {}): { error?: string; status: string } {
  // 按提示种类选择文案。
  switch (notice?.kind) {
    // 冲突：错误文案（含冲突路径）。
    case 'conflict': return { error: words.conflict?.(notice.revision, notice.paths) ?? t('saveConflict'), status: '' }
    // 校验失败：列出问题字段。
    case 'invalid': return { error: t('invalidSettings', { fields: notice.fields.join(t('listSeparator')) }), status: '' }
    // 保存失败：直接显示错误。
    case 'failed': return { error: notice.error, status: '' }
    // 未存储：草稿无法持久化的提示。
    case 'unstored': return { error: t('draftFailed', { error: notice.error }), status: '' }
    // 已合并：状态文案。
    case 'merged': return { status: words.merged?.(notice.revision) ?? t('saveMerged') }
    // 重定基中。
    case 'rebasing': return { status: t('saveRebasing') }
  }
  // 等待修订号：已保存（或保存后需要重启）。
  if (phase === 'awaitingRevision') return { status: t(sent?.restarting ? 'savedRestarting' : 'saved') }
  // 其余：干净即已保存；编辑中用自定义文案或草稿恢复/保留提示。
  return { status: phase === 'clean' ? t('saved') : words.editing ?? t(notice?.kind === 'restored' ? 'draftRestored' : 'draftKept') }
}

// 草稿选项：存储键、已保存值、修订号、保存函数与重载函数。
export interface DraftOptions<V> {
  key?: string
  saved: V
  revision: number | undefined
  save: (value: V, revision: number, base: V) => Promise<{ revision: number; restarting?: boolean }>
  reload: () => Promise<unknown>
}
/** Manage a settings draft, persisting unsaved edits in `sessionStorage` and rebasing them when newer server revisions arrive. */
// 管理设置草稿：未保存编辑持久化到 sessionStorage；远端出现更新修订号时自动重定基。
export function useDraft<V, M = undefined>({ key, saved, revision, save, reload }: DraftOptions<V>) {
  // 取面板上下文的重启回调。
  const { restart } = usePanel()
  // 初始化状态机：优先恢复已存草稿；有修订号时立即对齐一次。
  const [state, dispatch] = useReducer(draftReducer<V, M>, undefined, () => {
    // 读取已存草稿。
    const stored = read<V, M>(key)
    // 有草稿则进入编辑态并附"已恢复"提示，否则干净态。
    const initial: DraftState<V, M> = stored ? { phase: 'editing', draft: stored, notice: { kind: 'restored' } } : { phase: 'clean' }
    // 有修订号时先跑一次 revisionArrived 对齐远端。
    return revision === undefined ? initial : draftReducer(initial, { type: 'revisionArrived', saved, revision })
  })
  // 渲染期间对齐修订号：非保存中且出现未见过的修订号时派发。
  if (state.phase !== 'saving' && revision !== undefined && revision !== state.seen) dispatch({ type: 'revisionArrived', saved, revision })
  useEffect(() => {
    // 无 key 不持久化。
    if (!key) return
    // 有草稿写入 sessionStorage，无草稿则移除。
    try { if (state.draft) sessionStorage.setItem(key, JSON.stringify(state.draft)); else sessionStorage.removeItem(key) }
    // 写入失败记 unstored 提示。
    catch (failure) { dispatch({ type: 'refused', notice: { kind: 'unstored', error: errorText(failure) } }) }
  }, [key, state.draft])
  // failed：统一的失败派发。
  const failed = (failure: unknown) => dispatch({ type: 'refused', notice: { kind: 'failed', error: errorText(failure) } })
  // submit：提交保存。
  const submit = async (event?: FormEvent) => {
    // 阻止表单默认提交。
    event?.preventDefault()
    // 取当前草稿。
    const { draft } = state
    // 仅编辑态且有草稿才提交。
    if (state.phase !== 'editing' || !draft) return
    // 进入保存中。
    dispatch({ type: 'submit' })
    // 保存结果占位。
    let result: { revision: number; restarting?: boolean }
    try {
      // 调用保存（值、修订号与基线）。
      result = await save(draft.value, draft.revision, draft.base)
    } catch (failure) {
      // 失败时提取校验问题字段路径。
      const fields = failure instanceof ApiError ? failure.issues.map(issue => issue.path) : []
      // 409 冲突：重载数据并提示"重定基中"。
      if (failure instanceof ApiError && failure.status === 409) {
        await reload().then(() => dispatch({ type: 'refused', notice: { kind: 'rebasing' } }), failed)
      } else dispatch({ type: 'refused', notice: fields.length ? { kind: 'invalid', fields } : { kind: 'failed',
        error: errorText(failure) } })
      return
    }
    // 保存成功：进入等待修订号阶段。
    dispatch({ type: 'saved', revision: result.revision, restarting: !!result.restarting })
    // 需要重启则触发重启，否则重载数据。
    if (result.restarting) restart(); else await reload().catch(failed)
  }
  // 对外暴露状态与操作：当前值、修订号、是否脏、是否忙碌、提交/编辑/丢弃。
  return { state, value: state.sent?.value ?? state.draft?.value ?? saved, meta: state.draft?.meta,
    revision: state.draft?.revision ?? revision ?? 0, dirty: state.draft !== undefined,
    busy: state.phase === 'saving' || state.phase === 'awaitingRevision', submit,
    edit: (value: V, meta?: M) => dispatch({ type: 'edit', value, meta, saved, revision }), discard: () => dispatch({ type: 'discard' }) }
}

/** Sticky save/discard bar for a settings block; transfers focus back to its parent block when hidden so keyboard navigation does not reset. */
// 设置块的吸顶保存/丢弃栏；隐藏时把焦点交回父区块，避免键盘导航位置重置。
export function SaveBar({ state, dirty, busy, words, status, onDiscard, onSave }: {
  state: DraftState<unknown, unknown>; dirty: boolean; busy: boolean; words?: DraftWords; status?: string | undefined
  onDiscard: () => void; onSave?: () => void
}) {
  // 取翻译。
  const { t } = usePanel()
  // 计算保存栏文案。
  const line = saveBarText(t, state, words)
  // 是否显示：有改动、忙碌或出错。
  const shown = dirty || busy || !!line.error
  // 保存栏引用。
  const bar = useRef<HTMLDivElement>(null)
  // 父区块引用。
  const block = useRef<HTMLElement | null>(null)
  // 焦点是否在栏内。
  const focused = useRef(false)
  useLayoutEffect(() => {
    // 显示时记录父区块即可。
    if (shown) { block.current = bar.current?.parentElement ?? null; return }
    // 焦点是否已丢失（无活动元素或落在 body 上）。
    const lost = !document.activeElement || document.activeElement === document.body
    // 曾聚焦且父区块存在且焦点丢失：临时设为可聚焦并把焦点移回父区块。
    if (focused.current && block.current && lost) { block.current.tabIndex = -1; block.current.focus({ preventScroll: true }) }
    // 重置焦点标记。
    focused.current = false
  }, [shown])
  // 不显示则不渲染。
  if (!shown) return null
  // leave：焦点移出保存栏时重置标记。
  const leave = (next: Element | null) => { if (next && !bar.current?.contains(next)) focused.current = false }
  // 渲染保存栏。
  return <div ref={bar} className="dt-savebar" onFocus={() => { focused.current = true }}
    onBlur={event => leave(event.relatedTarget as Element | null)}>
    {/* 出错显示错误，否则显示状态文案（aria-live 播报）。 */}
    {line.error ? <p className="dt-error dt-clamp" role="alert">{line.error}</p>
      : <p className="dt-hint" aria-live="polite">{status ?? line.status}</p>}
    {/* 丢弃按钮。 */}
    <Button variant="ghost" size="sm" disabled={!dirty || busy} onClick={onDiscard}>{t('discard')}</Button>
    {/* 保存按钮：有 onSave 用点击，否则作为表单提交按钮。 */}
    <Button variant="primary" size="sm" disabled={!dirty || busy} {...onSave ? { onClick: onSave } : { type: 'submit' as const }}>
      {t('save')}
    </Button>
  </div>
}
