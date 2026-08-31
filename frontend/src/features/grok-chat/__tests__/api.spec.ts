import { beforeEach, describe, expect, it, vi } from 'vitest'
import { editImage, extractSSEText, generateImage, getUsage, GrokAPIError, streamChat } from '../api'

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

  it('sends a concise customer-chat instruction before the conversation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"Xin chào"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const chunks: string[] = []

    await streamChat({
      apiKey: 'sk-customer',
      reasoning: 'low',
      messages: [{ id: 'user-1', role: 'user', text: 'hi', createdAt: 1 }],
      onText: (chunk) => chunks.push(chunk),
    })

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(payload.reasoning_effort).toBe('low')
    expect(payload.messages[0]).toEqual(expect.objectContaining({ role: 'system' }))
    expect(payload.messages[0].content).toContain('Không lặp từ')
    expect(payload.messages[0].content).toContain('không tự thêm emoji')
    expect(payload.messages[0].content).toContain('chưa có kết quả thật')
    expect(payload.messages[1]).toEqual({ role: 'user', content: 'hi' })
    expect(chunks).toEqual(['Xin chào'])
  })

  it('normalizes base64 image generation responses into a data URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        responseData: { translatedText: 'An astronaut cat' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: 'aW1hZ2U=' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await generateImage({
      apiKey: 'sk-customer',
      prompt: 'mèo phi hành gia',
      model: 'grok-imagine-image',
      size: '1024x1024',
    })
    expect(result.url).toBe('data:image/png;base64,aW1hZ2U=')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      model: 'grok-imagine-image',
      prompt: 'An astronaut cat',
    })
  })

  it('falls back to the fast model and accepts alternate image payloads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        responseData: { translatedText: 'A Vietnamese landscape' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'model unavailable' } }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        images: [{ image_url: 'https://images.example/generated.png' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await generateImage({
      apiKey: 'sk-customer',
      prompt: 'phong cảnh Việt Nam',
      model: 'grok-imagine-image-quality',
      size: '1536x1024',
    })

    expect(result.url).toBe('https://images.example/generated.png')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).model).toBe('grok-imagine-image')
  })

  it('returns a clear error for rejected keys', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(getUsage('bad-key')).rejects.toEqual(expect.objectContaining<GrokAPIError>({
      status: 401,
      message: 'API key không hợp lệ hoặc đã bị thu hồi.',
    }))
  })

  it('edits an image through the native edits endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ responseData: { translatedText: 'Make the house blue' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://images.example/edited.png' }] }), { status: 200 }))
    const result = await editImage({ apiKey: 'sk-customer', sourceImage: 'data:image/png;base64,source', prompt: 'Đổi nhà thành màu xanh', model: 'grok-imagine-image-quality' })
    expect(result.url).toBe('https://images.example/edited.png')
    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(request.image).toEqual({ type: 'image_url', url: 'data:image/png;base64,source' })
    expect(request.prompt).toContain('change only what the user explicitly requests')
    expect(request.prompt).toContain('For face, hair, expression, body, or clothing changes')
    expect(request.prompt).toContain('For background changes')
    expect(request.prompt).toContain('For adding, removing, or moving an object')
    expect(request.prompt).toContain('For style, weather, season, time, or lighting changes')
    expect(request.prompt).toContain('For crop, aspect-ratio, or outpainting requests')
    expect(request.prompt).toContain('Requested edit (English): Make the house blue')
    expect(request.prompt).toContain('Original user instruction (preserve its exact meaning): Đổi nhà thành màu xanh')
  })

  it('retries a quality edit as a fast edit without dropping the source image', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ responseData: { translatedText: 'Change the dress to red' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'quality edit unavailable' } }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://images.example/fast-edit.png' }] }), { status: 200 }))

    const result = await editImage({ apiKey: 'sk-customer', sourceImage: 'data:image/png;base64,source', prompt: 'Đổi váy thành màu đỏ', model: 'grok-imagine-image-quality' })
    expect(result.url).toBe('https://images.example/fast-edit.png')
    const qualityRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    const fastRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))
    expect(qualityRequest.model).toBe('grok-imagine-image-quality')
    expect(fastRequest.model).toBe('grok-imagine-image')
    expect(fastRequest.image).toEqual(qualityRequest.image)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/v1/images/edits')
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/v1/images/edits')
  })

  it('never replaces a failed image edit with text-to-image generation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ responseData: { translatedText: 'Remove the clouds' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'not supported' } }), { status: 422 }))
    await expect(editImage({ apiKey: 'sk-customer', sourceImage: 'data:image/png;base64,source', prompt: 'Xóa mây', model: 'grok-imagine-image' }))
      .rejects.toEqual(expect.objectContaining({
        status: 422,
        message: expect.stringContaining('Không thể chỉnh trực tiếp ảnh gốc'),
      }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
