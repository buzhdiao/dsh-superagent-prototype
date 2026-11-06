import { defineConfig } from 'vitest/config'
// vitest 配置定义。
// Share one React instance across DSH client packages and tests.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] }, test: { include: ['tests/**/*.spec.{ts,tsx}'] } })
// 去重 react/react-dom，使 DSH 客户端包与测试共用一个 React 实例；测试范围为 tests/ 下的 *.spec.ts(x)。
