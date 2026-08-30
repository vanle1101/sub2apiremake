import type { Conversation } from './types'

const KEY_STORAGE = 'grok-mobile.api-key'
const SESSION_KEY_STORAGE = 'grok-mobile.session-api-key'
const CONVERSATIONS_STORAGE = 'grok-mobile.conversations.v1'
const GALLERY_STORAGE = 'grok-mobile.gallery.v1'

export function readAPIKey(): string {
  return sessionStorage.getItem(SESSION_KEY_STORAGE) || localStorage.getItem(KEY_STORAGE) || ''
}

export function saveAPIKey(apiKey: string, remember: boolean): void {
  clearAPIKey()
  const target = remember ? localStorage : sessionStorage
  target.setItem(remember ? KEY_STORAGE : SESSION_KEY_STORAGE, apiKey.trim())
}

export function clearAPIKey(): void {
  localStorage.removeItem(KEY_STORAGE)
  sessionStorage.removeItem(SESSION_KEY_STORAGE)
}

export function readConversations(): Conversation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONVERSATIONS_STORAGE) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveConversations(conversations: Conversation[]): void {
  // Images can be large; retain the 20 most recently updated chats on the device.
  const recent = [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20)
  try {
    localStorage.setItem(CONVERSATIONS_STORAGE, JSON.stringify(recent))
  } catch {
    // If browser storage is full, retain text and generated image URLs only.
    const compact = recent.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => ({
        ...message,
        attachments: undefined,
      })),
    }))
    localStorage.setItem(CONVERSATIONS_STORAGE, JSON.stringify(compact))
  }
}

export function readGallery(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(GALLERY_STORAGE) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveGallery(images: string[]): void {
  try {
    localStorage.setItem(GALLERY_STORAGE, JSON.stringify(images.slice(0, 12)))
  } catch {
    // Base64 images may exceed localStorage. Keep remote URLs and newest item only.
    const compact = images.filter((image) => !image.startsWith('data:')).slice(0, 12)
    localStorage.setItem(GALLERY_STORAGE, JSON.stringify(compact))
  }
}

export function createId(prefix: string): string {
  const suffix = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${suffix}`
}
