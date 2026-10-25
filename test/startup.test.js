import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STARTUP_ITEM_NAME,
  STARTUP_REGISTRY_LOCATION,
  createStartupManager,
  describeLoginItem,
  loginItemQueries,
  quoteExePath,
  startupSupport,
} from '../src/main/startup.js'

const EXE = 'C:\\Users\\whale\\Apps\\Whaleagent-win32-x64\\Whaleagent.exe'
const SPACED_EXE = 'F:\\Deepseek Harness工作区\\whaleagent\\release\\Whaleagent-win32-x64\\Whaleagent.exe'

// 假注册表：照着本机真实 Electron 的行为写，只保留和本模块相关的部分。
// 关键一条：path 没有自带引号时，Windows 会在第一个空格处把命令行拆成 exe + 参数。
// 这正是“路径含空格时启动项失效”的成因，测试必须能复现它，否则加了引号也测不出价值。
function createFakeApp({ platform = 'win32', readFails = false, writesIgnored = false } = {}) {
  const entries = new Map()
  const calls = []

  function splitCommand(path) {
    const value = String(path || '').trim()
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1)
      return { exe: value.slice(1, end), rest: [value.slice(end + 1).trim()].filter(Boolean) }
    }
    const space = value.indexOf(' ')
    if (space === -1) return { exe: value, rest: [] }
    return { exe: value.slice(0, space), rest: [value.slice(space + 1)] }
  }

  const normalize = (value) => String(value || '').trim().replace(/^"|"$/g, '').toLowerCase()

  return {
    calls,
    entries,
    getLoginItemSettings(options = {}) {
      if (readFails) throw new Error('registry unavailable')
      const items = [...entries.values()].map((entry) => ({ ...entry, args: [...entry.args] }))
      if (!options.path) {
        return { launchItems: [], executableWillLaunchAtLogin: false, openAtLogin: false }
      }
      const wanted = normalize(options.path)
      const matched = items.filter((entry) => normalize(entry.path) === wanted)
      return {
        launchItems: matched,
        executableWillLaunchAtLogin: matched.some((entry) => entry.enabled !== false),
        openAtLogin: false,
      }
    },
    setLoginItemSettings(options = {}) {
      calls.push({ ...options })
      if (writesIgnored) return
      const name = options.name || STARTUP_ITEM_NAME
      if (options.openAtLogin === false) {
        entries.delete(name)
        return
      }
      const { exe, rest } = splitCommand(options.path)
      entries.set(name, {
        name,
        path: exe,
        args: [...rest, ...(Array.isArray(options.args) ? options.args : [])],
        scope: 'user',
        enabled: options.enabled !== false,
      })
    },
  }
}

function manager(app, overrides = {}) {
  const events = []
  const instance = createStartupManager({
    app,
    exePath: EXE,
    platform: 'win32',
    isPackaged: true,
    logger: (level, event) => events.push(`${level}:${event}`),
    ...overrides,
  })
  return { instance, events }
}

test('含空格的程序路径写入前必须自带引号', () => {
  assert.equal(quoteExePath(SPACED_EXE), `"${SPACED_EXE}"`)
  assert.equal(quoteExePath(`  ${EXE}  `), `"${EXE}"`)
  assert.throws(() => quoteExePath(''), /路径为空/)
  assert.throws(() => quoteExePath('C:\\a"b\\Whaleagent.exe'), /非法字符/)
})

test('只支持 Windows 打包版；源码模式给出可读理由', () => {
  assert.deepEqual(startupSupport({ platform: 'win32', isPackaged: true }), { supported: true, reason: '' })
  assert.equal(startupSupport({ platform: 'darwin', isPackaged: true }).supported, false)
  assert.match(startupSupport({ platform: 'linux', isPackaged: true }).reason, /只支持 Windows/)
  const source = startupSupport({ platform: 'win32', isPackaged: false })
  assert.equal(source.supported, false)
  assert.match(source.reason, /源码模式/)
})

