/** Tests for scripts/dsh-superagent using a temporary checkout path with spaces and stubbed ps, tmux, and dsh binaries. */
// 本文件覆盖 scripts/dsh-superagent 服务管理脚本（start/stop/restart/status）：
// 进程扫描与 profile 归属、service.pid 记录、手动停机标记、日志轮转、健康退出码
// （0 正常 / 1 控制失败 / 2 部件错误 / 3 等待初始化）、profile 操作锁与优雅停止超时。
// 测试策略：真实执行该 Python 脚本，用临时目录（路径带空格）+ 伪造的 ps/tmux/dsh 可执行程序
// 与本地 HTTP 假服务端驱动全流程。
import { execFile, spawn, type ChildProcess } from 'node:child_process'
// 真实子进程：执行被测脚本与常驻的 sleeper 进程。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync }
  from 'node:fs'
// 文件系统操作：搭建临时 checkout、写 ps 清单、检查产物。
import { createServer, type Server } from 'node:http'
// 本地 HTTP 假服务端，冒充运行中服务的健康接口。
import type { AddressInfo } from 'node:net'
// 取监听端口的类型。
import { tmpdir } from 'node:os'
// 系统临时目录。
import { join } from 'node:path'
// 路径拼接。
import { afterEach, beforeEach, expect, it } from 'vitest'
// vitest 测试原语。

