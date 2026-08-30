import type {
  ChatMessage,
  ImageGenerationResult,
  ReasoningMode,
  UsageResponse,
} from './types'

const API_ROOT = '/v1'

export class GrokAPIError extends Error {
  status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'GrokAPIError'
    this.status = status
  }
}

function authHeaders(apiKey: string, json = true): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey.trim()}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

async function errorFromResponse(response: Response): Promise<GrokAPIError> {
  let message = `Yêu cầu thất bại (${response.status})`
  try {
    const payload = await response.json()
    message = payload?.error?.message || payload?.message || message
  } catch {
    // Keep the status-based fallback when the upstream body is not JSON.
  }
  if (response.status === 401) message = 'API key không hợp lệ hoặc đã bị thu hồi.'
  if (response.status === 429) message = 'Đã chạm giới hạn. Vui lòng thử lại sau.'
  return new GrokAPIError(message, response.status)
}

export async function getUsage(apiKey: string): Promise<UsageResponse> {
  const response = await fetch(`${API_ROOT}/usage`, {
    headers: authHeaders(apiKey, false),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return response.json()
}

function messageContent(message: ChatMessage): string | Array<Record<string, unknown>> {
  if (!message.attachments?.length) return message.text
  return [
    { type: 'text', text: message.text || 'Hãy phân tích ảnh này.' },
    ...message.attachments.map((attachment) => ({
      type: 'image_url',
      image_url: { url: attachment.dataUrl, detail: 'high' },
    })),
  ]
}

export function extractSSEText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const data = payload as Record<string, any>
  const content = data.choices?.[0]?.delta?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
  }
  return ''
}

export async function streamChat(input: {
  apiKey: string
  messages: ChatMessage[]
  reasoning: ReasoningMode
  signal?: AbortSignal
  onText: (chunk: string) => void
}): Promise<void> {
  const response = await fetch(`${API_ROOT}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(input.apiKey),
    signal: input.signal,
    body: JSON.stringify({
      model: 'grok-4.6',
      reasoning_effort: input.reasoning,
      stream: true,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: messageContent(message),
      })),
    }),
  })

  if (!response.ok) throw await errorFromResponse(response)
  if (!response.body) throw new GrokAPIError('Trình duyệt không hỗ trợ phản hồi dạng stream.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const raw = trimmed.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      try {
        const text = extractSSEText(JSON.parse(raw))
        if (text) input.onText(text)
      } catch {
        // Ignore malformed keep-alive frames without breaking the whole response.
      }
    }
    if (done) break
  }
}

export async function generateImage(input: {
  apiKey: string
  prompt: string
  model: 'grok-imagine-image' | 'grok-imagine-image-quality'
  size: '1024x1024' | '1024x1536' | '1536x1024'
  signal?: AbortSignal
}): Promise<ImageGenerationResult> {
  const models = input.model === 'grok-imagine-image-quality'
    ? ['grok-imagine-image-quality', 'grok-imagine-image'] as const
    : [input.model] as const
  let lastError: GrokAPIError | null = null

  for (const model of models) {
    const response = await fetch(`${API_ROOT}/images/generations`, {
      method: 'POST',
      headers: authHeaders(input.apiKey),
      signal: input.signal,
      // xAI's native image endpoint accepts model + prompt. The gateway strips
      // unsupported sizing fields, so keep this payload minimal and portable.
      body: JSON.stringify({ model, prompt: input.prompt }),
    })
    if (!response.ok) {
      lastError = await errorFromResponse(response)
      if (model === 'grok-imagine-image-quality' && [400, 404, 422].includes(response.status)) continue
      throw lastError
    }

    const payload = await response.json()
    const image = payload?.data?.[0] || payload?.images?.[0] || payload?.output?.[0] || payload?.image
    const raw = typeof image === 'string'
      ? image
      : image?.url || image?.image_url || image?.b64_json || image?.base64 || image?.result
    if (typeof raw === 'string' && raw.trim()) {
      const value = raw.trim()
      const url = /^(?:https?:|data:|blob:)/i.test(value)
        ? value
        : `data:image/png;base64,${value}`
      return { url, revisedPrompt: image?.revised_prompt || payload?.revised_prompt }
    }
    lastError = new GrokAPIError('API không trả về dữ liệu ảnh.')
  }

  throw lastError || new GrokAPIError('Không thể tạo ảnh bằng model hiện tại.')
}
