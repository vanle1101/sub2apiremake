export type ReasoningMode = 'low' | 'medium' | 'high'

export interface ChatAttachment {
  id: string
  name: string
  dataUrl: string
  mimeType: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  attachments?: ChatAttachment[]
  generatedImages?: string[]
  pending?: boolean
  error?: boolean
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

export interface UsageResponse {
  isValid: boolean
  status?: string
  mode?: string
  remaining?: number
  unit?: string
  quota?: {
    limit: number
    used: number
    remaining: number
    unit: string
  }
  usage?: {
    today?: UsageTotals
    total?: UsageTotals
  }
}

export interface UsageTotals {
  requests?: number
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  total_tokens?: number
  actual_cost?: number
}

export interface ImageGenerationResult {
  url: string
  revisedPrompt?: string
}
