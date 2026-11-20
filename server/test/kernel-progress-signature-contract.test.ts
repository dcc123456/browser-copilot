/**
 * Runner-side mirror contract (AGENTS §5.6): the headless driver injects the
 * SAME in-page kernel the extension does. A new op is only usable there if the
 * shared kernel implements it, the version stamp was bumped (stale resident
 * kernels are then re-injected), and the Runner imports that shared kernel.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { KERNEL_VERSION } from '../../src/inpage/kernel-version'

const root = fileURLToPath(new URL('../..', import.meta.url))

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

describe('progress_signature mirror contract', () => {
  it('is in the shared kernel vocabulary', () => {
    const kernel = read('src/inpage/kernel.ts')
    expect(kernel).toContain("op.action === 'progress_signature'")
    expect(kernel).toContain('function progressSignature()')
    // Scroll must not move the signature (a scroll with no new content is the
    // classic no-progress loop this op exists to catch). Check the function
    // body only: the snapshot builder elsewhere legitimately reads scrollY.
    const start = kernel.indexOf('function progressSignature()')
    const end = kernel.indexOf('function buildSnapshot(', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(kernel.slice(start, end)).not.toMatch(/scroll/i)
  })

  it('bumped the kernel version so a stale resident kernel is replaced', () => {
    expect(KERNEL_VERSION).toBeGreaterThanOrEqual(7)
  })

  it('keeps the Runner on the shared kernel rather than a fork', () => {
    const driver = read('server/src/driver.ts')
    expect(driver).toContain("from '../../src/inpage/kernel'")
    expect(driver).toContain('runOp')
  })
})
