<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { generateImage, getUsage, streamChat } from '@/features/grok-chat/api'
import { prepareImage } from '@/features/grok-chat/image'
import {
  clearAPIKey,
  createId,
  readAPIKey,
  readConversations,
  readGallery,
  saveAPIKey,
  saveConversations,
  saveGallery,
} from '@/features/grok-chat/storage'
import type {
  ChatAttachment,
  ChatMessage,
  Conversation,
  ReasoningMode,
  UsageResponse,
} from '@/features/grok-chat/types'

type AppTab = 'chat' | 'imagine' | 'history' | 'settings'
type ImageSize = '1024x1024' | '1024x1536' | '1536x1024'

const apiKey = ref(readAPIKey())
const draftKey = ref(apiKey.value)
const rememberKey = ref(true)
const connected = ref(false)
const connecting = ref(false)
const connectError = ref('')
const usage = ref<UsageResponse | null>(null)
const activeTab = ref<AppTab>('chat')
const reasoning = ref<ReasoningMode>('medium')
const composerMode = ref<'chat' | 'image'>('chat')
const prompt = ref('')
const attachments = ref<ChatAttachment[]>([])
const conversations = ref<Conversation[]>(readConversations())
const activeConversationId = ref(conversations.value[0]?.id || '')
const gallery = ref<string[]>(readGallery())
const busy = ref(false)
const controller = ref<AbortController | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const messageScroller = ref<HTMLElement | null>(null)

const imaginePrompt = ref('')
const imagineModel = ref<'grok-imagine-image' | 'grok-imagine-image-quality'>('grok-imagine-image-quality')
const imagineSize = ref<ImageSize>('1024x1024')
const imagineError = ref('')
const reasoningModes: ReasoningMode[] = ['low', 'medium', 'high']

marked.setOptions({ breaks: true, gfm: true })

const activeConversation = computed(() =>
  conversations.value.find((conversation) => conversation.id === activeConversationId.value) || null,
)

const remainingLabel = computed(() => {
  const value = usage.value?.quota?.remaining ?? usage.value?.remaining
  if (value == null || value < 0) return 'Không giới hạn'
  const unit = usage.value?.quota?.unit || usage.value?.unit || 'USD'
  return unit.toUpperCase() === 'USD' ? `$${value.toFixed(2)}` : `${value.toLocaleString('vi-VN')} ${unit}`
})

const usedTokensLabel = computed(() => {
  const tokens = usage.value?.usage?.total?.total_tokens || 0
  return compactNumber(tokens)
})

const canSend = computed(() => !busy.value && (!!prompt.value.trim() || attachments.value.length > 0))

function compactNumber(value: number): string {
  return new Intl.NumberFormat('vi-VN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(String(marked.parse(text || '')))
}

function createConversation(): Conversation {
  const now = Date.now()
  const conversation: Conversation = {
    id: createId('chat'),
    title: 'Cuộc trò chuyện mới',
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
  conversations.value.unshift(conversation)
  activeConversationId.value = conversation.id
  activeTab.value = 'chat'
  persistConversations()
  return conversation
}

function ensureConversation(): Conversation {
  return activeConversation.value || createConversation()
}

function persistConversations() {
  saveConversations(conversations.value)
}

async function refreshUsage() {
  if (!apiKey.value) return
  usage.value = await getUsage(apiKey.value)
}

async function connect() {
  const key = draftKey.value.trim()
  if (!key) {
    connectError.value = 'Nhập API key để tiếp tục.'
    return
  }
  connecting.value = true
  connectError.value = ''
  try {
    const result = await getUsage(key)
    if (result.isValid === false) throw new Error('API key không còn hiệu lực.')
    apiKey.value = key
    usage.value = result
    saveAPIKey(key, rememberKey.value)
    connected.value = true
    if (!activeConversation.value) createConversation()
  } catch (error) {
    connectError.value = error instanceof Error ? error.message : 'Không thể kết nối API.'
  } finally {
    connecting.value = false
  }
}

function disconnect() {
  if (busy.value) controller.value?.abort()
  clearAPIKey()
  apiKey.value = ''
  draftKey.value = ''
  usage.value = null
  connected.value = false
  activeTab.value = 'chat'
}

async function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || []).slice(0, Math.max(0, 4 - attachments.value.length))
  input.value = ''
  for (const file of files) {
    try {
      attachments.value.push(await prepareImage(file))
    } catch (error) {
      connectError.value = error instanceof Error ? error.message : 'Không thể xử lý ảnh.'
    }
  }
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((attachment) => attachment.id !== id)
}

function titleFromPrompt(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 46) : 'Phân tích ảnh'
}

