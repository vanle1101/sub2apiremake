<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import GrokLogo from '@/components/grok/GrokLogo.vue'
import { generateImage, getUsage, streamChat } from '@/features/grok-chat/api'
import { prepareImage } from '@/features/grok-chat/image'
import {
  clearAPIKey,
  createId,
  readAPIKey,
  readConversations,
  readGallery,
  readTheme,
  saveAPIKey,
  saveConversations,
  saveGallery,
  saveTheme,
} from '@/features/grok-chat/storage'
import type {
  ChatAttachment,
  ChatMessage,
  Conversation,
  ReasoningMode,
  ThemeMode,
  UsageResponse,
} from '@/features/grok-chat/types'

type AppTab = 'chat' | 'imagine' | 'history' | 'settings'
type ImageSize = '1024x1024' | '1024x1536' | '1536x1024'
type ImageModel = 'grok-imagine-image' | 'grok-imagine-image-quality'

const apiKey = ref(readAPIKey())
const draftKey = ref(apiKey.value)
const rememberKey = ref(true)
const connected = ref(false)
const connecting = ref(false)
const connectError = ref('')
const usage = ref<UsageResponse | null>(null)
const activeTab = ref<AppTab>('chat')
const sidebarCollapsed = ref(false)
const mobileDrawerOpen = ref(false)
const theme = ref<ThemeMode>(readTheme())
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
const modelMenuOpen = ref(false)
const speedMenuOpen = ref(false)

const imaginePrompt = ref('')
const imagineModel = ref<ImageModel>('grok-imagine-image-quality')
const imagineSize = ref<ImageSize>('1024x1024')
const imagineError = ref('')
const reasoningModes: ReasoningMode[] = ['low', 'medium', 'high']

const reasoningLabel = computed(() => ({ low: 'Nhanh', medium: 'Tiêu chuẩn', high: 'Suy nghĩ kỹ' })[reasoning.value])

function toggleModelMenu() {
  modelMenuOpen.value = !modelMenuOpen.value
  speedMenuOpen.value = false
}

function toggleSpeedMenu() {
  speedMenuOpen.value = !speedMenuOpen.value
  modelMenuOpen.value = false
}

function selectReasoning(mode: ReasoningMode) {
  reasoning.value = mode
  speedMenuOpen.value = false
}

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
  mobileDrawerOpen.value = false
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
        model: imagineModel.value,
        size: imagineSize.value,
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
  mobileDrawerOpen.value = false
  void scrollToBottom()
}

