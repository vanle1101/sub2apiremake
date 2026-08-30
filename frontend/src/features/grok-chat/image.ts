import type { ChatAttachment } from './types'
import { createId } from './storage'

const MAX_INPUT_BYTES = 12 * 1024 * 1024
const MAX_EDGE = 1600

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Không thể đọc ảnh.'))
    reader.readAsDataURL(file)
  })
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Định dạng ảnh không được hỗ trợ.'))
    image.src = dataUrl
  })
}

export async function prepareImage(file: File): Promise<ChatAttachment> {
  if (!file.type.startsWith('image/')) throw new Error('Chỉ hỗ trợ tệp ảnh.')
  if (file.size > MAX_INPUT_BYTES) throw new Error('Ảnh phải nhỏ hơn 12 MB.')

  const original = await readFile(file)
  const image = await loadImage(original)
  const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height))
  let dataUrl = original
  let mimeType = file.type

  if (scale < 1 || file.size > 2.5 * 1024 * 1024) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Trình duyệt không thể xử lý ảnh.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    mimeType = 'image/jpeg'
    dataUrl = canvas.toDataURL(mimeType, 0.84)
  }

  return {
    id: createId('image'),
    name: file.name,
    dataUrl,
    mimeType,
  }
}