async function sendMessage() {
  if (!canSend.value) return
  const conversation = ensureConversation()
  const text = prompt.value.trim()
  const userMessage: ChatMessage = {
    id: createId('message'),
    role: 'user',
    text,
    createdAt: Date.now(),
    attachments: attachments.value.map((attachment) => ({ ...attachment })),
  }
  prompt.value = ''
  attachments.value = []
  if (conversation.messages.length === 0) conversation.title = titleFromPrompt(text)
  conversation.messages.push(userMessage)
  conversation.updatedAt = Date.now()

  const assistantMessage: ChatMessage = {
    id: createId('message'),
    role: 'assistant',
    text: '',
    createdAt: Date.now(),
    pending: true,
  }
  conversation.messages.push(assistantMessage)
  persistConversations()
  await scrollToBottom()

  busy.value = true
  controller.value = new AbortController()
  try {
    if (composerMode.value === 'image') {
      const result = await generateImage({
        apiKey: apiKey.value,
        prompt: text || 'Tạo một hình ảnh đẹp dựa trên nội dung đã gửi.',
        model: 'grok-imagine-image-quality',
        size: '1024x1024',
        signal: controller.value.signal,
      })
      assistantMessage.text = result.revisedPrompt || 'Ảnh đã được tạo.'
      assistantMessage.generatedImages = [result.url]
      addToGallery(result.url)
    } else {
      const context = conversation.messages.filter((message) => message.id !== assistantMessage.id && !message.error)
      await streamChat({
        apiKey: apiKey.value,
        messages: context,
        reasoning: reasoning.value,
        signal: controller.value.signal,
        onText(chunk) {
          assistantMessage.text += chunk
          assistantMessage.pending = false
          void scrollToBottom()
        },
      })
      if (!assistantMessage.text) assistantMessage.text = 'Grok không trả về nội dung.'
    }
    assistantMessage.pending = false
  } catch (error) {
    assistantMessage.pending = false
    assistantMessage.error = true
    assistantMessage.text = error instanceof DOMException && error.name === 'AbortError'
      ? 'Đã dừng phản hồi.'
      : error instanceof Error ? error.message : 'Có lỗi khi gọi API.'
  } finally {
    busy.value = false
    controller.value = null
    conversation.updatedAt = Date.now()
    persistConversations()
    refreshUsage().catch(() => undefined)
    await scrollToBottom()
  }
}

function stopResponse() {
  controller.value?.abort()
}

async function generateFromImagine() {
  const text = imaginePrompt.value.trim()
  if (!text || busy.value) return
  busy.value = true
  imagineError.value = ''
  controller.value = new AbortController()
  try {
    const result = await generateImage({
      apiKey: apiKey.value,
      prompt: text,
      model: imagineModel.value,
      size: imagineSize.value,
      signal: controller.value.signal,
    })
    addToGallery(result.url)
    imaginePrompt.value = ''
  } catch (error) {
    imagineError.value = error instanceof Error ? error.message : 'Không thể tạo ảnh.'
  } finally {
    busy.value = false
    controller.value = null
    refreshUsage().catch(() => undefined)
  }
}

function addToGallery(url: string) {
  gallery.value = [url, ...gallery.value.filter((item) => item !== url)].slice(0, 12)
  saveGallery(gallery.value)
}

function selectConversation(id: string) {
  activeConversationId.value = id
  activeTab.value = 'chat'
  void scrollToBottom()
}

function deleteConversation(id: string) {
  conversations.value = conversations.value.filter((conversation) => conversation.id !== id)
  if (activeConversationId.value === id) activeConversationId.value = conversations.value[0]?.id || ''
  persistConversations()
}

async function downloadImage(url: string, index = 0) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `grok-imagine-${Date.now()}-${index + 1}.png`
  anchor.target = '_blank'
  anchor.rel = 'noopener'
  anchor.click()
}

async function scrollToBottom() {
  await nextTick()
  if (messageScroller.value) messageScroller.value.scrollTop = messageScroller.value.scrollHeight
}

function switchComposerMode() {
  composerMode.value = composerMode.value === 'chat' ? 'image' : 'chat'
}

watch(conversations, persistConversations, { deep: true })
watch(activeConversationId, scrollToBottom)

onMounted(async () => {
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]') || document.createElement('link')
  manifest.rel = 'manifest'
  manifest.href = '/grok-chat-manifest.webmanifest'
  if (!manifest.parentNode) document.head.appendChild(manifest)
  document.documentElement.style.setProperty('--grok-app-height', `${window.innerHeight}px`)
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/grok-chat-sw.js').catch(() => undefined)
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('preview')) {
    usage.value = {
      isValid: true,
      mode: 'quota_limited',
      remaining: 16.46,
      unit: 'USD',
      usage: { total: { total_tokens: 14_497_241 } },
    }
    connected.value = true
    if (!activeConversation.value) createConversation()
    return
  }
  if (apiKey.value) {
    draftKey.value = apiKey.value
    await connect()
  }
})