test('开启后回读确认，且路径含空格时写入的是带引号的命令', () => {
  const app = createFakeApp()
  const { instance, events } = manager(app, { exePath: SPACED_EXE })
  const before = instance.status()
  assert.equal(before.supported, true)
  assert.equal(before.enabled, false)
  assert.equal(before.registered, false)

  const after = instance.setEnabled(true)
  assert.equal(after.enabled, true)
  assert.equal(after.registered, true)
  assert.equal(after.blockedBySystem, false)
  assert.equal(after.command, `"${SPACED_EXE}"`)
  assert.equal(app.entries.get(STARTUP_ITEM_NAME).path, SPACED_EXE)
  assert.deepEqual(app.entries.get(STARTUP_ITEM_NAME).args, [])
  assert.ok(events.includes('info:startup-enabled'))
})

test('不加引号会被 Windows 拆成两段，这就是必须自己加引号的原因', () => {
  const app = createFakeApp()
  app.setLoginItemSettings({ openAtLogin: true, name: STARTUP_ITEM_NAME, path: SPACED_EXE })
  // 复现系统行为：exe 被截断到第一个空格，剩下的部分变成参数。
  assert.equal(app.entries.get(STARTUP_ITEM_NAME).path, 'F:\\Deepseek')
  assert.deepEqual(app.entries.get(STARTUP_ITEM_NAME).args, ['Harness工作区\\whaleagent\\release\\Whaleagent-win32-x64\\Whaleagent.exe'])
  // 这样写进去的启动项，按完整路径（无论加不加引号）都查不到——登录时也起不来。
  assert.equal(app.getLoginItemSettings({ path: SPACED_EXE }).launchItems.length, 0)
  assert.equal(app.getLoginItemSettings({ path: `"${SPACED_EXE}"` }).launchItems.length, 0)

  // 换成带引号的写法后，exe 完整、参数为空，查询也就能对上了。
  const fixed = createFakeApp()
  fixed.setLoginItemSettings({ openAtLogin: true, name: STARTUP_ITEM_NAME, path: `"${SPACED_EXE}"` })
  assert.equal(fixed.entries.get(STARTUP_ITEM_NAME).path, SPACED_EXE)
  assert.deepEqual(fixed.entries.get(STARTUP_ITEM_NAME).args, [])
  assert.equal(fixed.getLoginItemSettings({ path: `"${SPACED_EXE}"` }).launchItems.length, 1)
})

test('关闭时删掉启动项并回读确认', () => {
  const app = createFakeApp()
  const { instance, events } = manager(app)
  instance.setEnabled(true)
  assert.equal(app.entries.size, 1)

  const off = instance.setEnabled(false)
  assert.equal(off.enabled, false)
  assert.equal(off.registered, false)
  assert.equal(app.entries.size, 0)
  assert.ok(events.includes('info:startup-disabled'))
  // 关闭时不能顺手把 enabled:true 传进去，否则等于又把它启用了。
  const lastCall = app.calls.at(-1)
  assert.equal(lastCall.openAtLogin, false)
  assert.equal('enabled' in lastCall, false)
})

test('任务管理器里被禁用时如实标成“被系统关闭”，重新打开开关能修好', () => {
  const app = createFakeApp()
  const { instance } = manager(app)
  instance.setEnabled(true)
  // 模拟用户在任务管理器里把这一项关掉：Run 值还在，StartupApproved 记成 03。
  app.entries.get(STARTUP_ITEM_NAME).enabled = false

  const blocked = instance.status()
  assert.equal(blocked.registered, true)
  assert.equal(blocked.enabled, false)
  assert.equal(blocked.blockedBySystem, true)

  const fixed = instance.setEnabled(true)
  assert.equal(fixed.enabled, true)
  assert.equal(fixed.blockedBySystem, false)
})

