import { describe, expect, it } from 'vitest'
import { parseTagInput, validatePublishForm } from '../src/lib/marketplace/form'
import { MAX_PUBLISH_ATTACHMENT_BYTES, MAX_PUBLISH_IMAGE_BYTES } from '../src/lib/marketplace/types'

function values(overrides: Partial<Parameters<typeof validatePublishForm>[0]> = {}) {
  return {
    title: 'Scrape orders',
    category: 'ecommerce',
    description: '',
    videoUrl: '',
    images: [],
    ...overrides,
  }
}

describe('publish form validation', () => {
  it('accepts a filled form', () => {
    expect(validatePublishForm(values())).toBeNull()
  })

  it('requires a title and caps its length', () => {
    expect(validatePublishForm(values({ title: '   ' }))).toBe('title-required')
    expect(validatePublishForm(values({ title: 'x'.repeat(121) }))).toBe('title-too-long')
  })

  it('accepts a publisher-defined category but not an empty one', () => {
    expect(validatePublishForm(values({ category: 'Industry research' }))).toBeNull()
    expect(validatePublishForm(values({ category: '  ' }))).toBe('category-required')
  })

  it('caps the description and validates the video link', () => {
    expect(validatePublishForm(values({ description: 'x'.repeat(2001) }))).toBe(
      'description-too-long',
    )
    expect(validatePublishForm(values({ videoUrl: 'ftp://example.com/v' }))).toBe('video-invalid')
    expect(validatePublishForm(values({ videoUrl: 'https://example.com/v' }))).toBeNull()
  })

  it('limits count, type and size of images', () => {
    const image = { type: 'image/webp', size: 10 }
    expect(validatePublishForm(values({ images: [image, image, image, image] }))).toBe(
      'too-many-images',
    )
    expect(validatePublishForm(values({ images: [{ type: 'text/plain', size: 10 }] }))).toBe(
      'image-type',
    )
    expect(
      validatePublishForm(
        values({ images: [{ type: 'image/webp', size: MAX_PUBLISH_IMAGE_BYTES + 1 }] }),
      ),
    ).toBe('image-too-large')
  })

  it('limits the number and size of attachments', () => {
    const attachment = { name: 'orders.csv', size: 1024 }
    expect(
      validatePublishForm(
        values({ attachments: [attachment, attachment, attachment, attachment] }),
      ),
    ).toBe('too-many-attachments')
    expect(
      validatePublishForm(
        values({ attachments: [{ ...attachment, size: MAX_PUBLISH_ATTACHMENT_BYTES + 1 }] }),
      ),
    ).toBe('attachment-too-large')
    expect(validatePublishForm(values({ attachments: [attachment] }))).toBeNull()
  })

  it('splits, trims and de-duplicates tags', () => {
    expect(parseTagInput(' shop, Orders\nshop ,, ')).toEqual(['shop', 'Orders'])
    expect(parseTagInput('x'.repeat(40))).toEqual(['x'.repeat(24)])
  })
})
