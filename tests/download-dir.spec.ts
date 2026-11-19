import { describe, expect, it } from 'vitest'
import { resolveTransferMode, writeFileToDownloadDir, type SaveMode } from '../src/lib/download-dir'

const makeCase = (saveMode: SaveMode, globalAuto: boolean, hasDir: boolean) =>
  resolveTransferMode(saveMode, globalAuto, hasDir)

describe('writeFileToDownloadDir', () => {
  it('replaces the target only after the temporary file is fully written', async () => {
    const calls: string[] = []
    const temporary = {
      createWritable: async () => ({
        write: async () => calls.push('temporary:write'),
        close: async () => calls.push('temporary:close'),
      }),
      move: async (target: string) => calls.push(`temporary:move:${target}`),
    }
    const dir = {
      getFileHandle: async (name: string) => {
        calls.push(`open:${name}`)
        if (name === 'ledger.csv') return { move: temporary.move }
        return temporary
      },
      removeEntry: async () => calls.push('remove:temporary'),
    } as unknown as FileSystemDirectoryHandle

    expect(await writeFileToDownloadDir(dir, 'ledger.csv', 'a,b\n1,2')).toBe(true)
    expect(calls).toEqual([
      'open:ledger.csv',
      'open:.ledger.csv.browser-copilot.tmp',
      'temporary:write',
      'temporary:close',
      'temporary:move:ledger.csv',
      'remove:temporary',
    ])
  })

  it('queues writes to the same path instead of truncating concurrently', async () => {
    let closeFirst: (() => void) | undefined
    let notifyFirstWrite: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      notifyFirstWrite = resolve
    })
    const calls: string[] = []
    const dir = {
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: async (data: string) => {
            calls.push(`write:${data}`)
            notifyFirstWrite?.()
          },
          close: async () => {
            if (calls.filter((call) => call.startsWith('write:')).length === 1) {
              await new Promise<void>((resolve) => {
                closeFirst = resolve
              })
            }
            calls.push('close')
          },
        }),
      }),
    } as unknown as FileSystemDirectoryHandle

    const first = writeFileToDownloadDir(dir, 'ledger.csv', 'first')
    await firstWrite
    const second = writeFileToDownloadDir(dir, 'ledger.csv', 'second')
    await Promise.resolve()
    expect(calls).toEqual(['write:first'])
    closeFirst?.()
    await Promise.all([first, second])
    expect(calls).toEqual(['write:first', 'close', 'write:second', 'close'])
  })
})

describe('resolveTransferMode', () => {
  it('force always auto-saves, ignoring global flag', () => {
    expect(makeCase('force', false, true)).toBe('auto')
    expect(makeCase('force', true, true)).toBe('auto')
  })
  it('force without a directory falls back to manual', () => {
    expect(makeCase('force', true, false)).toBe('manual')
  })
  it('manual always confirms', () => {
    expect(makeCase('manual', true, true)).toBe('manual')
    expect(makeCase('manual', false, false)).toBe('manual')
  })
  it('auto follows global flag AND presence of directory', () => {
    expect(makeCase('auto', true, true)).toBe('auto')
    expect(makeCase('auto', true, false)).toBe('manual')
    expect(makeCase('auto', false, true)).toBe('manual')
    expect(makeCase('auto', false, false)).toBe('manual')
  })
})
