/**
 * 本地（仅存在于 Browser Copilot）的块目录条目。
 *
 * 生成的 {@link BLOCK_CATALOG}（`catalog.ts`，本项目自研目录，不依赖第三方
 * 工作流源）是自有的。因此仅在 Browser Copilot 中存在的块不会被加入其中，
 * 而是集中定义在此处，
 * 再由 `palette.ts` 合并进调色板/目录查询，其消费方式与目录块保持一致。
 *
 * 条目镜像 {@link BlockCatalogEntry}；`cloud` 恒为 false（这些块本地运行）。
 *
 * @module lib/workflow/blocks/custom
 */

import type { BlockCatalogEntry } from './types'

/**
 * Browser Copilot 扩展块，追加在目录之后。
 * 其 id 不得与目录块 id 冲突，否则查询映射会相互覆盖。
 */
export const CUSTOM_BLOCKS: BlockCatalogEntry[] = [
  {
    id: 'ai-agent',
    name: 'AI agent',
    description:
      'Read a target element and hand it to an AI agent that can analyze the page and (optionally) act on it.',
    icon: 'riRobot2Line',
    category: 'general',
    component: 'Default',
    editComponent: 'EditAiAgent',
    inputs: 1,
    outputs: 1,
    allowedInputs: true,
    maxConnection: 1,
    tag: 'AI',
    data: {
      disableBlock: false,
      description: '',
      // Element locator (Automa shape): `selector` + `findBy`. Empty selector
      // means "no specific element — let the agent read the page itself".
      findBy: 'cssSelector',
      selector: '',
      // The user's instruction. Supports {{variable}} interpolation at runtime.
      prompt: '',
      // When false the agent runs in read-only mode (analyze only); when true
      // it runs fully autonomously and may click/fill/navigate.
      actOnPage: false,
      // Per-node cap on model↔tool round trips (independent of the global
      // setting), so a single workflow step cannot loop unbounded.
      maxToolRounds: 20,
      // Variable the agent's final text answer is stored under.
      variableName: 'lastAIAgent',
      // Have the agent take a page snapshot before acting so it can locate
      // interactive elements itself.
      useSnapshot: true,
    },
    cloud: false,
  },
  {
    id: 'ocr',
    name: 'OCR text recognition',
    description:
      'Run local OCR (Tesseract.js, offline) on an image variable, an img element on the page or the previous page snapshot; outputs the recognized string into the output variable (default lastOcrText).',
    icon: 'riCharacterRecognitionLine',
    category: 'browser',
    component: 'Default',
    editComponent: 'EditOcr',
    inputs: 1,
    outputs: 1,
    allowedInputs: true,
    maxConnection: 1,
    refDataKeys: ['variableName', 'selector', 'lang', 'imageVariable'],
    data: {
      disableBlock: false,
      description: '',
      // Input — one of: `variable` (an img-typed variable holding an image as
      // a data URL, a bare base64 payload or an http(s) link — base64 is
      // decoded through the offscreen canvas, links are fetched first), `element` (an img element
      // selected on the page), or `page` (the previous page snapshot — the
      // visible page the run is driving). Output — the recognized string
      // (type always string), stored in the `variableName` variable.
      source: 'page',
      // Element locator (Automa shape) for `source: 'element'`.
      findBy: 'cssSelector',
      selector: '',
      // Variable to read the image data URL from when `source: 'variable'`.
      imageVariable: 'lastScreenshot',
      // Tesseract language pack(s), `+`-joined. Empty = the global
      // "Local OCR language" setting (settings.ocrLanguage).
      lang: '',
      // Upscale + contrast enhance before recognition (lib/vision
      // preprocessImage) — large gains on small captcha glyphs.
      preprocess: true,
      // Editable output variable name; the value type is always a string.
      variableName: 'lastOcrText',
    },
    cloud: false,
  },
  {
    id: 'set-variable',
    name: 'Set variable',
    description:
      'Store a value into a workflow variable for later blocks to read (supports {{variables}}).',
    icon: 'riBookmarkLine',
    category: 'data',
    component: 'Default',
    editComponent: 'EditSetVariable',
    inputs: 1,
    outputs: 1,
    allowedInputs: true,
    maxConnection: 1,
    refDataKeys: ['value'],
    data: {
      disableBlock: false,
      description: '',
      variableName: '',
      value: '',
    },
    cloud: false,
  },
]

/** Ids of every local extension block. */
export const CUSTOM_BLOCK_IDS: ReadonlySet<string> = new Set(CUSTOM_BLOCKS.map((b) => b.id))

/** Whether a block id refers to a local (non-Automa) extension block. */
export function isCustomBlock(id: string): boolean {
  return CUSTOM_BLOCK_IDS.has(id)
}