test('Windows 没有接受写入时报错，而不是显示一个假的“已开启”', () => {
  const app = createFakeApp({ writesIgnored: true })
  const { instance } = manager(app)
  assert.throws(() => instance.setEnabled(true), /没有接受这次设置/)
  assert.equal(instance.status().enabled, false)
})

test('启动项删不掉时报错，并提示去任务管理器处理', () => {
  const app = createFakeApp()
  const { instance } = manager(app)
  instance.setEnabled(true)
  // 模拟安全软件锁住 Run 值：删除请求被吞掉。
  const original = app.setLoginItemSettings
  app.setLoginItemSettings = (options) => { if (options.openAtLogin === false) return; original(options) }
  assert.throws(() => instance.setEnabled(false), /没有被删除/)
})

test('读取失败时返回可重试的错误，而不是抛给界面', () => {
  const app = createFakeApp({ readFails: true })
  const { instance, events } = manager(app)
  const status = instance.status()
  assert.equal(status.supported, true)
  assert.match(status.error, /读取开机启动状态失败/)
  assert.equal(status.enabled, false)
  assert.ok(events.includes('error:startup-status-failed'))
})

test('非 Windows 与源码模式：状态可读但不提供开关，写入直接拒绝', () => {
  for (const options of [{ platform: 'darwin' }, { platform: 'win32', isPackaged: false }]) {
    const app = createFakeApp()
    const { instance } = manager(app, options)
    const status = instance.status()
    assert.equal(status.supported, false)
    assert.equal(status.reason.length > 0, true)
    assert.equal(status.enabled, false)
    assert.throws(() => instance.setEnabled(true), /只支持 Windows|源码模式/)
    assert.equal(app.calls.length, 0)
  }
})

test('查询顺序：先查带引号写法，再退回手工创建的不带引号写法', () => {
  assert.deepEqual(loginItemQueries(EXE), [{ path: `"${EXE}"` }, { path: EXE }])
  const app = createFakeApp()
  // 用户手工在 Run 里加了一条不带引号的（路径没有空格才可能有效）。
  app.setLoginItemSettings({ openAtLogin: true, name: STARTUP_ITEM_NAME, path: EXE })
  const { instance } = manager(app)
  const status = instance.status()
  assert.equal(status.registered, true)
  assert.equal(status.enabled, true)
})

test('describeLoginItem 把原始结果翻译成 registered / enabled / blockedBySystem', () => {
  const entry = { name: 'Whaleagent', path: EXE, args: [], scope: 'user', enabled: true }
  assert.deepEqual(describeLoginItem({ launchItems: [entry], executableWillLaunchAtLogin: true }, EXE), {
    registered: true,
    enabled: true,
    blockedBySystem: false,
    entryName: 'Whaleagent',
    entryPath: EXE,
    entryArgs: [],
  })
  const disabled = describeLoginItem({ launchItems: [{ ...entry, enabled: false }], executableWillLaunchAtLogin: false }, EXE)
  assert.equal(disabled.registered, true)
  assert.equal(disabled.blockedBySystem, true)
  // 路径大小写和末尾斜杠不该影响判断。
  assert.equal(describeLoginItem({ launchItems: [{ ...entry, path: EXE.toUpperCase() }] }, EXE).registered, true)
  // 别的 exe 的启动项不算。
  assert.equal(describeLoginItem({ launchItems: [{ ...entry, path: 'C:\\other\\app.exe' }] }, EXE).registered, false)
})

test('状态里带上界面要展示的名称、命令行与登记位置', () => {
  const app = createFakeApp()
  const { instance } = manager(app)
  const status = instance.status()
  assert.equal(status.itemName, 'Whaleagent')
  assert.equal(status.registryLocation, STARTUP_REGISTRY_LOCATION)
  assert.equal(status.command, `"${EXE}"`)
  assert.equal(status.taskManagerHint, '任务管理器 → 启动应用')
  assert.match(STARTUP_REGISTRY_LOCATION, /^HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run$/)
})
