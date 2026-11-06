/** Validation bounds shared between host schemas and management panel forms. */
// 宿主模式与管理面板表单共享的校验取值范围。
export const LIMITS = {
  // 各配置项的边界。
  ruleName: 100,
  // 规则名称最大长度。
  ruleInstruction: 2000,
  // 规则指令最大长度。
  evalTimeoutSeconds: { min: 30, max: 600 },
  // 评估超时（秒）范围。
  maxWorkers: { min: 1, max: 16 },
  // 最大工作进程数范围。
  prepareCommand: 4000,
  // 准备命令最大长度。
  promptMaxChars: { min: 1000, max: 1_000_000 },
  // 提示词最大字符数范围。
  admissionContextMaxPages: { min: 1, max: 100 },
  // 准入评估可读上下文页数范围。
  admissionContextTimeoutMs: { min: 1, max: 90_000 },
  // 准入评估单次上下文读取时限（毫秒）范围。
} as const
