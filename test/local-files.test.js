import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readUtf8FileLimited, deleteRegularFileInDirectory } from '../src/main/local-files.js'

test('deletes only a regular file inside the report directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-delete-'))
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-outside-'))
  const regular = path.join(dir, 'report.md')
  const outside = path.join(outsideDir, 'outside.md')
  const link = path.join(dir, 'linked.md')
  try {
    await fs.writeFile(regular, 'report')
    await fs.writeFile(outside, 'outside')
    await deleteRegularFileInDirectory(dir, 'report.md')
    await assert.rejects(fs.stat(regular), { code: 'ENOENT' })
    await assert.rejects(deleteRegularFileInDirectory(dir, '../outside.md'), /文件名无效/)
    try {
      await fs.symlink(outside, link, 'file')
      await assert.rejects(deleteRegularFileInDirectory(dir, 'linked.md'), /普通文件/)
      assert.equal(await fs.readFile(outside, 'utf8'), 'outside')
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error
    }
    const directoryLink = path.join(outsideDir, 'reports-link')
    try {
      await fs.symlink(dir, directoryLink, 'junction')
      await assert.rejects(deleteRegularFileInDirectory(directoryLink, 'report.md'), /普通目录/)
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(outsideDir, { recursive: true, force: true })
  }
})

test('reads UTF-8 files up to the byte limit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-report-'))
  const file = path.join(dir, 'report.md')
  try {
    const text = '# 标题\n正文'
    await fs.writeFile(file, text)
    assert.equal(await readUtf8FileLimited(file, Buffer.byteLength(text)), text)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('stops reading once the file crosses the configured byte limit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-report-'))
  const file = path.join(dir, 'large.md')
  try {
    await fs.writeFile(file, Buffer.alloc(4 * 1024 * 1024, 0x61))
    await assert.rejects(readUtf8FileLimited(file, 1024 * 1024), /超过读取大小限制/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
