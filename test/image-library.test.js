import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  IMAGE_LIBRARY_MAX_ITEMS,
  buildImageLibraryPayload,
  describeImageName,
  describeImageLibrary,
  isMeaningfulImageName,
  listLibraryImages,
  readLibraryImage,
  resolveLibraryImage,
} from '../src/main/image-library.js'

test('treats camera and screenshot default names as meaningless', () => {
  // 相机/手机/截图工具自动生成的名字看不出内容，一律忽略。
  for (const name of [
    'IMG_2043.jpg', 'IMG2043.jpeg', 'DSC01234.JPG', 'DSCF1234.jpg', 'DJI_0012.png',
    'PXL_20240101_123456.png', 'GOPR0001.jpg', 'P1234567.jpg',
    '20240101_123456.jpg', '1699999999999.png',
    'Screenshot 2024-01-01 123456.png', 'Snipaste_2024-01-01.png',
    '截图_20240101.png', '屏幕截图 2024-01-01 123456.png',
    '微信图片_20240101123456.jpg', 'QQ图片20240101.jpg', 'mmexport1699999999.jpg',
    'untitled.png', '未命名.png', '新建图片.png', '图片1.png', 'Copy (2).png',
    'a1b2c3d4e5f60718.png', '550e8400-e29b-41d4-a716-446655440000.png',
    '12345.jpg',
  ]) {
    assert.equal(isMeaningfulImageName(name), false, `${name} 应该被忽略`)
  }
})

test('keeps names that describe the picture', () => {
  for (const name of [
    '开心.jpg', '在键盘上睡觉的橘猫.png', '加油打气.png', '晚安.jpg',
    'happy-cat.jpg', 'thumbs-up.png', '谢谢老板.gif', '干杯.webp',
  ]) {
    assert.equal(isMeaningfulImageName(name), true, `${name} 应该可用`)
  }
})

test('rejects non-image files and empty names', () => {
  assert.equal(isMeaningfulImageName('开心.txt'), false)
  assert.equal(isMeaningfulImageName('开心'), false)
  assert.equal(isMeaningfulImageName(''), false)
  assert.equal(isMeaningfulImageName('.jpg'), false)
  // 只有单字的名字信息量太低。
  assert.equal(isMeaningfulImageName('猫.jpg'), false)
})

test('builds a readable description from the file name', () => {
  assert.equal(describeImageName('在键盘上睡觉的橘猫.png'), '在键盘上睡觉的橘猫')
  assert.equal(describeImageName('happy-cat_sleeping.jpg'), 'happy cat sleeping')
  assert.equal(describeImageName('  加油打气__晚安 .png '), '加油打气 晚安')
  // 描述长度有上限，避免超长文件名把提示词撑爆。
  assert.ok(describeImageName(`${'很'.repeat(200)}.png`).length <= 60)
})

test('lists only meaningful images with stable ids, sorted by name', async () => {
  const entries = [
    { name: '开心.jpg', isFile: () => true },
    { name: 'IMG_2043.jpg', isFile: () => true },
    { name: '晚安.png', isFile: () => true },
    { name: '加油.gif', isFile: () => true },
    { name: '子目录', isFile: () => false },
  ]
  const images = await listLibraryImages({ dir: '/images', readdir: async () => entries })
  assert.deepEqual(images.map((image) => image.fileName), ['加油.gif', '开心.jpg', '晚安.png'])
  // id 从 1 开始且连续，模型只需要回一个短 id。
  assert.deepEqual(images.map((image) => image.id), ['1', '2', '3'])
  // 不把磁盘路径给模型，只在内部保留。
  assert.deepEqual(buildImageLibraryPayload(images), [
    { id: '1', name: '加油' },
    { id: '2', name: '开心' },
    { id: '3', name: '晚安' },
  ])
  // 内部路径用 path.join 拼（Windows 上是反斜杠），断言文件名而不是分隔符。
  assert.ok(images.every((image) => path.basename(image.path) === image.fileName))
})

test('returns an empty library when the folder does not exist yet', async () => {
  const missing = await listLibraryImages({ dir: '/nope', readdir: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error } })
  assert.deepEqual(missing, [])
  assert.deepEqual(await listLibraryImages({ dir: '' }), [])
  assert.equal(describeImageLibrary(missing), '图片库为空')
})

test('caps how many images are offered to the model', async () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({ name: `图片说明${String(index).padStart(3, '0')}.jpg`, isFile: () => true }))
  const images = await listLibraryImages({ dir: '/images', readdir: async () => entries })
  assert.equal(images.length, IMAGE_LIBRARY_MAX_ITEMS)
})

test('resolves only ids that are actually in the candidate list', () => {
  const images = [{ id: '1', path: '/images/a.jpg' }, { id: '2', path: '/images/b.jpg' }]
  assert.equal(resolveLibraryImage(images, '2').path, '/images/b.jpg')
  assert.equal(resolveLibraryImage(images, 1).path, '/images/a.jpg')
  // 越界、空值、路径穿越都不认。
  assert.equal(resolveLibraryImage(images, '3'), null)
  assert.equal(resolveLibraryImage(images, ''), null)
  assert.equal(resolveLibraryImage(images, '../../secret'), null)
  assert.equal(resolveLibraryImage(null, '1'), null)
})

test('reads image bytes with a size limit', async () => {
  const bytes = await readLibraryImage({ path: '/images/a.png' }, { readFile: async () => Buffer.from('abc') })
  assert.equal(bytes.toString(), 'abc')
  await assert.rejects(
    readLibraryImage({ path: '/images/big.png' }, { readFile: async () => Buffer.alloc(200), maxBytes: 100 }),
    /上限/,
  )
  await assert.rejects(readLibraryImage({ path: '' }, { readFile: async () => Buffer.alloc(1) }), /路径无效/)
})
