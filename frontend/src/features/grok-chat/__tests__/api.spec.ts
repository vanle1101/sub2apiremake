import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractSSEText, generateImage, getUsage, GrokAPIError } from '../api'

describe('grok chat api', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('extracts text from OpenAI-compatible streaming chunks', () => {
    expect(extractSSEText({ choices: [{ delta: { content: 'xin chào' } }] })).toBe('xin chào')
    expect(extractSSEText({ choices: [{ delta: { content: [{ type: 'text', text: 'ảnh' }] } }] })).toBe('ảnh')
    expect(extractSSEText({ choices: [{ delta: {} }] })).toBe('')
  })

  it('authenticates usage requests with the customer key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      isValid: true,
      remaining: 12.5,
      unit: 'USD',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const usage = await getUsage('sk-customer')
    expect(usage.remaining).toBe(12.5)
    expect(fetchMock).toHaveBeenCalledWith('/v1/usage', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-customer' }),
    }))
  })

  it('normalizes base64 image generation responses into a data URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await generateImage({
      apiKey: 'sk-customer',
      prompt: 'mèo phi hành gia',
      model: 'grok-imagine-image',
      size: '1024x1024',
    })
    expect(result.url).toBe('data:image/png;base64,aW1hZ2U=')
  })

  it('returns a clear error for rejected keys', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(getUsage('bad-key')).rejects.toEqual(expect.objectContaining<GrokAPIError>({
      status: 401,
      message: 'API key không hợp lệ hoặc đã bị thu hồi.',
    }))
  })
})
