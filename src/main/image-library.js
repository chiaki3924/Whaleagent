// 私信配图的本地图片库。
//
// 设计约定（与用户确认过）：
// - 图片放在数据目录的 images 子文件夹里，文件名就是这张图的含义。
// - 只把“文件名有意义”的图告诉模型；`IMG_2043.jpg`、`微信图片_20240101.jpg`
//   这类名字看不出内容的图直接忽略，不读图、不进候选列表。
// - 是否配图由模型自己判断，我们只提供候选和约束。
//
// 不读图片内容：仅凭文件名。这样不需要视觉模型，也不会把整个图片库传出去。
import fsp from 'node:fs/promises'
import path from 'node:path'

// 一次最多给模型看多少张，避免提示词无限膨胀。
export const IMAGE_LIBRARY_MAX_ITEMS = 40
// 文件名（去掉扩展名后）最多保留多少字符作为描述。
export const IMAGE_LIBRARY_MAX_NAME_CHARS = 60
// 允许上传的图片扩展名。
export const IMAGE_LIBRARY_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g

// 这些名字是相机/手机/截图工具自动生成的，看不出图片内容。
const MEANINGLESS_PATTERNS = [
  // IMG_2043 / DSC01234 / DSCF1234 / DJI_0012 / PXL_20240101_123456 / GOPR0001
  /^(img|image|dsc|dscf|dscc|dji|gopr|gopro|pxl|mvimg|vid|dav|mvi|pic|photo|picture)[\s_-]*\d+$/i,
  // P1234567（部分安卓）
  /^p\d{6,}$/i,
  // 纯数字 / 时间戳 / 十位以上十六进制（哈希、uuid 片段）
  /^\d+$/,
  /^\d{10,17}$/,
  /^[0-9a-f]{16,}$/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // 截图工具的默认命名
  /^(screenshot|screen[\s_-]*shot|snipaste|snip|capture|clipboard)/i,
  /^(截图|屏幕截图|屏幕快照|截屏)[\s_-]*[\d\s_-]*$/,
  /^(微信图片|微信截图|qq图片|qq截图|钉钉截图|企业微信截图)/i,
  /^(mmexport|wx_camera)/i,
  // 完全通用的词（允许带“图片/照片”后缀和序号）
  /^(untitled|unnamed|未命名|新建|无标题|图片|照片|图像|默认)[\s_-]*\d*$/i,
  /^(新建|未命名|无标题)[\s_-]*(图片|照片|图像|文件|文档)[\s_-]*\d*$/i,
  /^(图片|照片|图像)[\s_-]*\d+$/i,
  /^copy(\s*\(\d+\))?$/i,
  /^new[\s_-]*file/i,
]

function stripExtension(fileName) {
  const ext = path.extname(fileName)
  return ext ? fileName.slice(0, -ext.length) : fileName
}

function isImageFile(fileName) {
  return IMAGE_LIBRARY_EXTENSIONS.includes(path.extname(fileName).toLowerCase())
}

// 把文件名整理成给人/模型看的一句描述：分隔符变空格，压缩空白。
export function describeImageName(fileName) {
  const raw = stripExtension(String(fileName || ''))
    .replace(CONTROL_CHARS, '')
    .replace(/[_\-.·]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return raw.slice(0, IMAGE_LIBRARY_MAX_NAME_CHARS)
}

// 文件名是否有意义。宁严勿宽：看不懂的图宁可不发，也不要让模型对着 `IMG_2043` 猜。
export function isMeaningfulImageName(fileName) {
  if (!isImageFile(fileName)) return false
  const base = stripExtension(String(fileName || '')).replace(CONTROL_CHARS, '').trim()
  if (!base) return false
  const normalized = base.replace(/[_\-.·]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!normalized) return false
  // 去掉分隔符后的紧凑形式用于匹配相机默认名（IMG_2043 → IMG2043 也认）。
  const compact = normalized.replace(/\s+/g, '')
  if (MEANINGLESS_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(compact))) return false
  // 至少要有点“词”的信息量：2 个以上汉字，或 3 个以上连续字母。
  const cjk = (normalized.match(/[\u4e00-\u9fa5]/g) || []).length
  if (cjk >= 2) return true
  if (/[a-z]{3,}/i.test(normalized)) return true
  return false
}

// 扫描图片库。目录不存在时返回空列表，不报错（用户可能还没放图）。
export async function listLibraryImages({ dir, readdir = fsp.readdir, max = IMAGE_LIBRARY_MAX_ITEMS } = {}) {
  if (!dir) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const names = entries
    .filter((entry) => entry?.isFile?.() && isMeaningfulImageName(entry.name))
    .map((entry) => entry.name)
    // 按名字排序，保证同一批图片每次得到的 id 一致，模型看到的顺序也稳定。
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  return names.slice(0, Math.max(0, max)).map((fileName, index) => ({
    id: String(index + 1),
    fileName,
    path: path.join(dir, fileName),
    description: describeImageName(fileName),
  }))
}

// 模型回传的 id 必须落在本次候选列表里，不能拿它去拼任意路径。
export function resolveLibraryImage(images, id) {
  const key = String(id ?? '').trim()
  if (!key) return null
  return (Array.isArray(images) ? images : []).find((image) => image.id === key) || null
}

// 给模型看的候选列表：只要 id 和描述，不带磁盘路径。
export function buildImageLibraryPayload(images) {
  return (Array.isArray(images) ? images : []).map((image) => ({
    id: image.id,
    name: image.description,
  }))
}

// 读取图片字节用于上传。限制体积，避免误放几十 MB 的图把内存撑爆。
export async function readLibraryImage(image, { readFile = fsp.readFile, maxBytes = 20_000_000 } = {}) {
  if (!image?.path) throw new Error('图片路径无效。')
  const buffer = await readFile(image.path)
  if (!buffer?.byteLength) throw new Error('图片文件为空。')
  if (buffer.byteLength > maxBytes) throw new Error(`图片超过 ${Math.round(maxBytes / 1_000_000)} MB 上限。`)
  return buffer
}

// 日志用：只报数量，不报文件名（文件名可能带用户自己的描述）。
export function describeImageLibrary(images) {
  const count = Array.isArray(images) ? images.length : 0
  return count ? `可用图片 ${count} 张` : '图片库为空'
}
