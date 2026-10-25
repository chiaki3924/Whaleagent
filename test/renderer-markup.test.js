import test from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const readRendererFile = (name) => readFile(new URL(`../src/renderer/${name}`, import.meta.url), 'utf8')

test('B站读取默认勾选关键词搜索、关注动态和首页推荐', async () => {
  const html = await readRendererFile('index.html')
  for (const id of ['source-keyword', 'source-following', 'source-homepage']) {
    assert.match(html, new RegExp(`<input id="${id}" type="checkbox" checked>`))
  }
})

test('B站读取页提供自动读取时间窗和间隔控件', async () => {
  const html = await readRendererFile('index.html')
  assert.match(html, /自动读取时间窗（默认无）/)
  assert.match(html, /id="reading-windows" class="interaction-windows"/)
  assert.match(html, /id="add-reading-window"/)
  assert.match(html, /id="reading-auto-interval" type="number" min="0" max="1440"/)
  assert.match(html, /id="reading-window-status" class="interaction-status"/)
  assert.match(html, /id="reading-auto-status" class="reading-auto-status"/)
  assert.match(html, /id="reading-auto-source" class="reading-auto-status"/)
})

test('渲染层保存自动读取设置并轮询运行状态', async () => {
  const source = await readRendererFile('renderer.js')
  assert.match(source, /await window\.whaleagent\.saveReadingConfig\(\{/)
  assert.match(source, /await window\.whaleagent\.readingStatus\(\)/)
  assert.match(source, /setInterval\(refreshReadingStatus, 30_000\)/)
  assert.match(source, /reading-auto-status/)
})

test('手动获取候选和 AI 筛选不受自动读取时间窗限制', async () => {
  const source = await readRendererFile('renderer.js')
  assert.doesNotMatch(source, /readingAllowed/)
  assert.match(source, /\$\('bili-search'\)\.disabled = !biliLoggedIn\n/)
  assert.match(source, /canAnalyze\(\{ modelReady, biliLoggedIn, selectedCount: selectedBvids\.size \}\)/)
})

test('B站读取页提供筛选规则和报告私信控件', async () => {
  const html = await readRendererFile('index.html')
  assert.match(html, /<input id="skip-no-subtitle" type="checkbox" checked>/)
  assert.match(html, /id="title-exclude" type="text" maxlength="100" value="666，炸裂，外网，热议，为什么，为何，？"/)
  assert.match(html, /<input id="report-dm-enabled" type="checkbox">/)
  assert.match(html, /id="report-dm-note"/)
  assert.match(html, /id="report-dm-status"/)
  assert.match(html, /标题包含任意一个词的视频会在调用模型前跳过/)
  // 发布时间窗：界面上只有一个数字，记录保留期由代码推导后回显。
  assert.match(html, /id="max-age-days" type="number" min="0" max="30" step="1" value="7"/)
  assert.match(html, /id="age-window-note"/)
  assert.match(html, /只看最近几天发布的视频/)
})

test('渲染层把筛选规则和报告私信一起自动保存并展示状态', async () => {
  const source = await readRendererFile('renderer.js')
  assert.match(source, /screen: \{\n\s+skipNoSubtitle: \$\('skip-no-subtitle'\)\.checked,/)
  assert.match(source, /titleExclude: \$\('title-exclude'\)\.value,/)
  assert.match(source, /maxAgeDays: \$\('max-age-days'\)\.value,/)
  assert.match(source, /reportDm: \{ enabled: \$\('report-dm-enabled'\)\.checked \},/)
  assert.match(source, /\$\('title-exclude'\)\.addEventListener\('input', scheduleReadingSave\)/)
  assert.match(source, /\$\('max-age-days'\)\.addEventListener\('input', scheduleReadingSave\)/)
  assert.match(source, /\$\('report-dm-enabled'\)\.addEventListener\('change', scheduleReadingSave\)/)
  assert.match(source, /renderReportDmState\(state\)/)
  assert.match(source, /renderAgeWindowNote\(state\)/)
  assert.match(source, /result\.dm\?\.sent/)
})

test('预加载脚本只额外暴露自动读取相关接口', async () => {
  const source = await readFile(new URL('../src/preload/index.cjs', import.meta.url), 'utf8')
  assert.match(source, /readingStatus: \(\) => ipcRenderer\.invoke\('bili:reading-status'\)/)
  assert.match(source, /saveReadingConfig: \(config\) => ipcRenderer\.invoke\('bili:reading-config-save', config\)/)
})

test('日记页提供两本日记、自动写入开关和保留天数', async () => {
  const html = await readRendererFile('index.html')
  assert.match(html, /data-panel="diary">日记</)
  for (const id of ['diary-enabled', 'diary-auto', 'diary-public', 'diary-private']) {
    assert.match(html, new RegExp(`<input id="${id}" type="checkbox">`))
  }
  assert.match(html, /id="diary-time" type="time"/)
  assert.match(html, /id="diary-retention" type="number" min="1" max="365"/)
  assert.match(html, /id="diary-public-list" class="diary-list"/)
  assert.match(html, /id="diary-private-list" class="diary-list"/)
  assert.match(html, /给主人看的日记/)
  assert.match(html, /给自己看的日记/)
  assert.match(html, /只保留最近/)
})

test('渲染层使用 textContent 渲染日记并轮询状态', async () => {
  const source = await readRendererFile('renderer.js')
  assert.match(source, /await window\.whaleagent\.diaryStatus\(\)/)
  assert.match(source, /await window\.whaleagent\.listDiaries\(\)/)
  assert.match(source, /await window\.whaleagent\.saveDiaryConfig\(/)
  assert.match(source, /await window\.whaleagent\.writeDiaryNow\(\)/)
  assert.match(source, /setInterval\(refreshDiaryStatus, 30_000\)/)
  assert.match(source, /text\.textContent = entry\.content/)
  assert.doesNotMatch(source, /innerHTML/)
})

test('预加载脚本暴露日记接口但没有额外权限', async () => {
  const source = await readFile(new URL('../src/preload/index.cjs', import.meta.url), 'utf8')
  assert.match(source, /diaryStatus: \(\) => ipcRenderer\.invoke\('diary:status'\)/)
  assert.match(source, /listDiaries: \(\) => ipcRenderer\.invoke\('diary:list'\)/)
  assert.match(source, /writeDiaryNow: \(\) => ipcRenderer\.invoke\('diary:write'\)/)
  assert.match(source, /deleteDiaryEntry: \(kind, date\) => ipcRenderer\.invoke\('diary:delete-entry', kind, date\)/)
  assert.doesNotMatch(source, /nodeIntegration|require\('fs'\)/)
})

test('主进程把日记接到配置、状态、定时器和本地文件', async () => {
  const source = await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')
  assert.match(source, /import \{[^}]*\bexecuteDiaryGeneration\b[^}]*\} from '\.\/diary\.js'/)
  assert.match(source, /diary: readDiaryConfig\(data\.diary\)/)
  assert.match(source, /diary: normalizeDiaryConfig\(settings\?\.diary\)/)
  assert.match(source, /input\?\.diary === undefined \? existing\.diary/)
  assert.match(source, /handle\('diary:status'/)
  assert.match(source, /handle\('diary:config-save'/)
  assert.match(source, /handle\('diary:write'/)
  assert.match(source, /setInterval\(\(\) => void tickDiaryAuto\(\), 30_000\)/)
  assert.match(source, /diaryAutoTimer = null/)
  assert.match(source, /await pruneDiaryFiles\(\)/)
  assert.match(source, /const DIARY_DIR = \(\) => DATA_LAYOUT\.diariesDir/)
})

test('内容偏好移到提示词页，B站读取页只保留摘要', async () => {
  const html = await readRendererFile('index.html')
  assert.match(html, /<h3 id="content-preferences-title">内容偏好<\/h3>/)
  assert.match(html, /<textarea id="content-preferences" class="persona-input" maxlength="1200"/)
  assert.match(html, /id="content-preferences-save"/)
  assert.match(html, /id="content-preferences-count"/)
  assert.match(html, /id="preferences-summary"/)
  assert.doesNotMatch(html, /<textarea id="preferences"/)
  assert.match(html, /只用于视频筛选，不影响自动回复、日记和报告私信的口吻/)
})

test('渲染层保存内容偏好并同步到 B站读取页摘要', async () => {
  const source = await readRendererFile('renderer.js')
  assert.match(source, /await window\.whaleagent\.saveContentPreferences\(\$\('content-preferences'\)\.value\)/)
  assert.match(source, /applyPreferencesState\(state\)/)
  assert.match(source, /\$\('preferences-summary'\)\.textContent/)
  assert.match(source, /renderPreferencesNote\(\)/)
  assert.doesNotMatch(source, /\$\('preferences'\)\.value/)
})

test('主进程把内容偏好接到提示词页和筛选流程', async () => {
  const source = await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')
  assert.match(source, /preferences: settings\.preferences,\n\s+maxCustomChars/)
  assert.match(source, /handle\('prompt:save-preferences'/)
  assert.match(source, /lastRead: settings\.readingLastRead,\n\s+preferences: settings\.preferences,/)
  assert.match(source, /input\?\.preferences === undefined \? existing\.preferences/)
})

test('主进程接收带来源的所选视频并区分关注来源', async () => {
  const source = await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')
  const preload = await readFile(new URL('../src/preload/index.cjs', import.meta.url), 'utf8')
  assert.match(source, /Array\.isArray\(input\?\.videos\)/)
  assert.match(source, /followed: video\.followed/)
  assert.match(preload, /saveContentPreferences: \(value\) => ipcRenderer\.invoke\('prompt:save-preferences', value\)/)
})

test('主进程在保存报告后按设置投递私信，并把筛选规则接入读取流程', async () => {
  const source = await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')
  assert.match(source, /from '\.\/screening\.js'/)
  assert.match(source, /from '\.\/report-dm\.js'/)
  assert.match(source, /screen: readScreenConfig\(data\.screen\)/)
  assert.match(source, /reportDm: normalizeReportDmConfig\(data\.reportDm\)/)
  assert.match(source, /screen: settings\.screen/)
  assert.match(source, /deliverReport: \(\{ name, content \}\) => deliverReportDm/)
  assert.match(source, /handle\('report:save', \(input\) => saveReportAndDeliver\(input\)\)/)
  assert.match(source, /sendPrivateMessageTo\(credential, account\.mid, receiverUid, text\)/)
  assert.match(source, /if \(titleExcluded\(detail\?\.title, screen\.titleExclude\)\)/)
  assert.match(source, /if \(screen\.skipNoSubtitle && !detail\?\.subtitle\)/)
})

test('主进程按发布时间窗过滤候选，并让已推荐记录跟着窗口过期', async () => {
  const source = await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')
  // 保留期由发布时间窗推导，界面上的一个数字决定两个值。
  assert.match(source, /historyRetentionDays\(settings\.screen\.maxAgeDays\)/)
  assert.match(source, /historyRetentionSetting\(\)/)
  assert.match(source, /pruneHistoryFile\(HISTORY_PATH\(\), \{ retentionDays: historyRetentionDays\(screen\.maxAgeDays\) \}\)/)
  assert.match(source, /historyRetentionDays: historyRetentionDays\(settings\.screen\.maxAgeDays\)/)
  // 自动读取把保留期传给历史读取，并且只记录 agent 选进报告的 3 条。
  assert.match(source, /readHistory: \(options = \{\}\) => readHistory\(HISTORY_PATH\(\), options\)/)
  assert.match(source, /relatedVideoIds: result\.recommendedBvids \|\| result\.selectedBvids \|\| result\.analyzedBvids/)
  // 手动分析也守发布时间窗。
  assert.match(source, /publishedTooOld\(published, screen\.maxAgeDays, now\)/)
  assert.match(source, /recommendedBvids: result\.selectedBvids \|\| result\.analyzedBvids/)
})

test('模型设置页把已保存的模型列成列表，并提供独立编辑子页', async () => {
  const html = await readRendererFile('index.html')
  // 列表区：一个模型一张卡片，外加“新增模型”入口和调用顺序说明。
  assert.match(html, /id="model-list" class="model-list"/)
  assert.match(html, /id="model-list-empty"/)
  assert.match(html, /id="model-chain-note"/)
  assert.match(html, /id="add-model" type="button"/)
  // 编辑子页：原来的连接、模型、生成参数控件都搬进了 #model-editor。
  const editorStart = html.indexOf('id="model-editor"')
  assert.ok(editorStart > 0, '缺少模型编辑子页')
  const editor = html.slice(editorStart)
  assert.match(editor, /id="close-model-editor" type="button"/)
  assert.match(editor, /id="provider-name" type="text" maxlength="60"/)
  assert.match(editor, /id="request-format"/)
  assert.match(editor, /<option value="openai" selected>\[OI\] 兼容/)
  assert.match(editor, /id="api-key" type="password"/)
  assert.match(editor, /id="check-models" type="button"/)
  assert.match(editor, /id="model-picker" class="model-picker hidden"/)
  assert.match(editor, /id="model-filter"/)
  assert.match(editor, /id="model-options" class="model-options" role="listbox"/)
  assert.match(editor, /id="temperature" type="number" min="0" max="2" step="0.1" value="0.7"/)
  assert.match(editor, /id="temperature-up" type="button"/)
  assert.match(editor, /id="temperature-down" type="button"/)
  assert.match(editor, /class="number-stepper"/)
  assert.match(editor, /id="vision-mode"/)
  assert.match(editor, /<option value="auto" selected>自动检测/)
  assert.match(editor, /<option value="image">支持图片/)
  assert.match(editor, /<option value="text">纯文本/)
  assert.match(editor, /id="save-model"/)
  assert.match(editor, /id="test-model"/)
  assert.match(editor, /id="delete-model"/)
  assert.match(editor, /id="model-editor-status"/)
  // 单个模型设置不再有全局“保存设置”按钮，互动设置单独保存。
  assert.doesNotMatch(html, /id="save-settings"/)
  assert.match(html, /id="save-interaction"/)
  assert.match(html, /id="model-state-badge"/)
  assert.match(html, /id="settings-status"/)
})

test('渲染层渲染模型列表、打开编辑子页并按档案保存', async () => {
  const source = await readRendererFile('renderer.js')
  assert.match(source, /function renderModelList\(/)
  assert.match(source, /function openModelEditor\(id = ''\)/)
  assert.match(source, /function closeModelEditor\(\)/)
  assert.match(source, /function applyModelState\(state\)/)
  assert.match(source, /await window\.whaleagent\.saveModelProfile\(\{/)
  assert.match(source, /await window\.whaleagent\.deleteModelProfile\(/)
  assert.match(source, /await window\.whaleagent\.saveModelChain\(/)
  assert.match(source, /providerName: \$\('provider-name'\)\.value,/)
  assert.match(source, /requestFormat: \$\('request-format'\)\.value,/)
  assert.match(source, /temperature: \$\('temperature'\)\.value,/)
  assert.match(source, /visionMode: \$\('vision-mode'\)\.value,/)
  assert.match(source, /await window\.whaleagent\.listModels\(\{/)
  assert.match(source, /await window\.whaleagent\.testModel\(\{/)
  assert.match(source, /id: editingModelId,\s*\n\s*providerName: \$\('provider-name'\)\.value,/)
  assert.match(source, /baseUrl: \$\('base-url'\)\.value,\s*\n\s*model: \$\('model'\)\.value,\s*\n\s*apiKey: \$\('api-key'\)\.value,/)
  assert.match(source, /function renderModelOptions\(/)
  assert.match(source, /function renderVisionNote\(/)
  assert.match(source, /setModelPickerOpen\(true\)/)
  assert.match(source, /first\.click\(\)/)
  assert.match(source, /normalizeTemperatureField/)
  assert.match(source, /function stepTemperature\(delta\)/)
  assert.match(source, /\$\('temperature-up'\)\.addEventListener\('click', \(\) => stepTemperature\(0\.1\)\)/)
  assert.match(source, /\$\('temperature-down'\)\.addEventListener\('click', \(\) => stepTemperature\(-0\.1\)\)/)
  assert.match(source, /applyModelReadiness\(/)
  assert.doesNotMatch(source, /innerHTML/)
})

test('主进程和预加载脚本接入多模型档案与备用模型链路', async () => {
  const source = await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')
  const preload = await readFile(new URL('../src/preload/index.cjs', import.meta.url), 'utf8')
  assert.match(preload, /listModels: \(input\) => ipcRenderer\.invoke\('model:list', input\)/)
  assert.match(preload, /saveModelProfile: \(profile\) => ipcRenderer\.invoke\('model:profile-save', profile\)/)
  assert.match(preload, /deleteModelProfile: \(id\) => ipcRenderer\.invoke\('model:profile-delete', id\)/)
  assert.match(preload, /saveModelChain: \(chain\) => ipcRenderer\.invoke\('model:chain-save', chain\)/)
  assert.match(preload, /deleteModelApiKey: \(id\) => ipcRenderer\.invoke\('settings:delete-api-key', id\)/)
  assert.match(source, /handle\('model:list', \(input\) => listProviderModels\(input\)\)/)
  assert.match(source, /handle\('model:profile-save', \(input\) => saveModelProfile\(input\)\)/)
  assert.match(source, /handle\('model:chain-save', \(input\) => setModelChain\(input\)\)/)
  assert.match(source, /import \{ fetchProviderModels \} from '\.\/model-list\.js'/)
  assert.match(source, /from '\.\/model-profiles\.js'/)
  assert.match(source, /import \{ runModelChain \} from '\.\/model-chain\.js'/)
  assert.match(source, /const MODEL_KEYS_PATH = \(\) => path\.join\(DATA_LAYOUT\.secretsDir, 'model-keys\.bin'\)/)
  assert.match(source, /const \{ models, primaryModelId, fallbackModelId \} = readModelProfiles\(data\)/)
  assert.match(source, /modelReady: withKeys\.some\(\(profile\) => profileIsReady\(profile\)\)/)
  // 所有模型调用都经过同一条“首选 → 备用”链路。
  assert.match(source, /async function runWithModelChain\(settings, run\)/)
  const chainCalls = source.match(/await runWithModelChain\(/g) || []
  assert.ok(chainCalls.length >= 4, `模型调用没有全部走链路，实际 ${chainCalls.length} 处`)
})

test('便携版把数据目录放进程序目录，界面显示实际位置并可打开', async () => {
  const source = await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')
  const html = await readRendererFile('index.html')
  const renderer = await readRendererFile('renderer.js')
  const preload = await readFile(new URL('../src/preload/index.cjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ DATA_DIR_NAME, ensureDataLayout, markProfileReset, migrateLegacyData, profileResetBlocked, resolveDataLayout, seedRuntimeProfile \} from '\.\/app-paths\.js'/)
  assert.match(source, /const PROGRAM_DIR = app\.isPackaged \? path\.dirname\(app\.getPath\('exe'\)\) : APP_DIR/)
  assert.match(source, /resolveDataLayout\(\{/)
  assert.match(source, /if \(DATA_LAYOUT\.mode === 'portable' \|\| DATA_LAYOUT\.mode === 'custom'\) \{/)
  assert.match(source, /blocked: profileResetBlocked\(DATA_LAYOUT\),\n  \}\)\n  app\.setPath\('userData', DATA_LAYOUT\.runtimeDir\)/)
  assert.match(source, /async function ensureUsableSafeStorage\(\)/)
  assert.match(source, /await ensureUsableSafeStorage\(\)/)
  assert.match(source, /migrateLegacyData\(\{/)
  assert.match(source, /handle\('app:data-info', \(\) => dataInfo\(\)\)/)
  assert.match(source, /handle\('app:open-data-folder'/)
  assert.match(source, /dataMode=\$\{DATA_LAYOUT\.mode\} dataDir=\$\{DATA_LAYOUT\.rootDir\}/)
  assert.match(html, /id="data-location"/)
  assert.match(html, /id="open-data-folder"/)
  assert.match(html, /WhaleagentData\/reports/)
  assert.doesNotMatch(html, /文档目录的 Whaleagent\/reports/)
  assert.match(preload, /dataInfo: \(\) => ipcRenderer\.invoke\('app:data-info'\)/)
  assert.match(preload, /openDataFolder: \(\) => ipcRenderer\.invoke\('app:open-data-folder'\)/)
  assert.match(renderer, /await window\.whaleagent\.dataInfo\(\)/)
  assert.match(renderer, /await window\.whaleagent\.openDataFolder\(\)/)
  assert.match(renderer, /\nrefreshDataInfo\(\)\n/)
})

test('打包脚本不把便携数据目录打进 app.asar', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  // 版本号本身不必断言具体数字（每次发版都要改），但必须是个合法 semver。
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  // 打包入口是一个包装脚本：electron-packager 的 --overwrite 会删掉输出目录，
  // 而便携数据目录正好在里面，所以必须先备份再打包、打包后还回去。
  assert.equal(pkg.scripts['pack:win'], 'node scripts/pack-win.mjs')
  const wrapper = await readFile(new URL('../scripts/pack-win.mjs', import.meta.url), 'utf8')
  assert.match(wrapper, /ignore: \[\/\^\\\/\(test\|release\|WhaleagentData\|scripts\)/)
  assert.match(wrapper, /appVersion: version/)
  assert.match(wrapper, /overwrite: true/)
  // 这两条是防数据丢失的关键：备份发生在打包之前，还原发生在打包之后（finally 里）。
  const packAt = wrapper.indexOf('await packager({')
  assert.ok(packAt > 0)
  assert.ok(wrapper.indexOf('fs.cpSync(DATA_DIR, backupDir') < packAt)
  assert.ok(wrapper.indexOf('fs.cpSync(backupDir, DATA_DIR') > packAt)
})

test('软件更新页在提示词下方，且只通过主进程检查与安装', async () => {
  const html = await readRendererFile('index.html')
  const source = await readRendererFile('renderer.js')
  const preload = await readFile(new URL('../src/preload/index.cjs', import.meta.url), 'utf8')

  // 菜单位置：提示词之后就是软件更新。
  assert.match(html, /<button class="tab" data-panel="prompts">提示词<\/button>\s*<button class="tab" data-panel="update">软件更新<\/button>/)
  assert.match(html, /<section id="update" class="panel hidden">/)
  for (const id of ['update-check', 'update-download', 'update-apply', 'update-cancel', 'update-discard', 'update-target', 'update-notes', 'update-progress-fill']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  // 启动时不自动检查：界面只在切换页面或点按钮时取状态。
  assert.match(source, /if \(button\.dataset\.panel === 'update'\) void refreshUpdateStatus\(\)/)
  assert.doesNotMatch(source, /setInterval\(refreshUpdateStatus/)
  assert.match(preload, /checkUpdate: \(\) => ipcRenderer\.invoke\('update:check'\)/)
  assert.match(preload, /applyUpdate: \(\) => ipcRenderer\.invoke\('update:apply'\)/)
  assert.match(source, /await window\.whaleagent\.checkUpdate\(\)/)
  assert.match(source, /await window\.whaleagent\.applyUpdate\(\)/)
})

test('更新相关的 IPC、单实例锁与启动恢复都接好了', async () => {
  const source = await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')
  for (const channel of ['update:status', 'update:check', 'update:download', 'update:cancel', 'update:discard', 'update:apply', 'update:open-folder', 'update:open-releases']) {
    assert.match(source, new RegExp(`handle\\('${channel}'`))
  }
  // 两个实例同时更新会互相踩文件。
  assert.match(source, /app\.requestSingleInstanceLock\(\)/)
  assert.match(source, /if \(!HAS_SINGLE_INSTANCE\) return/)
  // 下载完待重启的包要能在重启后恢复。
  assert.match(source, /void UPDATER\.restore\(\)/)
  // 下载走 Electron 的 net.fetch，继承系统代理。
  assert.match(source, /fetchImpl: \(url, init\) => net\.fetch\(url, init\)/)
})
