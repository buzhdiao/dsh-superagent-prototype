/** Loads packaged built-in skill definitions and prompt templates from disk. */
// 从磁盘加载随安装包分发的内置技能（Skill）定义与提示词（prompt）模板。
import { readFileSync } from 'node:fs'
// packagePath：把相对路径片段解析为安装包内文件的绝对路径
import { packagePath } from '../infra/paths.ts'
/**
 * Reads a packaged text file with normalized Unix line endings.
 * @throws Naming the file when it is missing or whitespace-only, because `dsh-superagent` cannot load without it.
 */
// 读取包内文本文件并把换行统一为 Unix 风格（\n）；文件缺失或内容为空白时抛错（错误信息指明文件名），
// 因为这些文件是 dsh-superagent 启动所必需的，缺一不可。
function packaged(...parts: string[]): { path: string; text: string } {
  // 把路径片段拼接并解析为包内绝对路径
  const path = packagePath(...parts)
  // 用 let 声明文本，因为需要在 try/catch 中赋值
  let text: string
  // 同步读取文件（UTF-8），并把 Windows 换行（\r\n）统一替换为 \n；读取失败进入 catch
  try { text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }
  catch (error) {
    // 文件不存在（错误码 ENOENT）时抛出带说明的新错误（原错误挂到 cause 上），其他错误原样上抛
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Missing packaged file: ${path}`, { cause: error }) : error
  }
  // 内容为空白（trim 后为空）同样视为致命错误：内置文件不允许为空
  if (!text.trim()) throw new Error(`Empty packaged file: ${path}`)
  // 返回文件绝对路径与文本内容
  return { path, text }
}
// 加载指定名称的内置技能文件，并从 SKILL.md 的 front matter（`---` 包裹的头部）解析出 name 与 description
function load(name: string) {
  // 读取 skills/dsh-superagent-<name>/SKILL.md
  const { path, text } = packaged('skills', `dsh-superagent-${name}`, 'SKILL.md')
  // 用正则匹配头部：捕获组 1 为 name、2 为 description、3 为 `---` 之后的正文（[\s\S] 跨行匹配）
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  // 头部格式不符则判定该内置技能文件损坏
  if (!match) throw new Error(`Invalid packaged skill: ${path}`)
  // 返回解析结果：名称、描述、正文内容与文件路径（match[n]! 为非空断言，捕获成功后必有值）
  return { name: match[1]!, description: match[2]!, content: match[3]!, path }
}
// 启动时一次性加载 feishu 与 github 两个内置技能，供全程序复用
export const bundledSkills = { feishu: load('feishu'), github: load('github') }
/**
 * Loads a built-in prompt file (`prompts/<name>.md`). Source `.md` files are written one sentence per line for
 * readable diffs; `promptFile` joins lines within each paragraph with spaces while keeping blank-line paragraph breaks.
 */
// 加载内置提示词文件（prompts/<name>.md）。源 .md 文件采用"一句一行"的写法以便 diff 易读；
// promptFile 负责把同一段落内的行用空格拼回一句话，同时保留空行形成的段落分隔
export function promptFile(name: string): string {
  // 先去掉首尾空白，再按"空行（允许含空白字符）"把文本切分成段落
  const paragraphs = packaged('prompts', `${name}.md`).text.trim().split(/\n(?:[ \t]*\n)+/)
  // 每段内逐行去首尾空白后用空格连接成完整段落，段落之间再用换行符连接
  return paragraphs.map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' ')).join('\n')
}
