import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXECUTORS, type WorkflowExecCtx } from '../src/background/workflow-engine/executors'

// The real write/picker helpers live in lib/download-dir, which talks to the
// File System Access API / side panel. Replace them so we can assert on the
// silent-vs-confirm decision without a real download directory.
vi.mock('../src/lib/download-dir', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/download-dir')>()
  return {
    ...actual,
    getDownloadDir: vi.fn(async () => null),
    writeFileToDownloadDir: vi.fn(async () => true),
    askSaveViaSidePanel: vi.fn(async () => ({ ok: false, canceled: true })),
  }
})

vi.mock('../src/lib/storage', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/storage')>()
  return {
    ...actual,
    // `Settings` is not exported, so cast the mock to the real function's type.
    getSettings: vi.fn(async () => ({
      downloadAutoSave: true,
    })) as unknown as typeof actual.getSettings,
  }
})

import {
  askSaveViaSidePanel,
  getDownloadDir,
  writeFileToDownloadDir,
} from '../src/lib/download-dir'
import { EMPTY_INTERP_KEY } from '../src/lib/workflow/interpolate'
import { dataSchemaFromEntry } from '../src/lib/workflow/operator-tools'
import { BLOCK_BY_ID } from '../src/lib/workflow/blocks/palette'

// Indexed access is `BlockExecutor | undefined` under noUncheckedIndexedAccess.
const saveLocal = EXECUTORS['save-local']!

function makeCtx(): { ctx: WorkflowExecCtx; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn((_kind: 'status' | 'result' | 'error' | 'info', _text: string) => {})
  const ctx: WorkflowExecCtx = {
    variables: {},
    refData: undefined,
    signal: new AbortController().signal,
    emit: emit as unknown as WorkflowExecCtx['emit'],
  }
  return { ctx, emit }
}

/** A configured download directory handle. */
const configuredDir = {} as unknown as FileSystemDirectoryHandle

/**
 * Run a step that MUST fail and hand back its error — used where the message
 * itself is the assertion subject (`.rejects.toThrow` can only match it).
 * Also pins that the step failed at all, instead of letting a later
 * `toContain` pass against a value that was never thrown.
 */
async function failureOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('expected this step to fail, but it resolved successfully')
}

afterEach(() => {
  vi.mocked(getDownloadDir).mockReset()
  vi.mocked(writeFileToDownloadDir).mockReset()
  vi.mocked(askSaveViaSidePanel).mockReset()
  vi.mocked(getDownloadDir).mockImplementation(async () => null)
  vi.mocked(writeFileToDownloadDir).mockImplementation(async () => true)
  vi.mocked(askSaveViaSidePanel).mockImplementation(async () => ({ ok: false, canceled: true }))
})

describe('save-local executor: silent save to configured directory', () => {
  it('writes silently and never opens the save picker when a directory is configured', async () => {
    vi.mocked(getDownloadDir).mockImplementation(async () => configuredDir)
    const { ctx, emit } = makeCtx()

    const result = await saveLocal(
      {
        value: '{{reportBody}}',
        filename: '{{reportName}}',
        saveMode: 'auto',
        variableName: 'lastSavedPath',
      },
      ctx,
    )

    expect(writeFileToDownloadDir).toHaveBeenCalledTimes(1)
    expect(askSaveViaSidePanel).not.toHaveBeenCalled()
    expect(result).toBeNull()
    // Output variable is backfilled so downstream steps read a live value.
    expect(ctx.variables['lastSavedPath']).toBe('{{reportName}}')
    expect(emit).toHaveBeenCalledWith('result', expect.stringContaining('已自动保存'))
  })

  it('BUG #2 regression: a directory handle WITHOUT queryPermission still saves silently', async () => {
    // In MV3 the persisted handle can lose its permission methods after a worker
    // restart. The old code called `dir.queryPermission(...)`, which threw on such
    // a handle and pushed every run into the manual confirmation branch. The fix
    // trusts the actual write attempt instead, so the absence of queryPermission
    // must NOT force a picker.
    const handleNoPermission = {} as unknown as FileSystemDirectoryHandle
    vi.mocked(getDownloadDir).mockImplementation(async () => handleNoPermission)
    const { ctx } = makeCtx()

    await saveLocal({ value: 'hi', filename: 'note.txt', saveMode: 'auto' }, ctx)

    expect(writeFileToDownloadDir).toHaveBeenCalledTimes(1)
    expect(askSaveViaSidePanel).not.toHaveBeenCalled()
  })

  it('BUG #2 regression: a queryPermission that reports "denied" must not force confirmation', async () => {
    const deniedHandle = {
      queryPermission: vi.fn(async () => 'denied' as const),
    } as unknown as FileSystemDirectoryHandle
    vi.mocked(getDownloadDir).mockImplementation(async () => deniedHandle)
    const { ctx } = makeCtx()

    await saveLocal({ value: 'hi', filename: 'note.txt', saveMode: 'auto' }, ctx)

    expect(queryPermissionOf(deniedHandle)).toHaveBeenCalledTimes(0)
    expect(writeFileToDownloadDir).toHaveBeenCalledTimes(1)
    expect(askSaveViaSidePanel).not.toHaveBeenCalled()
  })

  it('falls back to the save picker only when the silent write actually fails', async () => {
    vi.mocked(getDownloadDir).mockImplementation(async () => configuredDir)
    vi.mocked(writeFileToDownloadDir).mockImplementation(async () => false)
    const { ctx } = makeCtx()

    await saveLocal({ value: 'hi', filename: 'note.txt', saveMode: 'auto' }, ctx)

    expect(askSaveViaSidePanel).toHaveBeenCalledTimes(1)
  })

  it('opens the save picker (no silent write) when no directory is configured', async () => {
    vi.mocked(getDownloadDir).mockImplementation(async () => null)
    const { ctx } = makeCtx()

    await saveLocal({ value: 'hi', filename: 'note.txt', saveMode: 'auto' }, ctx)

    expect(writeFileToDownloadDir).not.toHaveBeenCalled()
    expect(askSaveViaSidePanel).toHaveBeenCalledTimes(1)
  })
})

