// 开机启动：把 Whaleagent 登记成当前 Windows 用户的登录启动项。
//
// 只用 Electron 自带的 app.setLoginItemSettings / app.getLoginItemSettings，不自己写注册表、
// 不建计划任务、不装服务：
// - 落点是 HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Whaleagent，属于当前用户，
//   不需要管理员权限；关掉开关就是把这一项删掉，系统里不会留下常驻服务或计划任务。
// - 便携版把整个文件夹搬走后，启动项仍指向旧路径。重新打开一次开关就能修好：
//   注册表值按名字覆盖，不会越写越多。
//
// 三个实测结论（改之前先读，都是在本机用真实 Electron 跑出来的）：
// 1. setLoginItemSettings 不会给含空格的路径加引号。直接把
//    "F:\Deepseek Harness工作区\...\Whaleagent.exe" 交给它，写进 Run 的原始值会在第一个
//    空格处被拆成 可执行文件 "F:\Deepseek" + 参数 "Harness工作区\..."，登录时自然起不来。
//    所以这里写入时自己加引号，读回时也用同一个带引号的 path 去查询（查询值与写入值一致
//    才能拿到 launchItems；否则 items 为空，界面会误报“未开启”）。
// 2. 返回的 openAtLogin 在 Windows 上不可靠：写成功了它也可能是 false。判断“会不会真的
//    启动”只能看 executableWillLaunchAtLogin，以及 launchItems[].enabled（任务管理器里
//    被禁用时它是 false，同时 StartupApproved 记成 03）。
// 3. launchItems 只按可执行文件路径过滤，不看参数。所以源码模式（exe 是 electron.exe，
//    被所有 Electron 开发项目共用）不能用这套判断，只支持打包后的 Whaleagent.exe。
//
// 这个模块不 import electron：app 由调用方注入，node --test 可以直接跑。

export const STARTUP_ITEM_NAME = 'Whaleagent'
export const STARTUP_REGISTRY_LOCATION = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
// 任务管理器 → 启动应用里显示的名字与注册表值名一致，排查时按它找。
export const STARTUP_TASK_MANAGER_HINT = '任务管理器 → 启动应用'

const UNSUPPORTED_PLATFORM = '开机启动只支持 Windows。'
const UNSUPPORTED_SOURCE = '源码模式不写启动项；打包成 Whaleagent.exe 之后这个开关才会生效。'

// 启动项里的命令行走的是 CreateProcess 的解析规则：路径含空格必须自带引号。
// Windows 路径本身不可能含双引号，所以这里只需拒绝空值和引号，不做别的转义。
export function quoteExePath(exePath) {
  const value = String(exePath || '').trim()
  if (!value) throw new Error('程序路径为空，无法设置开机启动。')
  if (value.includes('"')) throw new Error('程序路径含非法字符，无法设置开机启动。')
  return `"${value}"`
}

export function startupSupport({ platform = process.platform, isPackaged = true } = {}) {
  if (platform !== 'win32') return { supported: false, reason: UNSUPPORTED_PLATFORM }
  if (!isPackaged) return { supported: false, reason: UNSUPPORTED_SOURCE }
  return { supported: true, reason: '' }
}

// 两种写法都要查：带引号的是本模块写入的形状；不带引号的是用户手工建的形状，
// 只查一种会把“其实已经开着”误报成关闭。
export function loginItemQueries(exePath) {
  const plain = String(exePath || '').trim()
  return [{ path: quoteExePath(plain) }, { path: plain }]
}