onBeforeUnmount(() => controller.value?.abort())
</script>

<template>
  <div class="grok-mobile">
    <section v-if="!connected" class="connect-screen">
      <div class="connect-glow glow-one"></div>
      <div class="connect-glow glow-two"></div>
      <div class="connect-card">
        <div class="brand-mark">G</div>
        <p class="eyebrow">GROK MOBILE</p>
        <h1>Trợ lý AI của bạn</h1>
        <p class="connect-copy">Chat, đọc ảnh và sáng tạo hình ảnh với Grok 4.6.</p>
        <label class="key-field">
          <span>API key</span>
          <input
            v-model="draftKey"
            type="password"
            autocomplete="off"
            placeholder="sk-..."
            @keydown.enter="connect"
          />
        </label>
        <label class="remember-row">
          <input v-model="rememberKey" type="checkbox" />
          <span>Ghi nhớ key trên thiết bị này</span>
        </label>
        <p v-if="connectError" class="form-error">{{ connectError }}</p>
        <button class="primary-button" :disabled="connecting" @click="connect">
          <span v-if="connecting" class="spinner"></span>
          {{ connecting ? 'Đang kết nối…' : 'Bắt đầu' }}
        </button>
        <a class="usage-link" href="/check" target="_blank">Kiểm tra key và hạn mức</a>
      </div>
    </section>

    <div v-else class="app-shell">
      <header class="app-header">
        <button class="icon-button" aria-label="Tạo cuộc trò chuyện mới" @click="createConversation">
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button class="model-chip" @click="activeTab = 'settings'">
          <span class="model-dot"></span>
          <span>Grok 4.6</span>
          <small>{{ reasoning === 'high' ? 'Thinking' : reasoning === 'low' ? 'Fast' : 'Standard' }}</small>
        </button>
        <button class="balance-pill" @click="refreshUsage">
          <span>{{ remainingLabel }}</span>
          <small>còn lại</small>
        </button>
      </header>

      <main v-if="activeTab === 'chat'" class="chat-page">
        <div ref="messageScroller" class="messages">
          <div v-if="!activeConversation?.messages.length" class="empty-chat">
            <div class="orb"><span>G</span></div>
            <h2>Hôm nay bạn muốn làm gì?</h2>
            <p>Hỏi bất cứ điều gì, gửi ảnh để phân tích hoặc tạo một hình ảnh mới.</p>
            <div class="suggestion-grid">
              <button @click="prompt = 'Giúp tôi lên kế hoạch công việc hôm nay'">Lên kế hoạch hôm nay</button>
              <button @click="fileInput?.click()">Phân tích một bức ảnh</button>
              <button @click="composerMode = 'image'; prompt = 'Một thành phố tương lai lúc hoàng hôn, phong cách điện ảnh'">Tạo ảnh nghệ thuật</button>
              <button @click="prompt = 'Giải thích một chủ đề khó theo cách dễ hiểu'">Giải thích dễ hiểu</button>
            </div>
          </div>

          <article
            v-for="message in activeConversation?.messages || []"
            :key="message.id"
            class="message-row"
            :class="[`message-${message.role}`, { 'message-error': message.error }]"
          >
            <div v-if="message.role === 'assistant'" class="assistant-avatar">G</div>
            <div class="message-content">
              <div v-if="message.attachments?.length" class="message-attachments">
                <img v-for="image in message.attachments" :key="image.id" :src="image.dataUrl" :alt="image.name" />
              </div>
              <div v-if="message.pending && !message.text" class="thinking-indicator">
                <span></span><span></span><span></span>
                <em>{{ reasoning === 'high' ? 'Đang suy nghĩ kỹ…' : 'Đang trả lời…' }}</em>
              </div>
              <div v-else-if="message.role === 'assistant'" class="markdown-body" v-html="renderMarkdown(message.text)"></div>
              <p v-else class="user-text">{{ message.text }}</p>
              <div v-if="message.generatedImages?.length" class="generated-images">
                <figure v-for="(image, index) in message.generatedImages" :key="image">
                  <img :src="image" alt="Ảnh do Grok Imagine tạo" />
                  <button @click="downloadImage(image, index)">Tải ảnh</button>
                </figure>
              </div>
            </div>
          </article>
        </div>

        <section class="composer-wrap">
          <div v-if="attachments.length" class="attachment-strip">
            <div v-for="image in attachments" :key="image.id" class="attachment-preview">
              <img :src="image.dataUrl" :alt="image.name" />
              <button @click="removeAttachment(image.id)">×</button>
            </div>
          </div>
          <div v-if="composerMode === 'image'" class="mode-banner">
            <span>✦ Chế độ tạo ảnh</span>
            <button @click="composerMode = 'chat'">Đóng</button>
          </div>
          <div class="composer">
            <button class="composer-action" aria-label="Đính kèm ảnh" @click="fileInput?.click()">
              <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <textarea
              v-model="prompt"
              rows="1"
              :placeholder="composerMode === 'image' ? 'Mô tả hình ảnh bạn muốn tạo…' : 'Nhắn tin cho Grok…'"
              @keydown.enter.exact.prevent="sendMessage"
            ></textarea>
            <button class="spark-button" :class="{ active: composerMode === 'image' }" aria-label="Đổi chế độ tạo ảnh" @click="switchComposerMode">✦</button>
            <button v-if="busy" class="send-button stop" aria-label="Dừng" @click="stopResponse"><span></span></button>
            <button v-else class="send-button" :disabled="!canSend" aria-label="Gửi" @click="sendMessage">
              <svg viewBox="0 0 24 24"><path d="m5 12 7-7 7 7M12 19V5" /></svg>
            </button>
          </div>
          <p class="composer-note">Grok có thể mắc lỗi. Hãy kiểm tra thông tin quan trọng.</p>
        </section>
      </main>

      <main v-else-if="activeTab === 'imagine'" class="imagine-page scroll-page">
        <section class="imagine-hero">
          <span class="imagine-spark">✦</span>
          <p class="eyebrow">GROK IMAGINE</p>
          <h1>Biến ý tưởng thành hình ảnh</h1>
          <p>Mô tả điều bạn hình dung. Grok sẽ tạo ảnh ngay trong vài giây.</p>
        </section>
        <section class="imagine-card">
          <textarea v-model="imaginePrompt" rows="5" placeholder="Ví dụ: Chân dung một phi hành gia Việt Nam đứng trên Sao Hỏa, ánh sáng điện ảnh…"></textarea>
          <div class="option-row">
            <label>
              <span>Chất lượng</span>
              <select v-model="imagineModel">
                <option value="grok-imagine-image">Nhanh</option>
                <option value="grok-imagine-image-quality">Chi tiết</option>
              </select>
            </label>
            <label>
              <span>Tỷ lệ</span>
              <select v-model="imagineSize">
                <option value="1024x1024">Vuông 1:1</option>
                <option value="1024x1536">Dọc 2:3</option>
                <option value="1536x1024">Ngang 3:2</option>
              </select>
            </label>
          </div>
          <p v-if="imagineError" class="form-error">{{ imagineError }}</p>
          <button class="imagine-button" :disabled="busy || !imaginePrompt.trim()" @click="generateFromImagine">
            <span v-if="busy" class="spinner"></span>
            {{ busy ? 'Đang sáng tạo…' : '✦ Tạo hình ảnh' }}
          </button>
        </section>
        <section v-if="gallery.length" class="gallery-section">
          <div class="section-heading"><h2>Thư viện của bạn</h2><span>{{ gallery.length }} ảnh</span></div>
          <div class="gallery-grid">
            <figure v-for="(image, index) in gallery" :key="`${image.slice(0, 40)}-${index}`">
              <img :src="image" alt="Ảnh trong thư viện Grok Imagine" loading="lazy" />
              <button @click="downloadImage(image, index)">↓</button>
            </figure>
          </div>
        </section>
      </main>

      <main v-else-if="activeTab === 'history'" class="history-page scroll-page">
        <div class="page-title"><p class="eyebrow">LỊCH SỬ</p><h1>Cuộc trò chuyện</h1></div>
        <button class="new-chat-card" @click="createConversation"><span>＋</span><div><strong>Cuộc trò chuyện mới</strong><small>Bắt đầu với Grok 4.6</small></div></button>
        <div class="history-list">
          <article v-for="conversation in conversations" :key="conversation.id" @click="selectConversation(conversation.id)">
            <div class="history-icon">G</div>
            <div><strong>{{ conversation.title }}</strong><small>{{ conversation.messages.length }} tin nhắn · {{ new Date(conversation.updatedAt).toLocaleDateString('vi-VN') }}</small></div>
            <button aria-label="Xóa cuộc trò chuyện" @click.stop="deleteConversation(conversation.id)">×</button>
          </article>
          <p v-if="!conversations.length" class="empty-list">Chưa có cuộc trò chuyện nào.</p>
        </div>
      </main>

      <main v-else class="settings-page scroll-page">
        <div class="page-title"><p class="eyebrow">CÀI ĐẶT</p><h1>Tài khoản & mô hình</h1></div>
        <section class="usage-card">
          <div><small>Hạn mức còn lại</small><strong>{{ remainingLabel }}</strong></div>
          <div><small>Token đã xử lý</small><strong>{{ usedTokensLabel }}</strong></div>
          <button @click="refreshUsage">Làm mới</button>
        </section>
        <section class="settings-card">
          <h2>Chế độ trả lời</h2>
          <label v-for="mode in reasoningModes" :key="mode" class="reasoning-option">
            <input v-model="reasoning" type="radio" :value="mode" />
            <span>
              <strong>{{ mode === 'low' ? 'Nhanh' : mode === 'medium' ? 'Tiêu chuẩn' : 'Suy nghĩ kỹ' }}</strong>
              <small>{{ mode === 'low' ? 'Ưu tiên tốc độ' : mode === 'medium' ? 'Cân bằng tốc độ và chất lượng' : 'Phân tích sâu cho câu hỏi khó' }}</small>
            </span>
            <em v-if="reasoning === mode">✓</em>
          </label>
        </section>
        <section class="settings-card account-card">
          <h2>Kết nối API</h2>
          <div><span>Endpoint</span><code>grokapi.duckdns.org</code></div>
          <div><span>Model</span><strong>grok-4.6</strong></div>
          <div><span>Trạng thái</span><strong class="online">● Hoạt động</strong></div>
          <button class="danger-button" @click="disconnect">Đổi API key</button>
        </section>
      </main>

      <nav class="bottom-nav">
        <button :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">
          <svg viewBox="0 0 24 24"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" /></svg><span>Chat</span>
        </button>
        <button :class="{ active: activeTab === 'imagine' }" @click="activeTab = 'imagine'">
          <svg viewBox="0 0 24 24"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" /></svg><span>Imagine</span>
        </button>
        <button :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">
          <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg><span>Lịch sử</span>
        </button>
        <button :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z" /></svg><span>Cài đặt</span>
        </button>
      </nav>
      <input ref="fileInput" class="hidden-input" type="file" accept="image/*" multiple @change="handleFiles" />
    </div>
  </div>
