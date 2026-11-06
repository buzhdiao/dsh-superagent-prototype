/** Downloads Feishu message images and commits them as model-visible attachments during assessment. */
// 下载飞书消息图片，并在评估期间保存为模型可见的附件。
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
// 临时目录、读取、真实路径、删除与状态查询。
import { dirname, extname, join } from 'node:path'
// 路径工具：目录名、扩展名、拼接。
import type { Agent } from '@deepseek-ai/dsh-agent'
// Agent：代理实例类型。
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
// 附件服务类型：图片引用与媒体类型。
import type {} from '@deepseek-ai/dsh-llm'
// 仅引入类型副作用（扩展 agent.ctx 的 llm 服务类型）。
import { z } from 'zod'
// zod：校验 CLI 输出。
import type { Commands } from '../infra/commands.ts'
// Commands：命令执行器。
import type { FeishuRef } from './feishu-read.ts'
// FeishuRef：来源消息引用。

/** Extracts Feishu image keys from message text so keys remain paired with the originating message; arbitrary remote IDs are not accepted. */
export function admissionImageKeys(text: string): string[] {
  // 从消息文本提取飞书图片键，使键始终与其来源消息配对；不接受任意的远端 ID。
  return [...new Set(text.match(/\bimg_[a-zA-Z0-9_-]+\b/g) ?? [])]
  // 正则匹配 img_ 前缀的键并去重。
}

export interface AdmissionImage {
  // 准入图片的读取结果。
  source_message_id: string
  // 图片所在的消息 id。
  image_key: string
  // 图片键。
  image: ImageAttachmentRef
  // 已保存附件的引用。
}

export async function readAdmissionImage(agent: Agent, commands: Commands, ref: FeishuRef, text: string, imageKey: string, stateDir: string, signal: AbortSignal): Promise<AdmissionImage> {
  // 下载指定消息中的指定图片并保存为附件。
  if (!admissionImageKeys(text).includes(imageKey)) throw new Error('Choose an image key from this source message')
  // 图片键必须来自该消息文本，防止读取任意远端资源。
  const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/).parse(ref.messageId)
  // 校验消息 id 格式。
  const attachments = agent.ctx.get('attachments')
  if (!attachments) throw new Error('Image reading is unavailable: no attachment service is mounted')
  // 未挂载附件服务。
  const route = agent.session.requestHeader()?.config
  // 当前会话请求的模型路由配置。
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  const llm = agent.ctx.get('llm')
  if (!llm || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
  // 模型路由未解析。
  const info = await llm.resolveModelInfo(provider, model, signal)
  if (!info.inputModalities?.includes('image')) throw new Error(`Model ${model} does not support image input; the image has not been inspected`)
  // 当前模型不支持图片输入。
  signal.throwIfAborted()
  // 下载前检查中止信号。
  const directory = await mkdtemp(join(stateDir, 'admission-image-'))
  // 创建临时下载目录。
  try {
    const result = z.object({ saved_path: z.string() }).parse(await commands.withSignal(signal).lark([
      'im', '+messages-resources-download', '--message-id', messageId, '--file-key', imageKey, '--type', 'image', '--output', './image',
    ], directory))
    // 在临时目录内用 lark-cli 下载图片资源。
    const path = await realpath(result.saved_path)
    // 解析真实路径。
    if (dirname(path) !== await realpath(directory)) throw new Error('Image download returned a path outside its temporary directory')
    // 下载路径必须仍在临时目录内（防目录穿越）。
    const mediaTypes: Record<string, ImageMediaType> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
    const mediaType = mediaTypes[extname(path).toLowerCase()]
    if (!mediaType) throw new Error('The downloaded resource is not a supported PNG/JPEG/WebP/GIF image')
    // 只接受这四种图片格式。
    const file = await stat(path)
    if (!file.isFile() || file.size > Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)) throw new Error('The image exceeds the deployment byte limit or is not a regular file')
    // 必须是普通文件且不超过部署的字节上限。
    const data = await readFile(path, { signal })
    signal.throwIfAborted()
    // 读取后再次检查中止。
    const image = await attachments.saveImage({ data, mediaType, name: `${imageKey}${extname(path)}` })
    // 保存为附件。
    signal.throwIfAborted()
    return { source_message_id: messageId, image_key: imageKey, image }
  } finally {
    await rm(directory, { recursive: true, force: true })
    // 无论成败都清理临时目录。
  }
}