/**
 * A zero-byte file is indistinguishable from a successful save, and it
 * overwrites whatever the previous run produced — so an empty write has to be
 * reported, not performed. The reported failure was exactly this: a generated
 * workflow whose `save-local` node carried `filename` + `variableName` and no
 * `value` at all (the model read `variableName` as "the variable to save"),
 * which produced a 0-byte file and no explanation anywhere.
 *
 * Reported by THROWING, not by `ctx.emit('error', …)`: a logged error still
 * left the run reporting success, and — worse for a generated workflow — the
 * operator bridge still returned `status:'executed'`, so the broken node was
 * recorded and the model believed it had worked.
 */
describe('save-local executor: an empty write is refused', () => {
  it('fails when `value` is missing, and names the variableName confusion', async () => {
    vi.mocked(getDownloadDir).mockImplementation(async () => configuredDir)
    const { ctx } = makeCtx()

    // Verbatim shape from the reported workflow-mu6sil.json.
    const error = await failureOf(
      saveLocal({ filename: '{{saveLocalFilename}}', variableName: 'hotSearchContent' }, ctx),
    )

    expect(error.message).toContain('value')
    // The hint has to name the trap, or the user is left with "the file is empty".
    expect(error.message).toContain('variableName')
    expect(writeFileToDownloadDir).not.toHaveBeenCalled()
    expect(askSaveViaSidePanel).not.toHaveBeenCalled()
    // Nothing was saved, so the output path variable must not claim otherwise.
    expect(ctx.variables['hotSearchContent']).toBeUndefined()
  })

  it('refuses an empty `value` rather than writing a 0-byte file', async () => {
    vi.mocked(getDownloadDir).mockImplementation(async () => configuredDir)
    const { ctx } = makeCtx()

    await expect(
      saveLocal({ value: '', filename: 'report.txt', saveMode: 'auto' }, ctx),
    ).rejects.toThrow(/report\.txt/)
    expect(writeFileToDownloadDir).not.toHaveBeenCalled()
  })

  it('refuses when the referenced variable produced nothing (engine-flagged)', async () => {
    // The engine interpolates the data bag before the executor runs, so by then
    // the original text is gone: only `EMPTY_INTERP_KEY` distinguishes "the
    // reference resolved to nothing" from a deliberate "".
    vi.mocked(getDownloadDir).mockImplementation(async () => configuredDir)
    const { ctx } = makeCtx()

    await expect(
      saveLocal({ value: '', filename: 'report.txt', [EMPTY_INTERP_KEY]: ['value'] }, ctx),
    ).rejects.toThrow(/为空/)
    expect(writeFileToDownloadDir).not.toHaveBeenCalled()
  })

  it('writes normally once `value` carries real content', async () => {
    vi.mocked(getDownloadDir).mockImplementation(async () => configuredDir)
    const { ctx } = makeCtx()

    await saveLocal({ value: '微博热搜榜', filename: 'hot.txt', saveMode: 'auto' }, ctx)

    expect(writeFileToDownloadDir).toHaveBeenCalledWith(configuredDir, 'hot.txt', '微博热搜榜')
  })
})

/**
 * The other half of the fix. The executor now explains an empty write, but the
 * model should never make one: it only saw bare property names, and
 * `variableName` reads like "the variable to save". The schema has to say which
 * param carries the content and which one merely receives the path.
 */
describe('save-local tool schema', () => {
  const schema = dataSchemaFromEntry(BLOCK_BY_ID.get('save-local')!) as {
    properties: Record<string, { type?: string; enum?: string[]; description?: string }>
  }

  it('describes `value` as the content, requiring a reference', () => {
    expect(schema.properties['value']!.description).toContain('{{')
    expect(schema.properties['value']!.description).toContain('MUST')
  })

  it('spells out that `variableName` is an OUTPUT, not the content', () => {
    const description = schema.properties['variableName']!.description ?? ''
    expect(description).toContain('OUTPUT')
    expect(description).toContain('NOT the content')
  })

  it('does NOT advertise saveMode, because the executor ignores it on purpose', () => {
    // A configured download directory wins unconditionally so that setting one
    // up stops the prompts; honouring `manual` here would re-introduce a dialog
    // for everyone who configured a directory. Advertising it with a
    // "`manual` asks" description therefore taught the model a knob that does
    // nothing — see the coverage guard in `operator-param-coverage.spec.ts`.
    expect(schema.properties['saveMode']).toBeUndefined()
  })
})

function queryPermissionOf(handle: unknown): ReturnType<typeof vi.fn> {
  return (handle as { queryPermission: ReturnType<typeof vi.fn> }).queryPermission
}