</template>

<style scoped>
:global(html:has(.grok-mobile)), :global(body:has(.grok-mobile)), :global(#app:has(.grok-mobile)) { margin: 0; height: 100%; overflow: hidden; background: #090b0f; color-scheme: dark; }
:global(body:has(.grok-mobile)) { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
button, input, textarea, select { font: inherit; }
button { -webkit-tap-highlight-color: transparent; }
.grok-mobile { --accent: #fff; --muted: #9a9da5; --panel: #15181e; --line: rgba(255,255,255,.09); min-height: 100dvh; height: var(--grok-app-height, 100dvh); color: #f7f7f8; background: #090b0f; overflow: hidden; }
.connect-screen { position: relative; display: grid; place-items: center; min-height: 100%; padding: 24px; overflow: hidden; background: radial-gradient(circle at 50% 0%, #1d293d 0, #0b0e14 46%, #07090c 100%); }
.connect-glow { position: absolute; width: 320px; height: 320px; border-radius: 50%; filter: blur(90px); opacity: .28; pointer-events: none; }
.glow-one { background: #4b7eff; top: -120px; right: -100px; }.glow-two { background: #8d5cff; bottom: -180px; left: -120px; }
.connect-card { position: relative; width: min(100%, 420px); padding: 32px 24px 26px; border: 1px solid rgba(255,255,255,.1); border-radius: 28px; background: rgba(18,21,27,.86); box-shadow: 0 30px 90px rgba(0,0,0,.46); backdrop-filter: blur(24px); text-align: center; }
.brand-mark, .assistant-avatar, .history-icon { display: grid; place-items: center; color: #090b0f; background: #fff; font-weight: 900; }
.brand-mark { width: 58px; height: 58px; margin: 0 auto 20px; border-radius: 18px; font-size: 28px; transform: rotate(-5deg); box-shadow: 0 10px 30px rgba(255,255,255,.15); }
.eyebrow { margin: 0 0 8px; color: #9fa4ad; font-size: 11px; font-weight: 800; letter-spacing: .18em; }
.connect-card h1 { margin: 0; font-size: clamp(28px, 8vw, 38px); letter-spacing: -.04em; }.connect-copy { margin: 10px auto 26px; max-width: 310px; color: var(--muted); line-height: 1.55; }
.key-field { display: block; text-align: left; }.key-field span { display: block; margin: 0 0 8px 4px; font-size: 12px; font-weight: 700; color: #c8cad0; }.key-field input { width: 100%; height: 54px; padding: 0 16px; color: #fff; background: #0c0e12; border: 1px solid var(--line); border-radius: 15px; outline: none; font-size: 16px; }.key-field input:focus { border-color: rgba(255,255,255,.4); box-shadow: 0 0 0 4px rgba(255,255,255,.05); }
.remember-row { display: flex; align-items: center; gap: 9px; margin: 14px 4px 18px; color: #a9acb3; font-size: 13px; text-align: left; }.remember-row input { accent-color: #fff; }
.form-error { margin: 10px 0; color: #ff8b8b; font-size: 13px; line-height: 1.4; }
.primary-button, .imagine-button { width: 100%; border: 0; border-radius: 15px; background: #fff; color: #090a0d; font-weight: 800; cursor: pointer; }.primary-button { height: 54px; }.primary-button:disabled, .imagine-button:disabled { opacity: .48; cursor: default; }.usage-link { display: inline-block; margin-top: 18px; color: #aeb2bb; font-size: 13px; text-decoration: none; }
.spinner { display: inline-block; width: 16px; height: 16px; margin-right: 7px; vertical-align: -3px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }
.app-shell { width: 100%; max-width: 760px; height: 100%; margin: 0 auto; display: grid; grid-template-rows: 58px minmax(0,1fr) 66px; background: #0b0d11; border-inline: 1px solid rgba(255,255,255,.04); }
.app-header { display: grid; grid-template-columns: 42px 1fr auto; align-items: center; gap: 10px; padding: env(safe-area-inset-top,0) 14px 0; border-bottom: 1px solid var(--line); background: rgba(11,13,17,.9); backdrop-filter: blur(16px); z-index: 5; }
.icon-button { display: grid; place-items: center; width: 38px; height: 38px; color: #e9eaed; border: 1px solid var(--line); border-radius: 12px; background: #13161b; }.icon-button svg, .send-button svg, .composer-action svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.model-chip { justify-self: center; display: flex; align-items: center; gap: 7px; min-width: 0; padding: 7px 10px; color: #f5f5f6; border: 0; background: transparent; font-weight: 750; }.model-chip small { color: #8c9099; font-size: 10px; font-weight: 600; }.model-dot { width: 7px; height: 7px; border-radius: 50%; background: #56da83; box-shadow: 0 0 9px #56da83; }
.balance-pill { display: flex; flex-direction: column; align-items: flex-end; padding: 5px 9px; color: #fff; border: 1px solid var(--line); border-radius: 12px; background: #14171c; }.balance-pill span { font-size: 12px; font-weight: 800; }.balance-pill small { color: #858a94; font-size: 9px; }
.chat-page { position: relative; min-height: 0; overflow: hidden; }.messages { height: 100%; overflow-y: auto; padding: 18px 14px 190px; scroll-behavior: smooth; }.empty-chat { min-height: calc(100% - 30px); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 28px 4px; }.orb { display: grid; place-items: center; width: 68px; height: 68px; margin-bottom: 20px; border-radius: 50%; background: conic-gradient(from 180deg,#fff,#646b78,#fff); padding: 2px; box-shadow: 0 0 60px rgba(180,195,255,.16); }.orb span { display: grid; place-items: center; width: 100%; height: 100%; border-radius: inherit; background: #11141a; font-size: 27px; font-weight: 900; }.empty-chat h2 { margin: 0; font-size: clamp(24px,6vw,34px); letter-spacing: -.035em; }.empty-chat > p { max-width: 420px; margin: 10px 0 24px; color: var(--muted); line-height: 1.55; }.suggestion-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; width: min(100%, 480px); }.suggestion-grid button { min-height: 66px; padding: 12px; color: #d9dbe0; border: 1px solid var(--line); border-radius: 16px; background: #12151a; text-align: left; font-size: 13px; }
.message-row { display: flex; gap: 10px; margin: 0 auto 22px; max-width: 680px; }.message-user { justify-content: flex-end; }.assistant-avatar { flex: 0 0 28px; width: 28px; height: 28px; margin-top: 2px; border-radius: 9px; font-size: 13px; }.message-content { min-width: 0; max-width: min(88%,620px); }.message-user .message-content { padding: 11px 14px; border-radius: 18px 18px 5px 18px; background: #272b33; }.message-error .message-content { color: #ffaaaa; }.user-text { margin: 0; white-space: pre-wrap; line-height: 1.52; }.markdown-body { color: #eff0f2; line-height: 1.64; overflow-wrap: anywhere; }.markdown-body :deep(p) { margin: 0 0 12px; }.markdown-body :deep(p:last-child) { margin-bottom: 0; }.markdown-body :deep(pre) { overflow-x: auto; padding: 13px; border: 1px solid var(--line); border-radius: 12px; background: #111318; }.markdown-body :deep(code) { font-family: "SFMono-Regular",Consolas,monospace; font-size: .9em; }.markdown-body :deep(a) { color: #9dc1ff; }.message-attachments { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 6px; margin-bottom: 9px; }.message-attachments img { width: 100%; max-height: 240px; object-fit: cover; border-radius: 13px; }.generated-images { display: grid; gap: 10px; margin-top: 12px; }.generated-images figure { position: relative; margin: 0; }.generated-images img { display: block; width: 100%; border-radius: 18px; }.generated-images button, .gallery-grid button { position: absolute; right: 9px; bottom: 9px; padding: 8px 11px; color: #fff; border: 1px solid rgba(255,255,255,.2); border-radius: 10px; background: rgba(0,0,0,.65); backdrop-filter: blur(8px); }.thinking-indicator { display: flex; align-items: center; gap: 4px; min-height: 30px; color: #999da6; }.thinking-indicator span { width: 5px; height: 5px; border-radius: 50%; background: #c6c8ce; animation: pulse 1.2s infinite; }.thinking-indicator span:nth-child(2){animation-delay:.15s}.thinking-indicator span:nth-child(3){animation-delay:.3s}.thinking-indicator em { margin-left: 6px; font-size: 12px; font-style: normal; }@keyframes pulse { 0%,70%,100%{opacity:.25;transform:translateY(0)}35%{opacity:1;transform:translateY(-3px)} }
.composer-wrap { position: absolute; inset: auto 0 0; padding: 10px 12px 8px; background: linear-gradient(transparent,rgba(11,13,17,.95) 24%,#0b0d11 52%); }.composer { display: grid; grid-template-columns: 38px minmax(0,1fr) 34px 38px; align-items: end; gap: 5px; padding: 7px; border: 1px solid rgba(255,255,255,.13); border-radius: 22px; background: #191c22; box-shadow: 0 14px 40px rgba(0,0,0,.34); }.composer textarea { resize: none; max-height: 120px; min-height: 38px; padding: 9px 4px; color: #fff; border: 0; outline: 0; background: transparent; font-size: 16px; line-height: 1.35; }.composer-action,.spark-button,.send-button { display: grid; place-items: center; width: 36px; height: 36px; border: 0; border-radius: 50%; }.composer-action,.spark-button { color: #c4c7ce; background: transparent; }.spark-button.active { color: #101116; background: #fff; }.send-button { color: #0b0c0f; background: #fff; }.send-button:disabled { color: #6b6e75; background: #30333a; }.send-button.stop span { width: 10px; height: 10px; border-radius: 2px; background: #15171a; }.composer-note { margin: 6px 0 0; color: #656a73; font-size: 9px; text-align: center; }.attachment-strip { display: flex; gap: 8px; overflow-x: auto; margin: 0 4px 8px; }.attachment-preview { position: relative; flex: 0 0 58px; height: 58px; }.attachment-preview img { width: 100%; height: 100%; object-fit: cover; border-radius: 12px; }.attachment-preview button { position: absolute; top: -5px; right: -5px; display: grid; place-items: center; width: 20px; height: 20px; padding: 0; color: #fff; border: 1px solid #555; border-radius: 50%; background: #17191e; }.mode-banner { display: flex; justify-content: space-between; align-items: center; margin: 0 3px 7px; padding: 7px 10px; color: #d8d5ff; border: 1px solid rgba(170,150,255,.22); border-radius: 11px; background: rgba(105,80,190,.16); font-size: 12px; }.mode-banner button { color: #aaa6bd; border: 0; background: transparent; font-size: 11px; }
.scroll-page { min-height: 0; overflow-y: auto; padding: 24px 16px 42px; }.imagine-page { background: radial-gradient(circle at 50% -10%,rgba(114,82,255,.24),transparent 38%),#0b0d11; }.imagine-hero { padding: 18px 4px 22px; text-align: center; }.imagine-spark { display: block; margin-bottom: 12px; color: #d6cdff; font-size: 36px; text-shadow: 0 0 30px #8068ff; }.imagine-hero h1,.page-title h1 { margin: 0; font-size: clamp(28px,7vw,42px); letter-spacing: -.045em; }.imagine-hero > p:last-child { max-width: 440px; margin: 10px auto 0; color: var(--muted); line-height: 1.5; }.imagine-card,.settings-card,.usage-card { max-width: 620px; margin: 0 auto 24px; padding: 16px; border: 1px solid var(--line); border-radius: 22px; background: rgba(21,24,30,.92); }.imagine-card textarea { width: 100%; resize: vertical; min-height: 126px; padding: 14px; color: #fff; border: 1px solid var(--line); border-radius: 15px; outline: none; background: #0d0f14; font-size: 16px; line-height: 1.5; }.option-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 12px 0; }.option-row label > span { display: block; margin: 0 0 6px 3px; color: #92969f; font-size: 11px; }.option-row select { width: 100%; height: 42px; padding: 0 10px; color: #fff; border: 1px solid var(--line); border-radius: 12px; background: #0e1014; }.imagine-button { height: 50px; margin-top: 4px; background: linear-gradient(120deg,#fff,#cfc5ff); }.gallery-section { max-width: 620px; margin: 0 auto; }.section-heading { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 11px; }.section-heading h2 { margin: 0; font-size: 18px; }.section-heading span { color: #8d919b; font-size: 12px; }.gallery-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }.gallery-grid figure { position: relative; aspect-ratio: 1; margin: 0; overflow: hidden; border-radius: 17px; background: #17191f; }.gallery-grid img { width: 100%; height: 100%; object-fit: cover; }
.page-title { max-width: 620px; margin: 4px auto 24px; }.new-chat-card,.history-list article { display: flex; align-items: center; width: 100%; max-width: 620px; margin: 0 auto 10px; color: #fff; border: 1px solid var(--line); border-radius: 17px; background: #14171c; text-align: left; }.new-chat-card { gap: 13px; padding: 14px; }.new-chat-card > span { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 13px; background: #fff; color: #0a0b0e; font-size: 22px; }.new-chat-card div,.history-list article div:nth-child(2) { min-width: 0; flex: 1; }.new-chat-card strong,.new-chat-card small,.history-list strong,.history-list small { display: block; }.new-chat-card small,.history-list small { margin-top: 4px; color: #858a94; font-size: 11px; }.history-list article { gap: 11px; padding: 12px; cursor: pointer; }.history-icon { flex: 0 0 36px; width: 36px; height: 36px; border-radius: 12px; }.history-list strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }.history-list article > button { color: #898d96; border: 0; background: transparent; font-size: 22px; }.empty-list { color: #777c85; text-align: center; }
.usage-card { display: grid; grid-template-columns: 1fr 1fr auto; align-items: center; gap: 12px; background: linear-gradient(120deg,#1d2230,#15171c); }.usage-card small,.usage-card strong { display: block; }.usage-card small { color: #8f949e; font-size: 10px; }.usage-card strong { margin-top: 4px; font-size: 17px; }.usage-card button { padding: 8px 10px; color: #dfe1e6; border: 1px solid var(--line); border-radius: 10px; background: #262a32; font-size: 11px; }.settings-card h2 { margin: 0 0 12px; font-size: 16px; }.reasoning-option { display: flex; align-items: center; gap: 11px; padding: 12px 4px; border-top: 1px solid var(--line); }.reasoning-option:first-of-type { border-top: 0; }.reasoning-option input { display: none; }.reasoning-option > span { flex: 1; }.reasoning-option strong,.reasoning-option small { display: block; }.reasoning-option small { margin-top: 3px; color: #858a94; font-size: 11px; }.reasoning-option em { display: grid; place-items: center; width: 23px; height: 23px; color: #0b0d11; border-radius: 50%; background: #fff; font-style: normal; font-size: 12px; }.account-card > div { display: flex; justify-content: space-between; gap: 14px; padding: 12px 0; border-top: 1px solid var(--line); color: #979ba4; font-size: 13px; }.account-card code,.account-card strong { color: #eeeef0; font-size: 12px; }.account-card .online { color: #72dc92; }.danger-button { width: 100%; margin-top: 14px; padding: 12px; color: #ffaaaa; border: 1px solid rgba(255,100,100,.2); border-radius: 13px; background: rgba(130,30,30,.12); }
.bottom-nav { display: grid; grid-template-columns: repeat(4,1fr); padding: 6px 8px max(6px,env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: rgba(12,14,18,.94); backdrop-filter: blur(18px); z-index: 8; }.bottom-nav button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; color: #717681; border: 0; background: transparent; font-size: 9px; }.bottom-nav button.active { color: #fff; }.bottom-nav svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }.hidden-input { position: fixed; left: -9999px; opacity: 0; }
@media (min-width: 761px) { .grok-mobile { padding: 16px; background: radial-gradient(circle at top,#202530,#090b0f 45%); }.app-shell { height: calc(100dvh - 32px); border-radius: 24px; overflow: hidden; box-shadow: 0 24px 90px rgba(0,0,0,.5); }.composer-wrap { padding-inline: 28px; }.messages { padding-inline: 30px; } }
@media (max-width: 390px) { .model-chip small { display: none; }.balance-pill { padding-inline: 7px; }.suggestion-grid { grid-template-columns: 1fr; }.usage-card { grid-template-columns: 1fr 1fr; }.usage-card button { grid-column: 1/-1; }.composer { grid-template-columns: 34px minmax(0,1fr) 32px 36px; padding: 6px 5px; } }
</style>