function openMobileTab(tab: AppTab) {
  activeTab.value = tab
  mobileDrawerOpen.value = false
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

function setTheme(value: ThemeMode) {
  theme.value = value
  saveTheme(value)
}

function toggleTheme() {
  setTheme(theme.value === 'dark' ? 'light' : 'dark')
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
  <div class="grok-mobile" :data-theme="theme">
    <section v-if="!connected" class="connect-screen">
      <div class="connect-glow glow-one"></div>
      <div class="connect-glow glow-two"></div>
      <div class="connect-card">
        <div class="brand-mark"><GrokLogo /></div>
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

    <div v-else class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
      <aside class="desktop-sidebar" aria-label="Điều hướng chính">
        <div class="sidebar-brand">
          <div class="brand-glyph"><GrokLogo /></div>
          <div class="sidebar-brand-copy"><strong>Grok</strong><small>Grok 4.6</small></div>
          <button
            class="sidebar-toggle"
            :aria-label="sidebarCollapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên'"
            :title="sidebarCollapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên'"
            @click="sidebarCollapsed = !sidebarCollapsed"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
          </button>
        </div>
        <button class="sidebar-new" @click="createConversation">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          <span>Cuộc trò chuyện mới</span>
        </button>
        <nav class="sidebar-nav">
          <button :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" /></svg><span>Chat</span>
          </button>
          <button :class="{ active: activeTab === 'imagine' }" @click="activeTab = 'imagine'">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" /></svg><span>Tạo ảnh</span>
          </button>
          <button :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg><span>Lịch sử</span>
          </button>
        </nav>
        <div class="sidebar-recents">
          <p>Gần đây</p>
          <button
            v-for="conversation in conversations.slice(0, 5)"
            :key="conversation.id"
            :class="{ active: activeConversationId === conversation.id && activeTab === 'chat' }"
            @click="selectConversation(conversation.id)"
          >{{ conversation.title }}</button>
        </div>
        <div class="sidebar-footer">
          <button class="sidebar-usage" @click="refreshUsage">
            <span><i></i> Hạn mức còn lại</span><strong>{{ remainingLabel }}</strong>
          </button>
          <button class="theme-toggle" :aria-label="theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'" @click="toggleTheme">
            <svg v-if="theme === 'dark'" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.4A8.3 8.3 0 0 1 9.6 3.5 8.5 8.5 0 1 0 20.5 14.4z" /></svg>
            <span>{{ theme === 'dark' ? 'Giao diện sáng' : 'Giao diện tối' }}</span>
          </button>
          <button class="sidebar-settings" :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" /></svg><span>Cài đặt</span>
          </button>
        </div>
      </aside>

      <div v-if="mobileDrawerOpen" class="mobile-drawer-scrim" @click="mobileDrawerOpen = false"></div>
      <aside class="mobile-drawer" :class="{ open: mobileDrawerOpen }" aria-label="Menu Grok" :aria-hidden="!mobileDrawerOpen">
        <div class="mobile-drawer-head">
          <div class="mobile-drawer-brand"><GrokLogo /><strong>Grok</strong></div>
          <button aria-label="Đóng menu" @click="mobileDrawerOpen = false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <button class="mobile-search" @click="openMobileTab('history')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></svg>
          <span>Tìm kiếm cuộc trò chuyện</span>
        </button>
        <nav class="mobile-drawer-nav">
          <button @click="openMobileTab('imagine')">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z" /></svg><span>Tạo ảnh</span>
          </button>
          <button @click="openMobileTab('history')">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg><span>Lịch sử</span>
          </button>
          <button @click="openMobileTab('settings')">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" /></svg><span>Cài đặt</span>
          </button>
        </nav>
        <section class="mobile-recents">
          <h2>Gần đây</h2>
          <button v-for="conversation in conversations" :key="conversation.id" @click="selectConversation(conversation.id)">
            {{ conversation.title }}
          </button>
          <p v-if="!conversations.length">Chưa có cuộc trò chuyện.</p>
        </section>
        <div class="mobile-drawer-footer">
          <button class="mobile-drawer-new" @click="createConversation">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><span>Đoạn chat mới</span>
          </button>
          <button class="mobile-drawer-theme" :aria-label="theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'" @click="toggleTheme">
            <svg v-if="theme === 'dark'" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.4A8.3 8.3 0 0 1 9.6 3.5 8.5 8.5 0 1 0 20.5 14.4z" /></svg>
          </button>
        </div>
      </aside>

      <header class="app-header">
        <button class="icon-button mobile-menu-button" aria-label="Mở menu" :aria-expanded="mobileDrawerOpen" @click="mobileDrawerOpen = true">
          <svg viewBox="0 0 24 24"><path d="M5 8h14M5 16h10" /></svg>
        </button>
        <nav class="mobile-mode-switch" aria-label="Chế độ làm việc">
          <button :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">Trò chuyện</button>
          <button :class="{ active: activeTab === 'imagine' }" @click="activeTab = 'imagine'">Tạo ảnh</button>
        </nav>
        <nav class="desktop-mode-switch" aria-label="Chế độ làm việc">
          <button :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">Trò chuyện</button>
          <button :class="{ active: activeTab === 'imagine' }" @click="activeTab = 'imagine'">Tạo ảnh</button>
        </nav>
        <button class="mobile-history-button" aria-label="Mở lịch sử" @click="activeTab = 'history'">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" /></svg>
        </button>
      </header>

      <main v-if="activeTab === 'chat'" class="chat-page" :class="{ 'chat-empty': !activeConversation?.messages.length }">
        <div ref="messageScroller" class="messages">
          <div v-if="!activeConversation?.messages.length" class="empty-chat">
          <div class="orb"><span><GrokLogo /></span></div>
          <span class="empty-kicker">GROK 4.6</span>
            <h2><span class="mobile-heading">Ta nên bắt đầu việc gì?</span><span class="desktop-heading">Ta nên bắt đầu việc gì?</span></h2>
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
            <div v-if="message.role === 'assistant'" class="assistant-avatar"><GrokLogo /></div>
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
          <div v-if="composerMode === 'image'" class="mode-banner" aria-label="Tùy chọn tạo ảnh">
            <span class="mode-title">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z" /></svg>
              Tạo ảnh
            </span>
            <div class="image-quick-options">
              <label>
                <span>Tốc độ</span>
                <select v-model="imagineModel" aria-label="Tốc độ tạo ảnh">
                  <option value="grok-imagine-image">Nhanh</option>
                  <option value="grok-imagine-image-quality">Chi tiết</option>
                </select>
              </label>
              <label>
                <span>Tỷ lệ</span>
                <select v-model="imagineSize" aria-label="Tỷ lệ ảnh">
                  <option value="1024x1024">1:1</option>
                  <option value="1024x1536">2:3</option>
                  <option value="1536x1024">3:2</option>
                </select>
              </label>
            </div>
            <button class="mode-close" aria-label="Đóng chế độ tạo ảnh" @click="composerMode = 'chat'">Đóng</button>
          </div>
          <div class="composer" :class="{ 'has-menu': modelMenuOpen || speedMenuOpen }">
            <textarea
              v-model="prompt"
              rows="1"
              :placeholder="composerMode === 'image' ? 'Mô tả hình ảnh bạn muốn tạo…' : 'Làm với bất kỳ nội dung nào'"
              @keydown.enter.exact.prevent="sendMessage"
            ></textarea>
            <div class="composer-toolbar">
              <button class="composer-action" aria-label="Đính kèm ảnh" title="Đính kèm ảnh" @click="fileInput?.click()">
                <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <div class="composer-tools">
                <div class="model-picker">
                  <button class="model-picker-trigger" aria-haspopup="menu" :aria-expanded="modelMenuOpen" @click="toggleModelMenu">
                    <span>Grok 4.6</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
                  </button>
                  <div v-if="modelMenuOpen" class="model-menu" role="menu" aria-label="Chọn mô hình">
                    <button class="model-menu-default" role="menuitemradio" aria-checked="true" @click="modelMenuOpen = false">
                      <span><strong>Mặc định</strong><small>Mô hình Grok nhanh và thông minh</small></span>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                    </button>
                    <div class="model-menu-divider"></div>
                    <button role="menuitemradio" aria-checked="true" @click="modelMenuOpen = false">Grok 4.6</button>
                  </div>
                </div>
                <div class="speed-picker">
                  <button class="speed-trigger" :title="`Tốc độ: ${reasoningLabel}`" aria-haspopup="menu" :aria-expanded="speedMenuOpen" @click="toggleSpeedMenu">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-8 12h7l-1 8 8-12h-7z" /></svg>
                    <span>{{ reasoningLabel }}</span>
                  </button>
                  <div v-if="speedMenuOpen" class="speed-menu" role="menu" aria-label="Chọn tốc độ trả lời">
                    <div class="speed-menu-title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-8 12h7l-1 8 8-12h-7z" /></svg><strong>Grok 4.6 · {{ reasoningLabel }}</strong></div>
                    <div class="speed-track" aria-hidden="true"><span :class="`at-${reasoning}`"></span><i></i><i></i><i></i></div>
                    <div class="speed-options">
                      <button v-for="mode in reasoningModes" :key="mode" role="menuitemradio" :aria-checked="reasoning === mode" :class="{ active: reasoning === mode }" @click="selectReasoning(mode)">
                        {{ mode === 'low' ? 'Nhanh' : mode === 'medium' ? 'Chuẩn' : 'Thinking' }}
                      </button>
                    </div>
                  </div>
                </div>
                <button class="spark-button" :class="{ active: composerMode === 'image' }" aria-label="Đổi chế độ tạo ảnh" :aria-pressed="composerMode === 'image'" @click="switchComposerMode">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z" /></svg>
                </button>
                <button v-if="busy" class="send-button stop" aria-label="Dừng" @click="stopResponse"><span></span></button>
                <button v-else class="send-button" :disabled="!canSend" aria-label="Gửi" @click="sendMessage">
                  <svg viewBox="0 0 24 24"><path d="m5 12 7-7 7 7M12 19V5" /></svg>
                </button>
              </div>
            </div>
          </div>
          <div v-if="!activeConversation?.messages.length" class="desktop-quick-actions" aria-label="Gợi ý bắt đầu">
            <button @click="composerMode = 'image'; prompt = 'Tạo một hình ảnh theo mô tả của tôi'">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="m5 18 5-5 3 3 2-2 4 4" /></svg>
              <span><strong>Tạo hình ảnh</strong><small>Biến ý tưởng thành hình ảnh</small></span>
            </button>
            <button @click="prompt = 'Giúp tôi viết hoặc chỉnh sửa nội dung sau: '">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" /></svg>
              <span><strong>Viết hoặc chỉnh sửa</strong><small>Soạn nội dung rõ ràng hơn</small></span>
            </button>
            <button @click="prompt = 'Tìm kiếm và tổng hợp thông tin về: '">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></svg>
              <span><strong>Tìm kiếm thông tin</strong><small>Hỏi Grok về bất kỳ chủ đề nào</small></span>
            </button>
          </div>
          <p class="composer-note">Grok có thể mắc lỗi. Hãy kiểm tra thông tin quan trọng.</p>
        </section>
      </main>

      <main v-else-if="activeTab === 'imagine'" class="imagine-page scroll-page">
        <section class="imagine-hero">
          <span class="imagine-spark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z" /></svg></span>
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
            {{ busy ? 'Đang sáng tạo…' : 'Tạo hình ảnh' }}
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
            <div class="history-icon"><GrokLogo /></div>
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
          <h2>Giao diện</h2>
          <div class="theme-segment" role="radiogroup" aria-label="Chọn giao diện">
            <button role="radio" :aria-checked="theme === 'light'" :class="{ active: theme === 'light' }" @click="setTheme('light')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
              Sáng
            </button>
            <button role="radio" :aria-checked="theme === 'dark'" :class="{ active: theme === 'dark' }" @click="setTheme('dark')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.4A8.3 8.3 0 0 1 9.6 3.5 8.5 8.5 0 1 0 20.5 14.4z" /></svg>
              Tối
            </button>
          </div>
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
.composer-wrap { position: absolute; inset: auto 0 0; padding: 10px 12px 8px; background: linear-gradient(transparent,rgba(11,13,17,.95) 24%,#0b0d11 52%); }.composer { display: grid; grid-template-columns: 38px minmax(0,1fr) 34px 38px; align-items: end; gap: 5px; padding: 7px; border: 1px solid rgba(255,255,255,.13); border-radius: 22px; background: #191c22; box-shadow: 0 14px 40px rgba(0,0,0,.34); }.composer textarea { resize: none; max-height: 120px; min-height: 38px; padding: 9px 4px; color: #fff; border: 0; outline: 0; background: transparent; font-size: 16px; line-height: 1.35; }.composer-action,.spark-button,.send-button { display: grid; place-items: center; width: 36px; height: 36px; border: 0; border-radius: 50%; }.composer-action,.spark-button { color: #c4c7ce; background: transparent; }.spark-button.active { color: #101116; background: #fff; }.send-button { color: #0b0c0f; background: #fff; }.send-button:disabled { color: #6b6e75; background: #30333a; }.send-button.stop span { width: 10px; height: 10px; border-radius: 2px; background: #15171a; }.composer-note { margin: 6px 0 0; color: #656a73; font-size: 9px; text-align: center; }.attachment-strip { display: flex; gap: 8px; overflow-x: auto; margin: 0 4px 8px; }.attachment-preview { position: relative; flex: 0 0 58px; height: 58px; }.attachment-preview img { width: 100%; height: 100%; object-fit: cover; border-radius: 12px; }.attachment-preview button { position: absolute; top: -5px; right: -5px; display: grid; place-items: center; width: 20px; height: 20px; padding: 0; color: #fff; border: 1px solid #555; border-radius: 50%; background: #17191e; }.mode-banner { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 0 3px 7px; padding: 7px 8px 7px 10px; color: #d8d5ff; border: 1px solid rgba(170,150,255,.22); border-radius: 14px; background: rgba(105,80,190,.16); font-size: 12px; }.mode-title { display: flex; align-items: center; gap: 6px; min-width: max-content; font-weight: 750; }.mode-title svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; }.image-quick-options { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; flex: 1; }.image-quick-options label { position: relative; display: flex; align-items: center; min-width: 0; }.image-quick-options label > span { position: absolute; left: 10px; color: #aaa6bd; font-size: 9px; pointer-events: none; }.image-quick-options select { min-width: 96px; height: 36px; padding: 0 24px 0 48px; color: #f2efff; border: 1px solid rgba(196,181,253,.18); border-radius: 10px; background: rgba(8,9,13,.46); font: inherit; font-weight: 700; }.image-quick-options label:nth-child(2) select { min-width: 82px; padding-left: 42px; }.mode-banner .mode-close { min-width: 44px; min-height: 36px; padding: 0 8px; color: #b7b1c8; border: 0; border-radius: 9px; background: transparent; font-size: 11px; }.mode-banner .mode-close:hover { color: #fff; background: rgba(255,255,255,.07); }
.scroll-page { min-height: 0; overflow-y: auto; padding: 24px 16px 42px; }.imagine-page { background: radial-gradient(circle at 50% -10%,rgba(114,82,255,.24),transparent 38%),#0b0d11; }.imagine-hero { padding: 18px 4px 22px; text-align: center; }.imagine-spark { display: block; margin-bottom: 12px; color: #d6cdff; font-size: 36px; text-shadow: 0 0 30px #8068ff; }.imagine-hero h1,.page-title h1 { margin: 0; font-size: clamp(28px,7vw,42px); letter-spacing: -.045em; }.imagine-hero > p:last-child { max-width: 440px; margin: 10px auto 0; color: var(--muted); line-height: 1.5; }.imagine-card,.settings-card,.usage-card { max-width: 620px; margin: 0 auto 24px; padding: 16px; border: 1px solid var(--line); border-radius: 22px; background: rgba(21,24,30,.92); }.imagine-card textarea { width: 100%; resize: vertical; min-height: 126px; padding: 14px; color: #fff; border: 1px solid var(--line); border-radius: 15px; outline: none; background: #0d0f14; font-size: 16px; line-height: 1.5; }.option-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 12px 0; }.option-row label > span { display: block; margin: 0 0 6px 3px; color: #92969f; font-size: 11px; }.option-row select { width: 100%; height: 42px; padding: 0 10px; color: #fff; border: 1px solid var(--line); border-radius: 12px; background: #0e1014; }.imagine-button { height: 50px; margin-top: 4px; background: linear-gradient(120deg,#fff,#cfc5ff); }.gallery-section { max-width: 620px; margin: 0 auto; }.section-heading { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 11px; }.section-heading h2 { margin: 0; font-size: 18px; }.section-heading span { color: #8d919b; font-size: 12px; }.gallery-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }.gallery-grid figure { position: relative; aspect-ratio: 1; margin: 0; overflow: hidden; border-radius: 17px; background: #17191f; }.gallery-grid img { width: 100%; height: 100%; object-fit: cover; }
.page-title { max-width: 620px; margin: 4px auto 24px; }.new-chat-card,.history-list article { display: flex; align-items: center; width: 100%; max-width: 620px; margin: 0 auto 10px; color: #fff; border: 1px solid var(--line); border-radius: 17px; background: #14171c; text-align: left; }.new-chat-card { gap: 13px; padding: 14px; }.new-chat-card > span { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 13px; background: #fff; color: #0a0b0e; font-size: 22px; }.new-chat-card div,.history-list article div:nth-child(2) { min-width: 0; flex: 1; }.new-chat-card strong,.new-chat-card small,.history-list strong,.history-list small { display: block; }.new-chat-card small,.history-list small { margin-top: 4px; color: #858a94; font-size: 11px; }.history-list article { gap: 11px; padding: 12px; cursor: pointer; }.history-icon { flex: 0 0 36px; width: 36px; height: 36px; border-radius: 12px; }.history-list strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }.history-list article > button { color: #898d96; border: 0; background: transparent; font-size: 22px; }.empty-list { color: #777c85; text-align: center; }
.usage-card { display: grid; grid-template-columns: 1fr 1fr auto; align-items: center; gap: 12px; background: linear-gradient(120deg,#1d2230,#15171c); }.usage-card small,.usage-card strong { display: block; }.usage-card small { color: #8f949e; font-size: 10px; }.usage-card strong { margin-top: 4px; font-size: 17px; }.usage-card button { padding: 8px 10px; color: #dfe1e6; border: 1px solid var(--line); border-radius: 10px; background: #262a32; font-size: 11px; }.settings-card h2 { margin: 0 0 12px; font-size: 16px; }.reasoning-option { display: flex; align-items: center; gap: 11px; padding: 12px 4px; border-top: 1px solid var(--line); }.reasoning-option:first-of-type { border-top: 0; }.reasoning-option input { display: none; }.reasoning-option > span { flex: 1; }.reasoning-option strong,.reasoning-option small { display: block; }.reasoning-option small { margin-top: 3px; color: #858a94; font-size: 11px; }.reasoning-option em { display: grid; place-items: center; width: 23px; height: 23px; color: #0b0d11; border-radius: 50%; background: #fff; font-style: normal; font-size: 12px; }.account-card > div { display: flex; justify-content: space-between; gap: 14px; padding: 12px 0; border-top: 1px solid var(--line); color: #979ba4; font-size: 13px; }.account-card code,.account-card strong { color: #eeeef0; font-size: 12px; }.account-card .online { color: #72dc92; }.danger-button { width: 100%; margin-top: 14px; padding: 12px; color: #ffaaaa; border: 1px solid rgba(255,100,100,.2); border-radius: 13px; background: rgba(130,30,30,.12); }
.bottom-nav { display: grid; grid-template-columns: repeat(4,1fr); padding: 6px 8px max(6px,env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: rgba(12,14,18,.94); backdrop-filter: blur(18px); z-index: 8; }.bottom-nav button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; color: #717681; border: 0; background: transparent; font-size: 9px; }.bottom-nav button.active { color: #fff; }.bottom-nav svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }.hidden-input { position: fixed; left: -9999px; opacity: 0; }
@media (min-width: 761px) { .grok-mobile { padding: 16px; background: radial-gradient(circle at top,#202530,#090b0f 45%); }.app-shell { height: calc(100dvh - 32px); border-radius: 24px; overflow: hidden; box-shadow: 0 24px 90px rgba(0,0,0,.5); }.composer-wrap { padding-inline: 28px; }.messages { padding-inline: 30px; } }
@media (max-width: 520px) { .mode-banner { align-items: stretch; flex-wrap: wrap; }.mode-title { flex: 1; min-height: 36px; }.image-quick-options { order: 3; flex-basis: 100%; justify-content: stretch; }.image-quick-options label { flex: 1; }.image-quick-options select,.image-quick-options label:nth-child(2) select { width: 100%; min-width: 0; }.mode-banner .mode-close { min-height: 36px; } }
@media (max-width: 390px) { .model-chip small { display: none; }.balance-pill { padding-inline: 7px; }.suggestion-grid { grid-template-columns: 1fr; }.usage-card { grid-template-columns: 1fr 1fr; }.usage-card button { grid-column: 1/-1; }.composer { grid-template-columns: 34px minmax(0,1fr) 32px 36px; padding: 6px 5px; } }

/* Grok Workspace 2.0 — responsive product shell */
.grok-mobile {
  --violet: #8b5cf6;
  --violet-bright: #a78bfa;
  --indigo: #6366f1;
  --surface-0: #08090d;
  --surface-1: #0e1016;
  --surface-2: #151821;
  --surface-3: #1c202b;
  --text-1: #f7f7fb;
  --text-2: #b6bac6;
  --text-3: #7d8393;
  --line: rgba(255,255,255,.085);
  --focus: 0 0 0 3px rgba(139,92,246,.32);
  background: var(--surface-0);
}
.desktop-sidebar { display: none; }
.desktop-mode-switch,.desktop-quick-actions,.desktop-heading { display: none; }
button, select, a { cursor: pointer; }
button { transition: color .18s ease, background-color .18s ease, border-color .18s ease, opacity .18s ease, box-shadow .18s ease; }
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: none; box-shadow: var(--focus); }
.connect-screen { background: radial-gradient(circle at 16% 12%,rgba(99,102,241,.2),transparent 34%),radial-gradient(circle at 84% 84%,rgba(139,92,246,.15),transparent 36%),#08090d; }
.connect-card { border-color: rgba(255,255,255,.12); background: rgba(15,17,24,.82); box-shadow: 0 32px 100px rgba(0,0,0,.58); }
.brand-mark, .orb { background: linear-gradient(145deg,#a78bfa,#6366f1); }
.brand-mark { color: white; transform: none; border-radius: 17px; }
.primary-button { color: white; background: linear-gradient(135deg,var(--violet),var(--indigo)); box-shadow: 0 10px 30px rgba(99,102,241,.22); }
.primary-button:hover:not(:disabled) { background: linear-gradient(135deg,#9d75f7,#7477f4); }
.app-shell { max-width: none; background: var(--surface-0); border: 0; }
.app-header { height: 64px; padding-inline: 16px; background: rgba(8,9,13,.82); }
.icon-button { width: 44px; height: 44px; border-radius: 14px; background: var(--surface-2); }
.model-chip { min-height: 44px; border-radius: 14px; }
.model-chip:hover { background: rgba(255,255,255,.055); }
.model-dot { background: #34d399; box-shadow: 0 0 12px rgba(52,211,153,.7); }
.balance-pill { min-height: 44px; padding-inline: 12px; border-radius: 14px; background: var(--surface-2); }
.chat-page, .imagine-page, .history-page, .settings-page { background: radial-gradient(circle at 50% -18%,rgba(99,102,241,.075),transparent 40%),var(--surface-0); }
.messages { padding: 20px 16px 190px; }
.empty-chat { justify-content: center; max-width: 720px; margin: auto; }
.orb { width: 72px; height: 72px; box-shadow: 0 0 72px rgba(139,92,246,.26); }
.orb span { color: white; background: rgba(9,10,15,.82); }
.empty-kicker { margin: 0 0 10px; color: var(--violet-bright); font-size: 11px; font-weight: 800; letter-spacing: .16em; }
.empty-chat h2 { font-size: clamp(28px,7vw,44px); font-weight: 720; letter-spacing: -.045em; }
.empty-chat > p { color: var(--text-2); }
.suggestion-grid { gap: 10px; width: min(100%,560px); }
.suggestion-grid button { position: relative; min-height: 76px; padding: 16px; color: var(--text-2); border-radius: 18px; background: rgba(21,24,33,.72); line-height: 1.4; }
.suggestion-grid button:hover { color: white; border-color: rgba(167,139,250,.42); background: rgba(30,32,46,.9); }
.message-row { max-width: 780px; margin-bottom: 28px; }
.assistant-avatar, .history-icon { color: white; background: linear-gradient(145deg,var(--violet),var(--indigo)); }
.message-user .message-content { padding: 12px 16px; border: 1px solid rgba(255,255,255,.06); background: var(--surface-3); }
.markdown-body { color: var(--text-1); font-size: 15px; }
.composer-wrap { padding: 22px 12px 10px; background: linear-gradient(transparent,rgba(8,9,13,.96) 28%,var(--surface-0) 56%); }
.composer { max-width: 820px; margin: 0 auto; min-height: 58px; padding: 9px; border-color: rgba(255,255,255,.13); border-radius: 24px; background: rgba(25,28,38,.96); box-shadow: 0 18px 60px rgba(0,0,0,.48); }
.composer:focus-within { border-color: rgba(167,139,250,.5); box-shadow: 0 18px 60px rgba(0,0,0,.48),0 0 0 3px rgba(139,92,246,.12); }
.composer-action,.spark-button,.send-button { width: 40px; height: 40px; }
.spark-button svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; }
.spark-button.active { color: white; background: linear-gradient(145deg,var(--violet),var(--indigo)); }
.send-button { color: white; background: linear-gradient(145deg,var(--violet),var(--indigo)); }
.send-button:disabled { color: #6e7380; background: #292d37; }
.composer-note { color: var(--text-3); font-size: 10px; }
.mode-banner { max-width: 820px; margin-inline: auto; color: #ddd6fe; border-color: rgba(139,92,246,.28); background: rgba(109,40,217,.14); }
.attachment-strip { max-width: 820px; margin-inline: auto; }
.scroll-page { padding: 32px 18px 72px; }
.imagine-page { background: radial-gradient(circle at 50% 0,rgba(124,58,237,.2),transparent 38%),var(--surface-0); }
.imagine-spark { display: grid; place-items: center; width: 56px; height: 56px; margin: 0 auto 16px; border: 1px solid rgba(167,139,250,.25); border-radius: 18px; background: rgba(109,40,217,.16); }
.imagine-spark svg { width: 28px; fill: none; stroke: #c4b5fd; stroke-width: 1.6; }
.imagine-card,.settings-card,.usage-card { border-radius: 24px; background: rgba(21,24,33,.82); box-shadow: 0 18px 50px rgba(0,0,0,.16); }
.imagine-card textarea,.option-row select { border-color: rgba(255,255,255,.1); background: rgba(8,9,13,.72); }
.imagine-button { color: white; background: linear-gradient(135deg,var(--violet),var(--indigo)); }
.gallery-grid { gap: 12px; }
.gallery-grid figure { border-radius: 20px; }
.new-chat-card,.history-list article { min-height: 64px; border-radius: 18px; background: rgba(21,24,33,.82); }
.new-chat-card:hover,.history-list article:hover { border-color: rgba(167,139,250,.28); background: var(--surface-3); }
.usage-card { background: linear-gradient(135deg,rgba(109,40,217,.25),rgba(30,33,46,.92)); }
.reasoning-option { min-height: 64px; cursor: pointer; }
.reasoning-option:hover { background: rgba(255,255,255,.025); }
.reasoning-option em { color: white; background: linear-gradient(145deg,var(--violet),var(--indigo)); }
.bottom-nav { min-height: 70px; padding-top: 8px; background: rgba(10,11,16,.94); }
.bottom-nav button { min-width: 48px; min-height: 48px; border-radius: 14px; font-size: 10px; }
.bottom-nav button.active { color: #c4b5fd; background: rgba(139,92,246,.1); }

@media (min-width: 900px) {
  .grok-mobile { padding: 0; background: var(--surface-0); }
  .app-shell { height: 100dvh; display: grid; grid-template-columns: 272px minmax(0,1fr); grid-template-rows: 64px minmax(0,1fr); grid-template-areas: "sidebar header" "sidebar main"; border-radius: 0; box-shadow: none; }
  .desktop-sidebar { grid-area: sidebar; display: flex; flex-direction: column; min-width: 0; padding: 20px 14px 16px; border-right: 1px solid var(--line); background: #0c0e14; }
  .sidebar-brand { display: flex; align-items: center; gap: 12px; padding: 0 8px 20px; }
  .brand-glyph { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 13px; color: white; background: linear-gradient(145deg,var(--violet),var(--indigo)); font-size: 19px; font-weight: 900; box-shadow: 0 9px 26px rgba(99,102,241,.28); }
  .sidebar-brand strong,.sidebar-brand small { display: block; }.sidebar-brand strong { font-size: 18px; }.sidebar-brand small { margin-top: 2px; color: var(--text-3); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
  .sidebar-new { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 46px; padding: 0 14px; color: white; border: 1px solid rgba(167,139,250,.22); border-radius: 14px; background: linear-gradient(135deg,rgba(124,58,237,.24),rgba(79,70,229,.17)); font-weight: 700; }
  .sidebar-new:hover { border-color: rgba(167,139,250,.52); background: linear-gradient(135deg,rgba(124,58,237,.34),rgba(79,70,229,.24)); }
  .sidebar-new svg,.sidebar-nav svg,.sidebar-settings svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .sidebar-nav { display: grid; gap: 4px; margin-top: 16px; }
  .sidebar-nav button,.sidebar-settings { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; padding: 0 13px; color: var(--text-2); border: 0; border-radius: 12px; background: transparent; text-align: left; }
  .sidebar-nav button:hover,.sidebar-settings:hover,.sidebar-nav button.active,.sidebar-settings.active { color: white; background: rgba(255,255,255,.06); }
  .sidebar-nav button.active { color: #ddd6fe; background: rgba(139,92,246,.13); }
  .sidebar-recents { min-height: 0; flex: 1; margin-top: 24px; overflow: hidden; }
  .sidebar-recents > p { margin: 0 12px 8px; color: var(--text-3); font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .sidebar-recents button { display: block; width: 100%; padding: 10px 12px; overflow: hidden; color: #969ba8; border: 0; border-radius: 10px; background: transparent; text-align: left; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .sidebar-recents button:hover,.sidebar-recents button.active { color: white; background: rgba(255,255,255,.045); }
  .sidebar-footer { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); }
  .sidebar-usage { display: grid; gap: 5px; padding: 12px; color: var(--text-2); border: 1px solid var(--line); border-radius: 14px; background: var(--surface-2); text-align: left; }
  .sidebar-usage span { font-size: 10px; }.sidebar-usage i { display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: #34d399; }.sidebar-usage strong { color: white; font-size: 16px; }
  .app-header { grid-area: header; grid-template-columns: 1fr auto; padding-inline: 28px; }
  .app-header .icon-button { display: none; }
  .model-chip { justify-self: start; }
  .balance-pill { display: none; }
  .chat-page,.scroll-page { grid-area: main; }
  .bottom-nav { display: none; }
  .messages { padding: 32px clamp(28px,6vw,96px) 190px; }
  .composer-wrap { padding-inline: clamp(28px,6vw,96px); }
  .scroll-page { padding: 48px clamp(32px,6vw,88px) 80px; }
  .imagine-card,.gallery-section,.page-title,.new-chat-card,.history-list article,.usage-card,.settings-card { max-width: 780px; }
  .gallery-grid { grid-template-columns: repeat(3,1fr); }
}

@media (min-width: 1300px) {
  .app-shell { grid-template-columns: 292px minmax(0,1fr); }
  .message-row,.composer,.mode-banner,.attachment-strip { max-width: 900px; }
  .suggestion-grid { grid-template-columns: repeat(2,1fr); }
}

/* Desktop conversation shell — intentionally neutral and distraction-free. */
@media (min-width: 900px) {
  .grok-mobile {
    --surface-0: #090909;
    --surface-1: #0d0d0d;
    --surface-2: #171717;
    --surface-3: #242424;
    --text-1: #f4f4f4;
    --text-2: #b4b4b4;
    --text-3: #777;
    --line: rgba(255,255,255,.09);
    --focus: 0 0 0 3px rgba(255,255,255,.2);
  }
  .app-shell {
    grid-template-columns: 260px minmax(0,1fr);
    grid-template-rows: 60px minmax(0,1fr);
    background: #090909;
    transition: grid-template-columns .22s ease;
  }
  .app-shell.sidebar-collapsed { grid-template-columns: 64px minmax(0,1fr); }
  .desktop-sidebar {
    padding: 10px 8px 12px;
    border-right-color: rgba(255,255,255,.055);
    background: #111;
  }
  .sidebar-brand {
    min-height: 42px;
    gap: 10px;
    padding: 0 4px 8px;
  }
  .brand-glyph {
    flex: 0 0 34px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: #050505;
    background: #f4f4f4;
    box-shadow: none;
    font-size: 16px;
  }
  .sidebar-brand-copy { min-width: 0; flex: 1; }
  .sidebar-brand strong { font-size: 15px; }
  .sidebar-brand small { color: #777; font-size: 9px; }
  .sidebar-toggle {
    display: grid;
    place-items: center;
    flex: 0 0 34px;
    width: 34px;
    height: 34px;
    padding: 0;
    color: #aaa;
    border: 0;
    border-radius: 9px;
    background: transparent;
  }
  .sidebar-toggle:hover { color: #fff; background: #242424; }
  .sidebar-toggle svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.7; }
  .sidebar-new {
    min-height: 42px;
    padding: 0 12px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    font-weight: 500;
  }
  .sidebar-new:hover { border-color: transparent; background: #242424; }
  .sidebar-nav { flex: 0 0 auto; grid-auto-rows: 40px; align-content: start; margin-top: 5px; }
  .sidebar-nav button,.sidebar-settings {
    min-height: 40px;
    padding: 0 12px;
    border-radius: 9px;
    color: #b8b8b8;
  }
  .sidebar-nav button:hover,.sidebar-settings:hover,.sidebar-nav button.active,.sidebar-settings.active {
    color: #f5f5f5;
    background: #242424;
  }
  .sidebar-nav button.active { color: #fff; background: #292929; }
  .sidebar-recents { margin-top: 20px; }
  .sidebar-recents > p { margin-left: 12px; color: #707070; letter-spacing: 0; text-transform: none; }
  .sidebar-recents button { padding: 9px 12px; color: #aaa; font-size: 12px; }
  .sidebar-recents button:hover,.sidebar-recents button.active { background: #202020; }
  .sidebar-footer { border-top-color: rgba(255,255,255,.06); }
  .sidebar-usage { border: 0; border-radius: 10px; background: transparent; }
  .sidebar-usage:hover { background: #202020; }
  .sidebar-settings svg,.sidebar-new svg,.sidebar-nav svg { flex: 0 0 20px; }
  .sidebar-collapsed .sidebar-brand { justify-content: center; padding-inline: 0; }
  .sidebar-collapsed .brand-glyph,.sidebar-collapsed .sidebar-brand-copy,
  .sidebar-collapsed .sidebar-new span,.sidebar-collapsed .sidebar-nav span,
  .sidebar-collapsed .sidebar-recents,.sidebar-collapsed .sidebar-usage,
  .sidebar-collapsed .sidebar-settings span { display: none; }
  .sidebar-collapsed .sidebar-new,.sidebar-collapsed .sidebar-nav button,.sidebar-collapsed .sidebar-settings {
    justify-content: center;
    padding: 0;
  }
  .sidebar-collapsed .sidebar-footer { margin-top: auto; }
  .app-header {
    position: relative;
    grid-template-columns: 1fr;
    height: 60px;
    padding: 0 20px;
    border-bottom: 0;
    background: #090909;
  }
  .app-header .model-chip { display: none; }
  .desktop-mode-switch {
    position: absolute;
    left: 50%;
    top: 10px;
    display: flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 12px;
    background: #171717;
    transform: translateX(-50%);
  }
  .desktop-mode-switch button {
    min-width: 106px;
    min-height: 34px;
    padding: 0 14px;
    color: #888;
    border: 0;
    border-radius: 9px;
    background: transparent;
    font-size: 13px;
    font-weight: 600;
  }
  .desktop-mode-switch button:hover { color: #ddd; }
  .desktop-mode-switch button.active { color: #f5f5f5; background: #2a2a2a; box-shadow: 0 1px 2px rgba(0,0,0,.5); }
  .chat-page,.imagine-page,.history-page,.settings-page { background: #090909; }
  .messages { padding: 28px clamp(32px,7vw,112px) 170px; }
  .empty-chat { max-width: 760px; }
  .empty-chat .orb,.empty-chat .empty-kicker,.empty-chat > p,.empty-chat .suggestion-grid { display: none; }
  .empty-chat h2 {
    margin: 0;
    color: #f0f0f0;
    font-size: clamp(28px,3vw,38px);
    font-weight: 650;
    letter-spacing: -.035em;
  }
  .empty-chat .mobile-heading { display: none; }
  .empty-chat .desktop-heading { display: inline; }
  .chat-empty .messages { padding-bottom: 0; }
  .chat-empty .empty-chat {
    height: 100%;
    justify-content: center;
    transform: translateY(-112px);
  }
  .chat-empty .composer-wrap {
    top: calc(50% - 46px);
    bottom: auto;
    padding-top: 0;
    background: transparent;
  }
  .composer-wrap {
    padding-inline: clamp(36px,8vw,132px);
    background: linear-gradient(transparent,rgba(9,9,9,.98) 36%,#090909 64%);
  }
  .composer {
    max-width: 760px;
    min-height: 58px;
    padding: 8px 9px;
    border-color: #353535;
    border-radius: 25px;
    background: #242424;
    box-shadow: none;
  }
  .composer:hover { border-color: #444; }
  .composer:focus-within { border-color: #555; box-shadow: 0 0 0 3px rgba(255,255,255,.07); }
  .composer textarea { color: #f5f5f5; }
  .composer-action,.spark-button { color: #aaa; }
  .composer-action:hover,.spark-button:hover { color: #fff; background: #343434; }
  .spark-button.active { color: #111; background: #eee; }
  .send-button { color: #111; background: #eee; }
  .send-button:disabled { color: #777; background: #393939; }
  .desktop-quick-actions {
    display: flex;
    justify-content: center;
    gap: 10px;
    max-width: 760px;
    margin: 16px auto 0;
  }
  .desktop-quick-actions button {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1;
    padding: 10px 12px;
    color: #aaa;
    border: 1px solid #292929;
    border-radius: 13px;
    background: transparent;
    text-align: left;
  }
  .desktop-quick-actions button:hover { color: #eee; border-color: #404040; background: #151515; }
  .desktop-quick-actions svg { flex: 0 0 19px; width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .desktop-quick-actions span,.desktop-quick-actions strong,.desktop-quick-actions small { display: block; min-width: 0; }
  .desktop-quick-actions strong { color: #ddd; font-size: 12px; font-weight: 600; }
  .desktop-quick-actions small { margin-top: 2px; overflow: hidden; color: #707070; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
  .chat-empty .composer-note { margin-top: 12px; }
  .message-row { max-width: 760px; }
  .assistant-avatar { color: #111; background: #eee; }
  .message-user .message-content { background: #242424; }
  .imagine-page { background: #090909; }
  .imagine-spark { border-color: #333; background: #181818; }
  .imagine-spark svg { stroke: #ddd; }
  .imagine-card,.settings-card,.usage-card { background: #171717; }
  .imagine-button,.reasoning-option em { color: #111; background: #eee; }
}

@media (min-width: 900px) and (max-height: 700px) {
  .chat-empty .empty-chat { transform: translateY(-92px); }
  .chat-empty .composer-wrap { top: calc(50% - 40px); }
  .desktop-quick-actions small { display: none; }
}

@media (max-width: 899px) and (orientation: landscape) {
  .empty-chat { justify-content: flex-start; }
  .orb { width: 54px; height: 54px; margin-bottom: 10px; }
  .suggestion-grid { grid-template-columns: repeat(2,1fr); }
}

@media (prefers-reduced-motion: reduce) {
  *,*::before,*::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}

/* Adaptive theme system — informed by Grok's monochrome identity and ChatGPT's quiet workspace. */
.grok-mobile[data-theme="dark"] {
  --theme-canvas: #0a0a0a;
  --theme-sidebar: #111111;
  --theme-surface: #171717;
  --theme-surface-raised: #1d1d1d;
  --theme-surface-hover: #222222;
  --theme-surface-active: #292929;
  --theme-input: #202020;
  --theme-text: #f4f4f4;
  --theme-text-secondary: #b8b8b8;
  --theme-text-tertiary: #7c7c7c;
  --theme-border: rgba(255,255,255,.1);
  --theme-border-strong: rgba(255,255,255,.18);
  --theme-accent: #f1f1f1;
  --theme-on-accent: #111111;
  --theme-success: #34d399;
  --theme-danger: #ff8f8f;
  --theme-focus: 0 0 0 3px rgba(255,255,255,.18);
  --theme-shadow: 0 18px 48px rgba(0,0,0,.34);
  color-scheme: dark;
}
.grok-mobile[data-theme="light"] {
  --theme-canvas: #ffffff;
  --theme-sidebar: #f7f7f5;
  --theme-surface: #ffffff;
  --theme-surface-raised: #fafafa;
  --theme-surface-hover: #ececea;
  --theme-surface-active: #e6e6e3;
  --theme-input: #f3f3f1;
  --theme-text: #171717;
  --theme-text-secondary: #525252;
  --theme-text-tertiary: #777773;
  --theme-border: rgba(23,23,23,.1);
  --theme-border-strong: rgba(23,23,23,.18);
  --theme-accent: #171717;
  --theme-on-accent: #ffffff;
  --theme-success: #087f5b;
  --theme-danger: #b42318;
  --theme-focus: 0 0 0 3px rgba(23,23,23,.14);
  --theme-shadow: 0 18px 48px rgba(30,30,20,.1);
  color-scheme: light;
}
:global(html:has(.grok-mobile[data-theme="dark"])),
:global(body:has(.grok-mobile[data-theme="dark"])),
:global(#app:has(.grok-mobile[data-theme="dark"])) { background: #0a0a0a; color-scheme: dark; }
:global(html:has(.grok-mobile[data-theme="light"])),
:global(body:has(.grok-mobile[data-theme="light"])),
:global(#app:has(.grok-mobile[data-theme="light"])) { background: #fff; color-scheme: light; }

.grok-mobile { color: var(--theme-text); background: var(--theme-canvas); }
.app-shell,.chat-page,.imagine-page,.history-page,.settings-page { background: var(--theme-canvas); }
.app-header { border-color: var(--theme-border); background: color-mix(in srgb,var(--theme-canvas) 88%,transparent); }
.icon-button,.balance-pill { color: var(--theme-text); border-color: var(--theme-border); background: var(--theme-surface-raised); }
.model-chip { color: var(--theme-text); }.model-chip small { color: var(--theme-text-tertiary); }
.balance-pill small,.composer-note,.empty-chat > p { color: var(--theme-text-tertiary); }
.connect-screen { background: var(--theme-canvas); }
.connect-glow { display: none; }
.connect-card { color: var(--theme-text); border-color: var(--theme-border); background: var(--theme-surface); box-shadow: var(--theme-shadow); }
.connect-copy,.usage-link,.remember-row { color: var(--theme-text-secondary); }
.key-field span { color: var(--theme-text-secondary); }
.key-field input { color: var(--theme-text); border-color: var(--theme-border); background: var(--theme-input); }
.key-field input:focus { border-color: var(--theme-border-strong); box-shadow: var(--theme-focus); }
.brand-mark { color: var(--theme-text); border: 1px solid var(--theme-border); background: var(--theme-surface-raised); box-shadow: none; }
.brand-mark .grok-logo { width: 30px; height: 30px; }
.primary-button,.imagine-button { color: var(--theme-on-accent); background: var(--theme-accent); box-shadow: none; }
.primary-button:hover:not(:disabled),.imagine-button:hover:not(:disabled) { opacity: .88; background: var(--theme-accent); }

.messages { scrollbar-color: var(--theme-border-strong) transparent; }
.message-user .message-content { color: var(--theme-text); border-color: var(--theme-border); background: var(--theme-surface-hover); }
.markdown-body { color: var(--theme-text); }
.markdown-body :deep(pre) { border-color: var(--theme-border); background: var(--theme-surface-raised); }
.markdown-body :deep(a) { color: var(--theme-text); text-decoration: underline; text-underline-offset: 3px; }
.message-error .message-content,.form-error { color: var(--theme-danger); }
.assistant-avatar { color: var(--theme-text); background: transparent; }
.assistant-avatar .grok-logo { width: 22px; height: 22px; }
.orb { color: var(--theme-text); border: 1px solid var(--theme-border); background: var(--theme-surface); box-shadow: none; }
.orb span { color: inherit; background: transparent; }.orb .grok-logo { width: 32px; height: 32px; }
.suggestion-grid button { color: var(--theme-text-secondary); border-color: var(--theme-border); background: var(--theme-surface); }
.suggestion-grid button:hover { color: var(--theme-text); border-color: var(--theme-border-strong); background: var(--theme-surface-hover); }
.composer-wrap { background: linear-gradient(transparent,color-mix(in srgb,var(--theme-canvas) 96%,transparent) 32%,var(--theme-canvas) 60%); }
.composer { border-color: var(--theme-border-strong); background: var(--theme-input); box-shadow: var(--theme-shadow); }
.composer:hover,.composer:focus-within { border-color: var(--theme-border-strong); box-shadow: var(--theme-shadow),var(--theme-focus); }
.composer textarea { color: var(--theme-text); }.composer textarea::placeholder { color: var(--theme-text-tertiary); }
.composer-action,.spark-button { color: var(--theme-text-secondary); }
.composer-action:hover,.spark-button:hover { color: var(--theme-text); background: var(--theme-surface-hover); }
.spark-button.active,.send-button { color: var(--theme-on-accent); background: var(--theme-accent); }
.send-button:disabled { color: var(--theme-text-tertiary); background: var(--theme-surface-active); }
.mode-banner { color: var(--theme-text); border-color: var(--theme-border); background: var(--theme-surface-raised); }
.image-quick-options label > span,.mode-banner .mode-close { color: var(--theme-text-tertiary); }
.image-quick-options select { color: var(--theme-text); border-color: var(--theme-border); background: var(--theme-input); }
.mode-banner .mode-close:hover { color: var(--theme-text); background: var(--theme-surface-hover); }
.desktop-quick-actions button { color: var(--theme-text-secondary); border-color: var(--theme-border); background: transparent; }
.desktop-quick-actions button:hover { color: var(--theme-text); border-color: var(--theme-border-strong); background: var(--theme-surface-raised); }
.desktop-quick-actions strong { color: var(--theme-text); }.desktop-quick-actions small { color: var(--theme-text-tertiary); }

.scroll-page,.imagine-page { background: var(--theme-canvas); }
.imagine-spark { color: var(--theme-text); border-color: var(--theme-border); background: var(--theme-surface-raised); text-shadow: none; }
.imagine-spark svg { stroke: currentColor; }
.imagine-hero > p:last-child,.option-row label > span,.section-heading span,.empty-list { color: var(--theme-text-tertiary); }
.imagine-card,.settings-card,.usage-card { color: var(--theme-text); border-color: var(--theme-border); background: var(--theme-surface); box-shadow: none; }
.imagine-card textarea,.option-row select { color: var(--theme-text); border-color: var(--theme-border); background: var(--theme-input); }
.new-chat-card,.history-list article { color: var(--theme-text); border-color: var(--theme-border); background: var(--theme-surface); }
.new-chat-card:hover,.history-list article:hover { border-color: var(--theme-border-strong); background: var(--theme-surface-hover); }
.new-chat-card > span,.history-icon { color: var(--theme-on-accent); background: var(--theme-accent); }
.history-icon .grok-logo { width: 19px; height: 19px; }
.new-chat-card small,.history-list small { color: var(--theme-text-tertiary); }
.history-list article > button { color: var(--theme-text-tertiary); }
.usage-card { background: var(--theme-surface-raised); }.usage-card small { color: var(--theme-text-tertiary); }
.usage-card button { color: var(--theme-text); border-color: var(--theme-border); background: var(--theme-surface-hover); }
.reasoning-option { border-color: var(--theme-border); }.reasoning-option:hover { background: var(--theme-surface-raised); }
.reasoning-option small,.account-card > div { color: var(--theme-text-tertiary); }.account-card > div { border-color: var(--theme-border); }
.account-card code,.account-card strong { color: var(--theme-text); }.account-card .online { color: var(--theme-success); }
.reasoning-option em { color: var(--theme-on-accent); background: var(--theme-accent); }
.danger-button { color: var(--theme-danger); border-color: color-mix(in srgb,var(--theme-danger) 24%,transparent); background: color-mix(in srgb,var(--theme-danger) 8%,transparent); }
.theme-segment { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 4px; border: 1px solid var(--theme-border); border-radius: 14px; background: var(--theme-input); }
.theme-segment button { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; color: var(--theme-text-secondary); border: 0; border-radius: 10px; background: transparent; font-weight: 650; }
.theme-segment button.active { color: var(--theme-text); background: var(--theme-surface); box-shadow: 0 1px 3px color-mix(in srgb,var(--theme-text) 12%,transparent); }
.theme-segment svg,.theme-toggle svg,.theme-toggle-mobile svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.theme-toggle-mobile { display: grid; place-items: center; width: 40px; height: 40px; padding: 0; color: var(--theme-text-secondary); border: 0; border-radius: 12px; background: transparent; }
.theme-toggle-mobile:hover { color: var(--theme-text); background: var(--theme-surface-hover); }
.bottom-nav { border-color: var(--theme-border); background: color-mix(in srgb,var(--theme-canvas) 94%,transparent); }
.bottom-nav button { color: var(--theme-text-tertiary); }.bottom-nav button.active { color: var(--theme-text); background: var(--theme-surface-hover); }
.mobile-mode-switch,.mobile-history-button,.mobile-drawer,.mobile-drawer-scrim { display: none; }

@media (max-width: 899px) {
  .app-shell { grid-template-rows: auto minmax(0,1fr); }
  .app-header {
    grid-template-columns: 52px minmax(0,1fr) 52px;
    gap: 10px;
    height: calc(78px + env(safe-area-inset-top,0px));
    padding: env(safe-area-inset-top,0px) 16px 8px;
    border: 0;
    background: var(--theme-canvas);
    backdrop-filter: none;
  }
  .mobile-menu-button,.mobile-history-button {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    padding: 0;
    color: var(--theme-text);
    border: 1px solid var(--theme-border);
    border-radius: 50%;
    background: var(--theme-surface-raised);
  }
  .mobile-menu-button svg,.mobile-history-button svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .mobile-mode-switch {
    display: grid;
    grid-template-columns: 1fr 1fr;
    width: min(100%,320px);
    height: 54px;
    margin: 0 auto;
    padding: 5px;
    border: 1px solid var(--theme-border);
    border-radius: 27px;
    background: var(--theme-surface-raised);
  }
  .mobile-mode-switch button { color: var(--theme-text-secondary); border: 0; border-radius: 22px; background: transparent; font-size: 15px; font-weight: 620; }
  .mobile-mode-switch button.active { color: var(--theme-text); background: var(--theme-surface-active); box-shadow: 0 1px 3px color-mix(in srgb,var(--theme-text) 10%,transparent); }
  .desktop-mode-switch { display: none; }
  .bottom-nav { display: none; }
  .messages { padding: 14px 16px 158px; }
  .chat-empty .empty-chat { display: none; }
  .composer-wrap { padding: 28px 14px max(12px,env(safe-area-inset-bottom)); background: linear-gradient(transparent,var(--theme-canvas) 28%); }
  .composer {
    grid-template-columns: 48px minmax(0,1fr) 48px 48px;
    grid-template-rows: minmax(44px,auto) 48px;
    align-items: center;
    gap: 4px;
    min-height: 112px;
    padding: 12px;
    border-color: var(--theme-border-strong);
    border-radius: 30px;
    background: var(--theme-input);
    box-shadow: none;
  }
  .composer textarea { grid-column: 1/-1; grid-row: 1; min-height: 44px; padding: 6px 10px; color: var(--theme-text); }
  .composer-action { grid-column: 1; grid-row: 2; }
  .spark-button { grid-column: 3; grid-row: 2; }
  .send-button { grid-column: 4; grid-row: 2; }
  .composer-action,.spark-button,.send-button { width: 48px; height: 48px; }
  .composer-action svg,.spark-button svg,.send-button svg { width: 25px; height: 25px; }
  .composer-note { display: none; }
  .mode-banner { margin-inline: 3px; }

  .mobile-drawer-scrim { position: fixed; inset: 0; display: block; z-index: 40; background: rgba(0,0,0,.52); backdrop-filter: blur(2px); }
  .mobile-drawer {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 41;
    display: flex;
    flex-direction: column;
    width: min(86vw,380px);
    padding: max(18px,env(safe-area-inset-top)) 18px max(18px,env(safe-area-inset-bottom));
    color: var(--theme-text);
    background: var(--theme-sidebar);
    box-shadow: 24px 0 80px rgba(0,0,0,.32);
    transform: translateX(-105%);
    transition: transform .22s ease;
  }
  .mobile-drawer.open { transform: translateX(0); }
  .mobile-drawer-head { display: flex; align-items: center; justify-content: space-between; min-height: 52px; }
  .mobile-drawer-brand { display: flex; align-items: center; gap: 12px; font-size: 23px; letter-spacing: -.03em; }
  .mobile-drawer-brand .grok-logo { width: 30px; height: 30px; }
  .mobile-drawer-head > button,.mobile-drawer-theme { display: grid; place-items: center; width: 48px; height: 48px; padding: 0; color: var(--theme-text); border: 0; border-radius: 50%; background: var(--theme-surface-raised); }
  .mobile-drawer-head svg,.mobile-drawer-theme svg { width: 23px; height: 23px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
  .mobile-search { display: flex; align-items: center; gap: 12px; min-height: 50px; margin: 18px 0 10px; padding: 0 15px; color: var(--theme-text-secondary); border: 1px solid var(--theme-border); border-radius: 16px; background: var(--theme-input); text-align: left; }
  .mobile-search svg,.mobile-drawer-nav svg,.mobile-drawer-new svg { flex: 0 0 24px; width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .mobile-drawer-nav { display: grid; gap: 2px; padding-bottom: 14px; border-bottom: 1px solid var(--theme-border); }
  .mobile-drawer-nav button { display: flex; align-items: center; gap: 14px; min-height: 52px; padding: 0 12px; color: var(--theme-text); border: 0; border-radius: 14px; background: transparent; text-align: left; font-size: 16px; }
  .mobile-drawer-nav button:active { background: var(--theme-surface-active); }
  .mobile-recents { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 4px 18px; overscroll-behavior: contain; }
  .mobile-recents h2 { margin: 0 8px 12px; font-size: 14px; }
  .mobile-recents button { display: block; width: 100%; min-height: 48px; padding: 0 8px; overflow: hidden; color: var(--theme-text-secondary); border: 0; border-radius: 11px; background: transparent; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-recents button:active { color: var(--theme-text); background: var(--theme-surface-active); }
  .mobile-recents p { margin: 12px 8px; color: var(--theme-text-tertiary); font-size: 13px; }
  .mobile-drawer-footer { display: grid; grid-template-columns: minmax(0,1fr) 48px; gap: 10px; padding-top: 14px; border-top: 1px solid var(--theme-border); }
  .mobile-drawer-new { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 52px; color: var(--theme-canvas); border: 0; border-radius: 26px; background: var(--theme-text); font-weight: 750; }
}

@media (min-width: 900px) {
  .app-shell { grid-template-columns: 276px minmax(0,1fr); background: var(--theme-canvas); }
  .app-shell.sidebar-collapsed { grid-template-columns: 68px minmax(0,1fr); }
  .desktop-sidebar { padding: 12px; border-color: var(--theme-border); background: var(--theme-sidebar); }
  .sidebar-brand { min-height: 48px; gap: 10px; padding: 4px 8px 14px; }
  .brand-glyph { flex: 0 0 28px; width: 28px; height: 28px; color: var(--theme-text); border-radius: 0; background: transparent; box-shadow: none; }
  .brand-glyph .grok-logo { width: 27px; height: 27px; }
  .sidebar-brand strong { color: var(--theme-text); font-size: 16px; font-weight: 720; letter-spacing: -.02em; }
  .sidebar-brand small { color: var(--theme-text-tertiary); font-size: 10px; }
  .sidebar-toggle { color: var(--theme-text-tertiary); }.sidebar-toggle:hover { color: var(--theme-text); background: var(--theme-surface-hover); }
  .sidebar-new { min-height: 44px; padding: 0 13px; color: var(--theme-text); border: 1px solid var(--theme-border); border-radius: 13px; background: var(--theme-surface); font-weight: 650; }
  .sidebar-new:hover { border-color: var(--theme-border-strong); background: var(--theme-surface-hover); }
  .sidebar-nav { gap: 3px; margin-top: 12px; }
  .sidebar-nav button,.sidebar-settings,.theme-toggle { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 42px; padding: 0 12px; color: var(--theme-text-secondary); border: 0; border-radius: 11px; background: transparent; text-align: left; }
  .sidebar-nav button:hover,.sidebar-settings:hover,.theme-toggle:hover { color: var(--theme-text); background: var(--theme-surface-hover); }
  .sidebar-nav button.active,.sidebar-settings.active { color: var(--theme-text); background: var(--theme-surface-active); }
  .sidebar-recents { margin-top: 24px; }
  .sidebar-recents > p { margin: 0 12px 8px; color: var(--theme-text-tertiary); font-size: 11px; font-weight: 650; }
  .sidebar-recents button { min-height: 36px; padding: 0 12px; color: var(--theme-text-secondary); border-radius: 9px; }
  .sidebar-recents button:hover,.sidebar-recents button.active { color: var(--theme-text); background: var(--theme-surface-hover); }
  .sidebar-footer { gap: 4px; padding-top: 10px; border-color: var(--theme-border); }
  .sidebar-usage { padding: 11px 12px; border: 1px solid var(--theme-border); border-radius: 13px; background: var(--theme-surface); }
  .sidebar-usage:hover { border-color: var(--theme-border-strong); background: var(--theme-surface-hover); }
  .sidebar-usage span { color: var(--theme-text-tertiary); }.sidebar-usage strong { color: var(--theme-text); }
  .theme-toggle-mobile { display: none; }
  .theme-toggle svg,.sidebar-settings svg { flex: 0 0 20px; }
  .sidebar-collapsed .brand-glyph { display: grid; }
  .sidebar-collapsed .sidebar-brand-copy,.sidebar-collapsed .theme-toggle span { display: none; }
  .sidebar-collapsed .theme-toggle { justify-content: center; padding: 0; }
  .app-header { background: var(--theme-canvas); }
  .desktop-mode-switch { border-color: var(--theme-border); background: var(--theme-surface-raised); }
  .desktop-mode-switch button { color: var(--theme-text-tertiary); }
  .desktop-mode-switch button:hover { color: var(--theme-text); }
  .desktop-mode-switch button.active { color: var(--theme-text); background: var(--theme-surface-active); box-shadow: none; }
  .chat-empty .composer-wrap { background: transparent; }
  .empty-chat h2 { color: var(--theme-text); }
}

/* ChatGPT-inspired workspace requested for the Grok customer chat. */
.composer {
  display: block;
  position: relative;
  min-height: 124px;
  padding: 16px 14px 10px;
  border-radius: 26px;
}
.composer textarea {
  display: block;
  width: 100%;
  min-height: 58px;
  max-height: 150px;
  padding: 0 4px 10px;
  font-size: 15px;
  line-height: 1.5;
}
.composer-toolbar,.composer-tools { display: flex; align-items: center; }
.composer-toolbar { justify-content: space-between; gap: 12px; min-height: 42px; }
.composer-tools { justify-content: flex-end; gap: 4px; min-width: 0; }
.composer-action,.spark-button,.send-button { flex: 0 0 auto; }
.model-picker,.speed-picker { position: relative; }
.model-picker-trigger,.speed-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 38px;
  padding: 0 10px;
  color: var(--theme-text-secondary);
  border: 0;
  border-radius: 19px;
  background: transparent;
  font: inherit;
  font-size: 13px;
  font-weight: 620;
  white-space: nowrap;
}
.model-picker-trigger:hover,.speed-trigger:hover { color: var(--theme-text); background: var(--theme-surface-hover); }
.model-picker-trigger:focus-visible,.speed-trigger:focus-visible,.model-menu button:focus-visible,.speed-options button:focus-visible {
  outline: 2px solid var(--theme-text);
  outline-offset: 2px;
}
.model-picker-trigger svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; }
.speed-trigger { padding-inline: 9px; }
.speed-trigger svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linejoin: round; }
.model-menu,.speed-menu {
  position: absolute;
  top: calc(100% + 9px);
  right: 0;
  z-index: 30;
  color: var(--theme-text);
  border: 1px solid var(--theme-border-strong);
  border-radius: 22px;
  background: var(--theme-surface-raised);
  box-shadow: 0 18px 50px rgba(0,0,0,.38);
}
.model-menu { width: 260px; padding: 10px; }
.model-menu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 46px;
  padding: 9px 10px;
  color: var(--theme-text);
  border: 0;
  border-radius: 12px;
  background: transparent;
  text-align: left;
}
.model-menu button:hover { background: var(--theme-surface-hover); }
.model-menu button > span { display: grid; gap: 4px; }
.model-menu strong { font-size: 13px; }
.model-menu small { max-width: 185px; color: var(--theme-text-tertiary); font-size: 11px; line-height: 1.35; }
.model-menu svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; }
.model-menu-divider { height: 1px; margin: 7px 8px; background: var(--theme-border); }
.speed-menu { width: 270px; padding: 14px 14px 12px; }
.speed-menu-title { display: flex; align-items: center; gap: 9px; min-height: 28px; font-size: 13px; }
.speed-menu-title svg { width: 17px; height: 17px; fill: none; stroke: var(--theme-text-tertiary); stroke-width: 1.8; }
.speed-track { position: relative; display: flex; align-items: center; justify-content: space-between; height: 14px; margin: 14px 4px 5px; }
.speed-track::before { content: ''; position: absolute; inset: 5px 0 auto; height: 4px; border-radius: 4px; background: var(--theme-surface-active); }
.speed-track span { position: absolute; left: 0; top: 5px; z-index: 1; height: 4px; border-radius: 4px; background: #2f91ff; transition: width .18s ease; }
.speed-track span.at-low { width: 5%; }.speed-track span.at-medium { width: 50%; }.speed-track span.at-high { width: 100%; }
.speed-track i { position: relative; z-index: 2; width: 10px; height: 10px; border: 2px solid var(--theme-surface-raised); border-radius: 50%; background: var(--theme-text-tertiary); }
.speed-options { display: grid; grid-template-columns: repeat(3,1fr); gap: 4px; }
.speed-options button { min-height: 34px; color: var(--theme-text-tertiary); border: 0; border-radius: 10px; background: transparent; font-size: 11px; }
.speed-options button:hover,.speed-options button.active { color: var(--theme-text); background: var(--theme-surface-hover); }

@media (min-width: 900px) {
  .app-shell { grid-template-columns: 260px minmax(0,1fr); }
  .app-shell.sidebar-collapsed { grid-template-columns: 68px minmax(0,1fr); }
  .desktop-sidebar { padding: 8px 10px 12px; background: var(--theme-sidebar); }
  .sidebar-brand { min-height: 46px; padding: 4px 7px 8px; }
  .sidebar-brand strong { font-size: 17px; }
  .sidebar-new { justify-content: flex-start; min-height: 38px; border: 0; border-radius: 10px; background: var(--theme-surface-active); }
  .sidebar-nav { margin-top: 4px; }
  .sidebar-nav button { min-height: 40px; }
  .sidebar-recents { margin-top: 22px; }
  .app-header { height: 58px; padding: 5px 22px 0; }
  .desktop-mode-switch { width: 300px; height: 38px; padding: 3px; border-radius: 21px; }
  .desktop-mode-switch button { border-radius: 18px; }
  .chat-empty .empty-chat { transform: translateY(-118px); }
  .chat-empty .empty-chat h2 { font-size: 24px; font-weight: 520; letter-spacing: -.025em; }
  .chat-empty .composer-wrap { top: calc(50% - 62px); bottom: auto; }
  .composer-wrap { padding-inline: clamp(28px,8vw,150px); }
  .composer,.message-row,.mode-banner,.attachment-strip,.desktop-quick-actions { max-width: 770px; }
  .composer { min-height: 128px; border-radius: 27px; }
  .composer-action,.spark-button,.send-button { width: 38px; height: 38px; }
  .desktop-quick-actions { grid-template-columns: 1fr; gap: 2px; margin-top: 12px; }
  .desktop-quick-actions button { min-height: 46px; padding: 7px 12px; border: 0; border-radius: 12px; }
  .desktop-quick-actions button span { display: flex; align-items: baseline; gap: 12px; }
  .desktop-quick-actions button small { margin: 0; }
}

@media (max-width: 899px) {
  .composer { display: block; min-height: 116px; padding: 15px 12px 10px; border-radius: 28px; }
  .composer textarea { min-height: 50px; padding: 0 7px 8px; }
  .composer-toolbar { min-height: 48px; }
  .composer-action,.spark-button,.send-button { width: 44px; height: 44px; }
  .model-picker-trigger { max-width: 104px; padding-inline: 8px; }
  .speed-trigger { width: 42px; padding: 0; }
  .speed-trigger span { display: none; }
  .model-menu,.speed-menu { top: auto; right: 0; bottom: calc(100% + 9px); }
  .model-menu { width: min(260px,calc(100vw - 32px)); }
  .speed-menu { width: min(270px,calc(100vw - 32px)); }
}

@media (prefers-reduced-motion: reduce) {
  .speed-track span,.mobile-drawer { transition: none; }
}
</style>
