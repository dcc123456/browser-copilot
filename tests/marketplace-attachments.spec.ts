import { describe, expect, it } from 'vitest'
import {
  attachmentFile,
  attachmentPath,
  formatAttachmentSize,
  isAttachmentPath,
  uniqueAttachmentFile,
} from '../src/lib/marketplace/attachments'

describe('attachment file names', () => {
  it('keeps an ASCII name and a short extension', () => {
    expect(attachmentFile('orders.csv')).toBe('orders.csv')
    expect(attachmentFile('Setup Guide.PDF')).toBe('setup-guide.pdf')
  })

  it('falls back to a plain stem for non-ASCII or extension-less names', () => {
    expect(attachmentFile('订单数据.csv')).toBe('file.csv')
    expect(attachmentFile('数据')).toBe('file')
    expect(attachmentFile('archive.tar.gz')).toBe('archive-tar.gz')
    expect(attachmentFile('weird.na me')).toBe('weird')
  })

  it('strips directories so a path cannot escape attachments/', () => {
    expect(attachmentFile('../../etc/passwd')).toBe('passwd')
    expect(attachmentFile('C:\\Users\\me\\secret.txt')).toBe('secret.txt')
  })

  it('drops extensions that are too long or not alphanumeric', () => {
    expect(attachmentFile('data.verylongextension')).toBe('data')
    expect(attachmentFile('data.c++')).toBe('data')
  })

  it('de-duplicates a repeated name instead of overwriting it', () => {
    const taken = new Set<string>()
    expect(uniqueAttachmentFile(attachmentFile('orders.csv'), taken)).toBe('orders.csv')
    expect(uniqueAttachmentFile(attachmentFile('orders.csv'), taken)).toBe('orders-2.csv')
    expect(uniqueAttachmentFile(attachmentFile('orders.csv'), taken)).toBe('orders-3.csv')
    expect([...taken]).toEqual(['orders.csv', 'orders-2.csv', 'orders-3.csv'])
  })
})

describe('attachment paths', () => {
  it('accepts one file directly inside attachments/', () => {
    expect(isAttachmentPath(attachmentPath('orders.csv'))).toBe(true)
    expect(attachmentPath('orders.csv')).toBe('attachments/orders.csv')
    expect(isAttachmentPath('attachments/a')).toBe(true)
  })

  it('rejects nested, escaping or malformed paths', () => {
    expect(isAttachmentPath('attachments/../secret.json')).toBe(false)
    expect(isAttachmentPath('attachments/sub/file.csv')).toBe(false)
    expect(isAttachmentPath('deps/orders.json')).toBe(false)
    expect(isAttachmentPath('attachments/')).toBe(false)
    expect(isAttachmentPath('attachments/.hidden')).toBe(false)
  })
})

describe('attachment size label', () => {
  it('shows whole KB, one decimal between 1 and 10 KB, and < 1 KB below that', () => {
    expect(formatAttachmentSize(0)).toBe('0 KB')
    expect(formatAttachmentSize(3)).toBe('< 1 KB')
    expect(formatAttachmentSize(512)).toBe('< 1 KB')
    expect(formatAttachmentSize(1024)).toBe('1 KB')
    expect(formatAttachmentSize(1536)).toBe('1.5 KB')
    expect(formatAttachmentSize(2048)).toBe('2 KB')
    expect(formatAttachmentSize(200 * 1024)).toBe('200 KB')
  })
})
