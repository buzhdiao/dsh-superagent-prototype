import { readFileSync } from 'node:fs'
// readFileSync：raw 插件加载文件文本。
import { dirname, resolve } from 'node:path'
// 路径工具：相对导入者解析 ?raw 目标。
import { defineConfig } from 'tsdown'
// tsdown 构建配置定义。
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = { name: 'raw',
  // 自定义 raw 插件：像 Vite/vitest 一样把 ?raw 导入按文件文本处理；tsdown 没有 @tsdown/css 时拒绝 .css id，故用它加载。
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  // 把 ?raw 的源解析为相对导入者的绝对文件 id。
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
  // 读取去掉 ?raw 后缀的文件，把文本 JSON 序列化为默认导出。
export default defineConfig([
  { entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: true, clean: true, deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] } },
  // 主构建：Node ESM，含主入口与两个 watch 入口，生成 d.ts，清理 lib，宿主包与少数依赖不打进 bundle。
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw],
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-superagent", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
  // 面板客户端构建：浏览器 CJS，不生成 d.ts、不清空 lib；react 系不打包；用 banner/footer/intro 包成 DSH ModuleLoader 模块。
])
