import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { generateImage, streamChat } = vi.hoisted(() => ({
  generateImage: vi.fn(),
  streamChat: vi.fn(),
}))

vi.mock('@/features/grok-chat/api', () => ({
  generateImage,
  getUsage: vi.fn(),
  streamChat,
}))

import GrokChatView from '../GrokChatView.vue'

describe('GrokChatView image composer', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('grok-mobile.theme.v1', 'dark')
    window.history.replaceState({}, '', '/chat?preview')
    generateImage.mockReset()
    generateImage.mockResolvedValue({ url: 'data:image/png;base64,dGVzdA==' })
    streamChat.mockReset()
    streamChat.mockImplementation(async ({ onText }: { onText: (chunk: string) => void }) => onText('Xin chào'))
  })

  it('sends the selected speed model and aspect ratio to image generation', async () => {
    const wrapper = mount(GrokChatView)
    await flushPromises()

    await wrapper.get('button[aria-label="Đổi chế độ tạo ảnh"]').trigger('click')
    await wrapper.get('select[aria-label="Tốc độ tạo ảnh"]').setValue('grok-imagine-image')
    await wrapper.get('select[aria-label="Tỷ lệ ảnh"]').setValue('1024x1536')
    await wrapper.get('textarea[placeholder="Mô tả hình ảnh bạn muốn tạo…"]').setValue('Một chú mèo phi hành gia')
    await wrapper.get('button[aria-label="Gửi"]').trigger('click')
    await flushPromises()

    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      model: 'grok-imagine-image',
      size: '1024x1536',
      prompt: 'Một chú mèo phi hành gia',
    }))
  })

  it('switches and persists the light theme from the workspace', async () => {
    const wrapper = mount(GrokChatView)
    await flushPromises()

    expect(wrapper.get('.grok-mobile').attributes('data-theme')).toBe('dark')
    expect(wrapper.findAll('.grok-logo').length).toBeGreaterThan(1)
    await wrapper.get('button[aria-label="Chuyển sang giao diện sáng"]').trigger('click')

    expect(wrapper.get('.grok-mobile').attributes('data-theme')).toBe('light')
    expect(localStorage.getItem('grok-mobile.theme.v1')).toBe('light')
  })

  it('opens the mobile drawer and navigates to image creation', async () => {
    const wrapper = mount(GrokChatView)
    await flushPromises()

    expect(wrapper.get('.mobile-drawer').classes()).not.toContain('open')
    await wrapper.get('button[aria-label="Mở menu"]').trigger('click')

    expect(wrapper.get('.mobile-drawer').classes()).toContain('open')
    await wrapper.get('.mobile-drawer-nav button').trigger('click')

    expect(wrapper.get('.mobile-drawer').classes()).not.toContain('open')
    expect(wrapper.get('.imagine-page').exists()).toBe(true)
  })

  it('sends the selected reasoning speed to the chat API', async () => {
    const wrapper = mount(GrokChatView)
    await flushPromises()

    await wrapper.get('.speed-trigger').trigger('click')
    const thinking = wrapper.findAll('.speed-options button').find((button) => button.text().trim() === 'Thinking')
    expect(thinking).toBeDefined()
    await thinking!.trigger('click')
    await wrapper.get('textarea[placeholder="Làm với bất kỳ nội dung nào"]').setValue('Xin chào')
    await wrapper.get('button[aria-label="Gửi"]').trigger('click')
    await flushPromises()

    expect(streamChat).toHaveBeenCalledWith(expect.objectContaining({ reasoning: 'high' }))
    expect(wrapper.get('.speed-trigger').text()).toContain('Suy nghĩ kỹ')
  })

  it('uses the Grok logo to reopen the collapsed desktop sidebar', async () => {
    const wrapper = mount(GrokChatView)
    await flushPromises()

    await wrapper.get('button[aria-label="Thu gọn thanh bên"]').trigger('click')
    expect(wrapper.get('.app-shell').classes()).toContain('sidebar-collapsed')
    expect(wrapper.find('button[aria-label="Thu gọn thanh bên"]').exists()).toBe(false)

    await wrapper.get('button[aria-label="Mở rộng thanh bên"]').trigger('click')
    expect(wrapper.get('.app-shell').classes()).not.toContain('sidebar-collapsed')
    expect(wrapper.get('button[aria-label="Thu gọn thanh bên"]').exists()).toBe(true)
  })
})
