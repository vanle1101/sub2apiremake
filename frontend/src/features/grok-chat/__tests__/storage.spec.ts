import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAPIKey,
  readAPIKey,
  readConversations,
  readTheme,
  saveAPIKey,
  saveConversations,
  saveTheme,
} from '../storage'
import type { Conversation } from '../types'

describe('grok chat local storage', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('stores a remembered key only in local storage', () => {
    saveAPIKey('sk-local', true)
    expect(readAPIKey()).toBe('sk-local')
    expect(sessionStorage.length).toBe(0)
    clearAPIKey()
    expect(readAPIKey()).toBe('')
  })

  it('stores a session-only key when remember is disabled', () => {
    saveAPIKey('sk-session', false)
    expect(readAPIKey()).toBe('sk-session')
    expect(localStorage.length).toBe(0)
  })

  it('keeps only the 20 most recent conversations', () => {
    const conversations: Conversation[] = Array.from({ length: 24 }, (_, index) => ({
      id: `chat-${index}`,
      title: `Chat ${index}`,
      createdAt: index,
      updatedAt: index,
      messages: [],
    }))
    saveConversations(conversations)
    const restored = readConversations()
    expect(restored).toHaveLength(20)
    expect(restored[0].id).toBe('chat-23')
  })

  it('persists the selected color theme', () => {
    saveTheme('light')
    expect(readTheme()).toBe('light')
    saveTheme('dark')
    expect(readTheme()).toBe('dark')
  })
})
