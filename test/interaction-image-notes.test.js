import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IMAGE_NOTE_MAX_CHARS,
  alignImageNotes,
  clearImageNotes,
  imageNoteCount,
  imageNoteFor,
  rememberImageNote,
} from '../src/main/interaction-image-notes.js'

test('remembers and recalls an image description', () => {
  clearImageNotes()
  const url = 'https://i0.hdslb.com/a.jpg'
  assert.equal(rememberImageNote(url, '  一只橘猫趴在键盘上  '), '一只橘猫趴在键盘上')
  assert.equal(imageNoteFor(url), '一只橘猫趴在键盘上')
  assert.equal(imageNoteCount(), 1)
  // 重新识图覆盖旧结论。
  rememberImageNote(url, '一只白猫趴在键盘上')
  assert.equal(imageNoteFor(url), '一只白猫趴在键盘上')
})

test('stores no description for empty input and never keys on empty urls', () => {
  clearImageNotes()
  assert.equal(rememberImageNote('', '描述'), '')
  assert.equal(rememberImageNote('https://i0.hdslb.com/a.jpg', '   '), '')
  assert.equal(imageNoteCount(), 0)
  assert.equal(imageNoteFor(''), '')
  assert.equal(imageNoteFor('https://i0.hdslb.com/missing.jpg'), '')
})

test('strips URLs and control characters from a description', () => {
  clearImageNotes()
  rememberImageNote('https://i0.hdslb.com/a.jpg', '截图里有个链接 https://evil.test/x 和\u0000控制符')
  const note = imageNoteFor('https://i0.hdslb.com/a.jpg')
  assert.doesNotMatch(note, /evil\.test/)
  assert.doesNotMatch(note, /\u0000/)
  assert.match(note, /截图里有个链接/)
})

test('caps the description length', () => {
  clearImageNotes()
  rememberImageNote('https://i0.hdslb.com/a.jpg', 'x'.repeat(IMAGE_NOTE_MAX_CHARS + 100))
  assert.equal(imageNoteFor('https://i0.hdslb.com/a.jpg').length, IMAGE_NOTE_MAX_CHARS)
})

test('evicts the oldest entry when the cache is full', () => {
  clearImageNotes()
  for (let index = 0; index < 205; index += 1) rememberImageNote(`https://i0.hdslb.com/${index}.jpg`, `描述${index}`)
  assert.ok(imageNoteCount() <= 200)
  assert.equal(imageNoteFor('https://i0.hdslb.com/0.jpg'), '')
  assert.equal(imageNoteFor('https://i0.hdslb.com/204.jpg'), '描述204')
})

test('aligns model-reported notes with the images actually attached', () => {
  const urls = ['https://i0.hdslb.com/1.jpg', 'https://i0.hdslb.com/2.jpg', 'https://i0.hdslb.com/3.jpg']
  const aligned = alignImageNotes([
    { index: 2, description: ' 第二张的描述 ' },
    { index: 9, description: '越界的编号必须丢掉' },
    { index: 2, description: '重复编号只取第一次' },
    { index: 1, description: '' },
  ], urls)
  assert.deepEqual(aligned, [{ url: urls[1], index: 2, description: '第二张的描述' }])
})

test('aligns nothing when there were no attached images', () => {
  assert.deepEqual(alignImageNotes([{ index: 1, description: '描述' }], []), [])
  assert.deepEqual(alignImageNotes(undefined, ['https://i0.hdslb.com/1.jpg']), [])
})
