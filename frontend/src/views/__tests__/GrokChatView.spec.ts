import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { generateImage } = vi.hoisted(() => ({ generateImage: vi.fn() }))

vi.mock('@/features/grok-chat/api', () => ({
  generateImage,
  getUsage: vi.fn(),
  streamChat: vi.fn(),
}))

import GrokChatView from '../GrokChatView.vue'

describe('GrokChatView image composer', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/chat?preview')
    generateImage.mockReset()
    generateImage.mockResolvedValue({ url: 'data:image/png;base64,dGVzdA==' })
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
})
