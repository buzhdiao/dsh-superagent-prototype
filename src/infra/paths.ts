/** Resolves packaged asset paths from either the source tree or the compiled lib/ output. */
// 从源码树或编译产物 lib/ 目录解析打包资源路径。
import { existsSync, readFileSync } from 'node:fs'
// 文件存在性检查与读取。
import { dirname, join } from 'node:path'
// 路径工具。
import { fileURLToPath } from 'node:url'
// 把 import.meta.url 转为文件路径。

let cached: string | undefined
// 包根目录缓存。
export function packageRoot(): string {
  // 向上查找 package.json 且 name 为 dsh-superagent 的目录，作为包根。
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  // 从当前模块所在目录开始。
  for (let depth = 0; depth < 6; depth++) {
    // 最多向上找 6 层。
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try { if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'dsh-superagent') return cached = directory }
      // 命中本包的 package.json 即返回并缓存。
      catch { /* A foreign package.json on the way up is not this package. */ }
      // 途中解析失败的外来 package.json 跳过。
    }
    directory = dirname(directory)
    // 向上一级。
  }
  throw new Error('dsh-superagent package root not found')
  // 未找到包根。
}
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)
// 基于包根拼接资源路径。