let root: string
// 每用例的临时目录，路径特意含空格（'service script '），验证脚本的引号处理。
let server: Server | undefined
// 当前用例的假 HTTP 服务端。
let sleepers: ChildProcess[] = []
// 需要在用例结束后清理的常驻进程。
const control = (profile: string) => join(root, '.artifacts', 'control', 'profiles', profile)
// profile 的控制目录（service.pid、manually-stopped、operation.lock 所在）。
const program = (name: string, body: string) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
// 在 bin/ 下伪造一个可执行程序。
/** Spawn a dummy process whose PID can be listed by the fake ps binary; ignoreInterrupt simulates a hung graceful stop. */
// 启动一个能被假 ps 列出的假进程；ignoreInterrupt 忽略 SIGINT，模拟优雅停止卡死。
function sleeper(ignoreInterrupt = false): number {
  const [program, args] = ignoreInterrupt ? ['sh', ['-c', 'trap "" INT; exec sleep 60']] as const : ['sleep', ['60']] as const
  const child = spawn(program, [...args], { stdio: 'ignore' })
  sleepers.push(child)
  return child.pid!
}
const service = (pid: number, profile = 'superagent') => `${pid} node node /opt/my tools/dsh --profile ${profile} --no-open`
// 构造一行 ps 输出：指定 PID 的服务进程（命令路径带空格）。
/** Write active process lines (`pid ucomm args`) for the fake ps binary. Entries prefixed with `after:<pid> ` appear only after that PID exits. */
// 为假 ps 写活动进程行（`pid ucomm args`）；带 `after:<pid> ` 前缀的行在该 PID 退出后才出现。
const processes = (...lines: string[]) => writeFileSync(join(root, 'ps.txt'), lines.map(line => `${line}\n`).join(''))
const started = (...lines: string[]) => writeFileSync(join(root, 'ps-started.txt'), lines.map(line => `${line}\n`).join(''))
// 服务启动后（存在 launched 标记）假 ps 才读的进程清单。
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script '))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent'), join(root, 'scripts', 'dsh-superagent'))
  // 把被测脚本复制进临时 checkout。
  processes()
  program('ps', `list='${root}/ps.txt'; [ -f '${root}/launched' ] && [ -f '${root}/ps-started.txt' ] && list='${root}/ps-started.txt'
want=; while [ $# -gt 0 ]; do [ "$1" = -p ] && want=$2; shift; done
while IFS= read -r line; do
  case "$line" in after:*) dep=\${line#after:}; dep=\${dep%% *}; kill -0 "$dep" 2>/dev/null && continue; line=\${line#after:$dep };; esac
  pid=\${line%% *}; kill -0 "$pid" 2>/dev/null || continue
  if [ -z "$want" ] || [ "$pid" = "$want" ]; then printf '%s\\n' "$line"; fi
done < "$list"`)
  // 伪 ps：服务已启动则读 ps-started.txt；过滤已死进程；支持 -p 按 PID 过滤与 after: 依赖行。
  // Log tmux invocations and simulate session creation by outputting the pane PID.
  // 伪 tmux：把调用参数记进 tmux.log；has-session 报不存在；new-* 触发 launched 标记并输出 pane PID。
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in has-session) exit 1;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  program('dsh', 'exit 0')
  // 伪 dsh：占位，保证 PATH 上有它。
})
afterEach(() => {
  server?.close(); server = undefined
  for (const child of sleepers) child.kill()
  sleepers = []
  rmSync(root, { recursive: true, force: true })
  // 收尾：关服务端、杀 sleeper、删临时目录。
})
function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // 执行被测脚本：PATH 前插 bin/（命中伪程序），清空 profile/url 环境变量。
  return new Promise(resolve => execFile('python3', [join(root, 'scripts', 'dsh-superagent'), ...args],
    { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '' },
      timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const READY = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }
// 健康接口的“一切正常”响应体。
/** Start a mock HTTP server that returns 503 until tmux launches the service (unless always is true). */
// 启动假 HTTP 服务端：tmux 真正启动服务前回 503（always=true 则始终回 200）。
async function answering(state: unknown = READY, always = false): Promise<string> {
  server = createServer((_request, response) => {
    if (!always && !existsSync(join(root, 'launched'))) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
const status = async (profile: string, url = 'http://127.0.0.1:9') =>
  JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout) as { pids: number[]; manually_stopped: boolean }
// 执行 status 并解析 JSON 结果（pids 与手动停机标记）。

it('refuses to stop when two processes serve the profile, before it writes the stop marker', async () => {
  // 歧义保护：发现两个服务进程时拒绝 stop，且不写停机标记。
  processes(service(sleeper()), `${sleeper()} node node /opt/dsh --profile=superagent`)
  // 两个进程都服务 superagent profile（一个用 = 传参）。
  expect(await run('stop')).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes found') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
  // 停机标记未落盘。
})
it('keeps a stop per profile', async () => {
  // 停机标记按 profile 隔离：只暂停被停 profile 的自动恢复。
  expect(await run('stop', '--profile', 'one')).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
  expect(await status('one')).toMatchObject({ manually_stopped: true })
  expect(await status('two')).toMatchObject({ manually_stopped: false })
  // 标记只作用于 one。
  const skipped = await run('--respect-stop', 'start', '--profile', 'one')
  expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('Intentional stop is active') })
  // 尊重停机标记的 start 不拉起服务。
})
it('takes no `dsh plugin` command of the profile for its service', async () => {
  // 进程扫描只认服务进程，`dsh plugin ...` 这类子命令不算。
  const service = sleeper()
  processes(`${sleeper()} node node /opt/my tools/dsh plugin --profile superagent add link:/x`,
    `${service} node node /opt/my tools/dsh --profile superagent --no-open`)
  expect(await status('superagent')).toMatchObject({ pids: [service] })
  // pids 只含真正的服务进程。
})
it('records the service PID at start, and still refuses a second instance the scan finds', async () => {
  // start 记录服务 PID；若扫描又发现别的实例仍拒绝（即使 PID 是自己刚记录的）。
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  // tmux 启动后：pane 输出该 PID，ps-started 列出它。
  const start = await run('start', '--url', url, '--timeout', '10')
  expect(start).toMatchObject({ code: 0, stdout: expect.stringContaining(`"pids": [\n    ${pid}\n  ]`) })
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  // service.pid 记录了启动的服务 PID。
  const tmux = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').find(call => call.startsWith('new-session'))!.split('\n')
  // The checkout's path, which has a space, is one argument, and the log path inside it is quoted for the shell.
  // 含空格的 checkout 路径必须作为单个参数传给 tmux，日志路径须为 shell 加引号。
  const checkout = realpathSync(root)
  expect(tmux).toEqual(expect.arrayContaining(['-P', '-F', '#{pane_pid}', '-c', checkout]))
  const log = new RegExp(`>> '${checkout}/\\.artifacts/dsh-superagent-superagent-\\d{8}-\\d{6}-\\d+\\.log' 2>&1$`)
  expect(tmux.find(word => word.startsWith('umask 077; exec '))).toMatch(log)
  // 启动命令以 umask 077 执行，日志重定向到带时间戳的文件并合并 stderr。
  const second = sleeper()
  started(service(pid), `${second} node node /opt/dsh --profile superagent`)
  const again = await run('start', '--url', url, '--timeout', '10')
  expect(again).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes') })
  expect(await status('superagent')).toMatchObject({ pids: [pid, second] })
  // 第二次 start 拒绝：扫描发现两个实例。
}, 20_000)
it('waits only for the process it stopped', async () => {
  // stop 只等自己停的那个进程退出；随后出现的另一实例不算。
  const pid = sleeper()
  // Another instance shows up once the stopped one ended.
  // 被停进程退出后“另一实例”才出现。
  processes(service(pid), `after:${pid} ${sleeper()} node node /opt/dsh --profile superagent`)
  expect(await run('stop', '--stop-timeout', '5')).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped') })
}, 20_000)
it('keeps only the newest logs it wrote for the profile', async () => {
  // 日志轮转：按 profile 保留最近 20 个自己写的日志；别的 profile 与旧命名不动。
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  mkdirSync(join(root, '.artifacts'), { recursive: true })
  for (const profile of ['superagent', 'other']) for (let index = 0; index < 25; index++) {
    const log = join(root, '.artifacts', `dsh-superagent-${profile}-20260901-0000${String(index).padStart(2, '0')}-1.log`)
    writeFileSync(log, '')
    utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
    // 每个 profile 预置 25 个带递增 mtime 的旧日志。
  }
  writeFileSync(join(root, '.artifacts', 'dsh-superagent-20260901-000000-1.log'), '')
  // 一个不匹配新命名的更老日志。
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const logs = readdirSync(join(root, '.artifacts'))
  const own = logs.filter(name => name.startsWith('dsh-superagent-superagent-')).sort()
  expect(own).toHaveLength(20)
  // The oldest went; the new one stays, with the newest earlier ones. Another profile's logs and older names stay.
  // 最旧的被清掉；本次新日志与较新的旧日志保留。其它 profile 与旧命名的日志不动。
  expect(own).not.toContain('dsh-superagent-superagent-20260901-000000-1.log')
  expect(own.filter(name => !name.startsWith('dsh-superagent-superagent-20260901-'))).toHaveLength(1)
  expect(logs.filter(name => name.startsWith('dsh-superagent-other-'))).toHaveLength(25)
  expect(logs).toContain('dsh-superagent-20260901-000000-1.log')
}, 20_000)
it('reports a service whose Feishu bot setup could not check as running, and reads an answer with keys missing', async () => {
  // status 容错：飞书初始化有问题仍算运行中（exit 0）；响应缺键也不崩；runtime error 才算失败。
  processes(service(sleeper()))
  const feishu = { health: { runtime: { state: 'ready', detail: '' }, feishu: { state: 'paused', detail: '' } },
    setup: { problem: null, feishuProblem: { code: 'feishuNoBot', detail: 'No bot' } } }
  expect(await run('status', '--url', await answering(feishu, true))).toMatchObject({ code: 0 })
  // 飞书侧待初始化：服务本体 ready 即视为运行。
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'ready' } } }, true))).toMatchObject({ code: 0 })
  // 响应缺 setup/feishuProblem 等键：不抛错。
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'error' } } }, true))).toMatchObject({ code: 1 })
  // runtime 处于 error：退出码 1。
})
it('exits 2 while a part such as a Source reports an error, which a restart does not fix, and prints what it reports', async () => {
  // 部件（Source）报错：status/start 都退 2，并打印错误详情；重启解决不了。
  processes(service(sleeper()))
  const github = { health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' } }, setup: {} }
  const url = await answering(github, true)
  const checked = await run('status', '--url', url)
  expect(checked.code).toBe(2)
  expect(JSON.parse(checked.stdout)).toMatchObject({ errors: { github: 'bad token' } })
  // status 以 JSON 报出出错部件与详情。
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('github reports an error, which a restart does not fix: bad token') })
  // start 后健康检查发现部件错误：提示重启无效。
}, 20_000)
it('exits 3 while the service waits for setup, from status and from start, which a restart does not fix', async () => {
  // 等待初始化：status/start 都退 3，并打印等待原因。
  processes(service(sleeper()))
  const waiting = { health: { runtime: { state: 'paused', detail: '' } },
    setup: { problem: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' }, feishuProblem: null } }
  const url = await answering(waiting, true)
  expect(await run('status', '--url', url)).toMatchObject({ code: 3 })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 3, stdout: expect.stringContaining('waiting for setup: The GitHub Source names no repository.') })
}, 20_000)
it('restarts the service, and a restart whose graceful stop timed out does not keep recovery off', async () => {
  // restart：优雅停掉旧实例再拉新，且不残留停机标记；优雅停止超时则报错且不关自动恢复。
  const url = await answering()
  const old = sleeper(), pid = sleeper()
  processes(service(old))
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  // 旧实例在扫描里（old），tmux 即将启动的新实例是 pid。
  const restarted = await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '5')
  expect(restarted).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped.') })
  expect(restarted.stdout).not.toContain('Automatic recovery is paused')
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
  // 重启不是“有意停机”：不写停机标记。
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  // service.pid 已更新为新实例。
  // A service that does not stop in time is left running, and the next check may restart it.
  // 超时未停的服务保持运行，留给之后的检查处理。
  rmSync(join(root, 'launched'))
  processes(service(sleeper(true)))
  expect(await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '1'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(await status('superagent')).toMatchObject({ manually_stopped: false })
  // 优雅停止超时：退出码 1，且自动恢复未被关闭。
}, 20_000)
it('refuses a second control operation while one holds the profile\'s lock', async () => {
  // profile 操作锁：并发控制操作被拒绝。
  mkdirSync(control('superagent'), { recursive: true })
  const held = join(root, 'held')
  const holder = spawn('python3', ['-c', `import fcntl, pathlib, time
lock = open(${JSON.stringify(join(control('superagent'), 'operation.lock'))}, 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
pathlib.Path(${JSON.stringify(held)}).touch()
time.sleep(30)`], { stdio: 'ignore' })
  // 一个真实 Python 进程占住 operation.lock，并以 held 文件通知“锁已持有”。
  sleepers.push(holder)
  while (!existsSync(held)) await new Promise(resolve => setTimeout(resolve, 50))
  expect(await run('status')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('Another dsh-superagent control operation is in progress') })
  // 第二个控制操作被锁拒绝。
}, 20_000)
it('refuses to start a service while no process runs it but something answers at its URL', async () => {
  // URL 被占用（有东西应答但无进程）：拒绝启动，避免接管不明的编排者。
  const url = await answering(READY, true)
  expect(await run('start', '--url', url, '--timeout', '5'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('An existing orchestrator answers at this URL') })
  expect(readFileSync(join(root, 'tmux.log'),
    'utf8').split('---\n').filter(Boolean).map(call => call.split('\n')[0])).toEqual(['has-session'])
  // 只探查过 tmux 会话是否存在，未创建任何会话/窗口。
}, 20_000)
it('starts the service in a new window of the profile\'s tmux session when the session exists', async () => {
  // 会话已存在时复用它：new-window 并定位到 =dsh-superagent: 目标，而不是新建会话。
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in has-session) exit 0;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  // 此用例的 tmux：has-session 报存在。
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const calls = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').map(call => call.split('\n'))
  expect(calls.find(call => call[0] === 'new-window')).toEqual(expect.arrayContaining(['-t', '=dsh-superagent:']))
  expect(calls.some(call => call[0] === 'new-session')).toBe(false)
}, 20_000)
it('exits 1 when the started service does not answer in time, and leaves its process running', async () => {
  // 启动健康检查超时：退出码 1，但已启动的进程保留（不杀）。
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', 'http://127.0.0.1:9', '--timeout', '2'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Startup health check timed out') })
  expect(() => process.kill(pid, 0)).not.toThrow()
  // 进程仍活着（kill 0 探活成功）。
}, 20_000)
it('does not signal a process that took the recorded service PID, and keeps a stop that timed out', async () => {
  // PID 复用保护：service.pid 记录的 PID 现在是别的进程时不发信号；优雅停止超时的停机标记保留。
  mkdirSync(control('superagent'), { recursive: true })
  const other = sleeper()
  processes(`${other} sleep sleep 60`)
  writeFileSync(join(control('superagent'), 'service.pid'), `${other}\n`)
  // service.pid 指向一个“sleep”进程（PID 被复用）。
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 0 })
  expect(() => process.kill(other, 0)).not.toThrow()
  // 该进程未被误杀。
  // A service that does not stop in time keeps the stop, so recovery does not start it again.
  // 超时未停的服务保持停机标记，自动恢复不会把它拉起来。
  rmSync(join(control('superagent'), 'manually-stopped'))
  processes(service(sleeper(true)))
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(true)
  // 超时后停机标记仍在。
}, 20_000)