function normalizePath(value) {
  return String(value || '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

function samePath(left, right) {
  return normalizePath(left) === normalizePath(right)
}

const EMPTY_ITEM = Object.freeze({ registered: false, enabled: false, blockedBySystem: false, entryName: '', entryPath: '', entryArgs: [] })

// 把 getLoginItemSettings 的原始结果翻译成界面要用的三个事实：
// registered（注册表里有没有这一项）、enabled（会不会真的启动）、blockedBySystem（有项但被关了）。
//
// 认“路径对得上”的 launchItems 条目，不拿 executableWillLaunchAtLogin 当“已开启”的证据：
// 路径含空格又没加引号的启动项会被拆成 F:\Deepseek + 参数，它其实根本起不来，但 Windows
// 仍会报 executableWillLaunchAtLogin=true。用它兜底等于替用户宣布一个起不来的启动项是好的。
// 反过来，有匹配条目但 executableWillLaunchAtLogin 为 false（任务管理器里被禁用）时，要如实算成“被系统关闭”。
export function describeLoginItem(info, exePath) {
  const items = Array.isArray(info?.launchItems) ? info.launchItems : []
  const entry = items.find((item) => samePath(item?.path, exePath)) || null
  const registered = Boolean(entry)
  const enabled = registered && entry.enabled !== false && info?.executableWillLaunchAtLogin !== false
  return {
    registered,
    enabled,
    blockedBySystem: registered && !enabled,
    entryName: entry?.name || '',
    entryPath: entry?.path || '',
    entryArgs: Array.isArray(entry?.args) ? entry.args.map((arg) => String(arg)) : [],
  }
}

export function createStartupManager({
  app,
  exePath,
  platform = process.platform,
  isPackaged = true,
  logger = () => {},
} = {}) {
  const support = startupSupport({ platform, isPackaged })
  const exe = String(exePath || '').trim()
  const quoted = support.supported ? quoteExePath(exe) : ''

  function snapshot(extra = {}) {
    return {
      supported: support.supported,
      reason: support.reason,
      platform,
      exePath: exe,
      command: quoted,
      itemName: STARTUP_ITEM_NAME,
      registryLocation: STARTUP_REGISTRY_LOCATION,
      taskManagerHint: STARTUP_TASK_MANAGER_HINT,
      registered: false,
      enabled: false,
      blockedBySystem: false,
      ...extra,
    }
  }

  // 读一次真实状态。任一查询命中就停，避免多花一次系统调用。
  function readItem() {
    if (!support.supported) return { ...EMPTY_ITEM }
    let seen = { ...EMPTY_ITEM }
    for (const query of loginItemQueries(exe)) {
      seen = describeLoginItem(app.getLoginItemSettings(query), exe)
      if (seen.registered) break
    }
    return seen
  }

  function status() {
    if (!support.supported) return snapshot()
    try {
      return snapshot(readItem())
    } catch (error) {
      logger('error', 'startup-status-failed', String(error?.message || error).slice(0, 200))
      return snapshot({ error: '读取开机启动状态失败，可以点「刷新」重试。' })
    }
  }

  // 写完之后必须回读确认：Windows 可能因为安全软件或启动项策略没有接受这次修改，
  // 界面上如实报错比显示一个假的“已开启”更好。
  function setEnabled(enabled) {
    if (!support.supported) throw new Error(support.reason)
    const wanted = enabled === true
    const options = { name: STARTUP_ITEM_NAME, path: quoted }
    app.setLoginItemSettings(wanted
      // enabled: true 同时把任务管理器里被禁用的项重新启用（StartupApproved 会清掉）。
      ? { ...options, openAtLogin: true, enabled: true }
      : { ...options, openAtLogin: false })
    const next = readItem()
    if (wanted && !next.enabled) {
      throw new Error(`Windows 没有接受这次设置，开机启动仍是关闭的。请到「${STARTUP_TASK_MANAGER_HINT}」里检查是否被禁用。`)
    }
    if (!wanted && next.registered) {
      throw new Error(`启动项没有被删除，可能被安全软件锁定。请稍后重试，或到「${STARTUP_TASK_MANAGER_HINT}」里手动关闭。`)
    }
    logger('info', wanted ? 'startup-enabled' : 'startup-disabled', `exe=${exe}`)
    return snapshot(next)
  }

  return { status, setEnabled }
}
