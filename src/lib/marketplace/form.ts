/**
 * Publish-form validation, kept out of the dialog so it can be tested without
 * a DOM. Errors are stable codes; the dialog maps them to translated copy.
 *
 * @module lib/marketplace/form
 */

import { normalizeCategory } from './categories'
import { normalizeTags } from './meta'
import {
  MAX_DESCRIPTION_CHARS,
  MAX_PUBLISH_IMAGE_BYTES,
  MAX_PUBLISH_IMAGES,
  MAX_TITLE_CHARS,
} from './types'

export type PublishFormError =
  | 'title-required'
  | 'title-too-long'
  | 'category-required'
  | 'description-too-long'
  | 'video-invalid'
  | 'too-many-images'
  | 'image-too-large'
  | 'image-type'

export interface PublishFormValues {
  title: string
  /** A built-in slug or the publisher's own category label. */
  category: string
  description: string
  videoUrl: string
  images: readonly Pick<File, 'type' | 'size'>[]
}

/** Returns the first invalid field, or null when the form can be published. */
export function validatePublishForm(values: PublishFormValues): PublishFormError | null {
  const title = values.title.trim()
  if (!title) return 'title-required'
  if (title.length > MAX_TITLE_CHARS) return 'title-too-long'
  if (!normalizeCategory(values.category)) return 'category-required'
  if (values.description.trim().length > MAX_DESCRIPTION_CHARS) return 'description-too-long'
  if (values.videoUrl.trim() && !/^https?:\/\//i.test(values.videoUrl.trim())) {
    return 'video-invalid'
  }
  if (values.images.length > MAX_PUBLISH_IMAGES) return 'too-many-images'
  for (const image of values.images) {
    if (!image.type.startsWith('image/')) return 'image-type'
    if (image.size > MAX_PUBLISH_IMAGE_BYTES) return 'image-too-large'
  }
  return null
}

/** Splits the comma/newline separated tag input into normalised tags. */
export function parseTagInput(input: string): string[] {
  return normalizeTags(input.split(/[,\n]/))
}
