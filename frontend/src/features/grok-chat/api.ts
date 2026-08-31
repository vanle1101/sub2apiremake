import type {
  ChatMessage,
  ImageGenerationResult,
  ReasoningMode,
  UsageResponse,
} from './types'

const API_ROOT = '/v1'

const CHAT_SYSTEM_PROMPT = [
  'Bạn là Myhanh Grok, trợ lý trò chuyện thông minh sử dụng mô hình Grok 4.6.',
  'Trả lời đúng trọng tâm, tự nhiên, rõ ràng và bằng ngôn ngữ của người dùng.',
  'Không lặp từ, không dùng giọng quảng cáo, không tự thêm emoji, lời tâng bốc hoặc câu dẫn thừa.',
  'Không tuyên bố đã tạo ảnh, mở file hay thực hiện hành động nếu chưa có kết quả thật.',
  'Nếu người dùng muốn tạo ảnh trong chế độ chat, hãy hướng dẫn ngắn gọn rằng họ cần chọn nút Tạo ảnh.',
].join(' ')

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

function imageResultFromPayload(payload: any): ImageGenerationResult | null {
  const image = payload?.data?.[0] || payload?.images?.[0] || payload?.output?.[0] || payload?.image
  const raw = typeof image === 'string'
    ? image
    : image?.url || image?.image_url || image?.b64_json || image?.base64 || image?.result
  if (typeof raw !== 'string' || !raw.trim()) return null
  const value = raw.trim()
  const url = /^(?:https?:|data:|blob:)/i.test(value)
    ? value
    : `data:image/png;base64,${value}`
  return { url, revisedPrompt: image?.revised_prompt || payload?.revised_prompt }
}

async function translateImagePrompt(prompt: string, signal?: AbortSignal): Promise<string> {
  const original = prompt.trim()
  if (!original) return original
  try {
    const translationURL = new URL('https://api.mymemory.translated.net/get')
    translationURL.searchParams.set('q', original)
    translationURL.searchParams.set('langpair', 'vi|en')
    const response = await fetch(translationURL, { signal })
    if (response.ok) {
      const payload = await response.json()
      const translated = payload?.responseData?.translatedText
      if (typeof translated === 'string' && translated.trim()) return translated.trim()
    }
  } catch (error) {
    if (signal?.aborted) throw error
  }
  return original
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
      messages: [
        { role: 'system', content: CHAT_SYSTEM_PROMPT },
        ...input.messages.map((message) => ({
          role: message.role,
          content: messageContent(message),
        })),
      ],
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
  // Free image fallbacks are much more reliable with an English prompt.
  // Use deterministic machine translation here: a chat model may creatively
  // rewrite a short request and silently replace its actual subject.
  const imagePrompt = await translateImagePrompt(input.prompt, input.signal)

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
      body: JSON.stringify({ model, prompt: imagePrompt }),
    })
    if (!response.ok) {
      lastError = await errorFromResponse(response)
      if (model === 'grok-imagine-image-quality' && [400, 404, 422].includes(response.status)) continue
      throw lastError
    }

    const payload = await response.json()
    const result = imageResultFromPayload(payload)
    if (result) return result
    lastError = new GrokAPIError('API không trả về dữ liệu ảnh.')
  }

  throw lastError || new GrokAPIError('Không thể tạo ảnh bằng model hiện tại.')
}

export async function editImage(input: {
  apiKey: string
  sourceImage: string
  prompt: string
  model: 'grok-imagine-image' | 'grok-imagine-image-quality'
  signal?: AbortSignal
}): Promise<ImageGenerationResult> {
  const originalPrompt = input.prompt.trim()
  const editPrompt = await translateImagePrompt(input.prompt, input.signal)
  const constrainedPrompt = [
    'DIRECT IMAGE EDIT — use the supplied source image as the immutable base and change only what the user explicitly requests.',
    'Never create a new person, subject, scene, pose, composition, or camera shot.',
    'For color or material changes: preserve exact shapes, textures, shading, reflections, and all unaffected colors.',
    'For face, hair, expression, body, or clothing changes: preserve the same person and identity, facial structure, body, pose, framing, and every unrequested attribute.',
    'For background changes: preserve the foreground subject exactly, including its edges, scale, position, lighting direction, and identity.',
    'For adding, removing, or moving an object: modify only that object and reconstruct only the directly occluded area; leave the rest pixel-faithful.',
    'For style, weather, season, time, or lighting changes: preserve all subjects, scene geometry, layout, perspective, and camera angle.',
    'For crop, aspect-ratio, or outpainting requests: preserve every existing source-image detail and extend only the newly exposed area.',
    'Keep the original dimensions and aspect ratio unless the user explicitly requests a crop, resize, aspect-ratio change, or outpainting.',
    'Do not add decorations, accessories, text, objects, or details that were not requested. Do not beautify or redesign the image.',
    `Requested edit (English): ${editPrompt}`,
    ...(editPrompt.toLocaleLowerCase() !== originalPrompt.toLocaleLowerCase()
      ? [`Original user instruction (preserve its exact meaning): ${originalPrompt}`]
      : []),
  ].join(' ')

  // Image editing must remain image-to-image. Never fall back to text-to-image:
  // doing so may replace the person, composition, clothes, and background while
  // appearing to the user as though the original image was edited.
  const editModels = input.model === 'grok-imagine-image-quality'
    ? ['grok-imagine-image-quality', 'grok-imagine-image'] as const
    : ['grok-imagine-image'] as const
  let lastError: GrokAPIError | null = null

  for (const [index, model] of editModels.entries()) {
    let response: Response
    try {
      response = await fetch(`${API_ROOT}/images/edits`, {
        method: 'POST',
        headers: authHeaders(input.apiKey),
        signal: input.signal,
        body: JSON.stringify({
          model,
          prompt: constrainedPrompt,
          image: { type: 'image_url', url: input.sourceImage },
        }),
      })
    } catch (error) {
      if (input.signal?.aborted) throw error
      throw new GrokAPIError(error instanceof Error
        ? `Không thể kết nối API chỉnh sửa ảnh: ${error.message}`
        : 'Không thể kết nối API chỉnh sửa ảnh.')
    }

    if (!response.ok) {
      lastError = await errorFromResponse(response)
      const canRetryAsFastEdit = index === 0
        && editModels.length > 1
        && [400, 404, 422].includes(response.status)
      if (canRetryAsFastEdit) continue
      if ([400, 404, 405, 422].includes(response.status)) {
        throw new GrokAPIError(`Không thể chỉnh trực tiếp ảnh gốc bằng nhà cung cấp hiện tại: ${lastError.message}`, response.status)
      }
      throw lastError
    }
    const result = imageResultFromPayload(await response.json())
    if (result) return result
    throw new GrokAPIError('API chỉnh sửa không trả về dữ liệu ảnh.')
  }

  throw lastError || new GrokAPIError('Không thể chỉnh sửa ảnh bằng model hiện tại.')
}
