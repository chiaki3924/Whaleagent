import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function deleteRegularFileInDirectory(directory, fileName) {
  if (!fileName || path.basename(fileName) !== fileName || fileName === '.' || fileName === '..') {
    throw new Error('文件名无效。')
  }
  const directoryStat = await fs.lstat(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('报告目录不是普通目录。')
  const targetPath = path.join(directory, fileName)
  const targetStat = await fs.lstat(targetPath)
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('只允许删除普通文件。')
  await fs.unlink(targetPath)
}

export async function readUtf8FileLimited(filePath, maxBytes) {
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 })
  const chunks = []
  let total = 0
  try {
    for await (const chunk of stream) {
      total += chunk.byteLength
      if (total > maxBytes) {
        stream.destroy()
        throw new Error('文件超过读取大小限制。')
      }
      chunks.push(chunk)
    }
  } finally {
    stream.destroy()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}
