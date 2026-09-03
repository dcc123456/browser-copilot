/**
 * Candidate selection for local OCR reads.
 *
 * The offscreen document produces up to two readings of the same image
 * (Tesseract single-line mode + single-block mode). Their raw confidences are
 * known to be unreliable (a one-character misread can outscore a correct full
 * read), so instead of trusting them blindly we compare candidates with a
 * structural score and surface the runners-up: the calling agent can weigh the
 * alternatives itself ("hypothesis comparison") or refresh the image and retry.
 *
 * @module lib/ocr-candidates
 */

/** A single OCR reading of an image. */
export interface OcrCandidate {
  text: string
  /** Tesseract whole-result confidence, 0-100. */
  confidence: number
}

export interface PickedOcrCandidate {
  text: string
  confidence: number
  /** True when every candidate normalized to the same string. */
  agreed: boolean
  /** Losing readings, most-plausible first (max 2). */
  alternatives: string[]
}

/** Complete single-expression shape: `<a> <op> <b> =` (the trailing = optional). */
const FULL_EXPRESSION = /^\d+(?:\.\d+)?\s*(?:[+\-xX*×÷/])\s*\d+(?:\.\d+)?\s*=?$/
/** An expression buried in noise, e.g. "8 -=2 =" or "Zl x 7 =". */
const PARTIAL_EXPRESSION = /\d+(?:\.\d+)?\s*(?:[+\-xX*×÷/])\s*\d+(?:\.\d+)?/
/** Whitespace/dash variants that should not count as a disagreement. */
const normalizeForCompare = (t: string): string => t.replace(/[—–―]/g, '-').replace(/\s+/g, ' ').trim()

/**
 * Plausibility score for one reading. Higher wins. Structure dominates the
 * unreliable raw confidence: a complete or embedded arithmetic expression is
 * worth far more than a confident-looking but shapeless string.
 */
export function scoreOcrCandidate(text: string, confidence: number): number {
  const compact = normalizeForCompare(text)
  if (!compact) return -1
  let score = Math.min(Math.max(confidence, 0), 100)
  if (FULL_EXPRESSION.test(compact)) score += 1000
  else if (PARTIAL_EXPRESSION.test(compact)) score += 400
  const alnum = compact.replace(/[^0-9a-z]/gi, '').length
  score += Math.min(alnum, 30) * 2
  // Short single-line snippets that mix both cases are usually misreads
  // ("Zl xX"); real text in such captures rarely does.
  if (/[a-z]/.test(compact) && /[A-Z]/.test(compact)) score -= 15
  return score
}

/**
 * Picks the most plausible reading and reports the rest. When the candidates
 * agree (modulo whitespace/dash variants) the pick is marked `agreed` and the
 * alternatives list is empty — the caller can signal high trust.
 */
export function pickOcrCandidate(candidates: OcrCandidate[]): PickedOcrCandidate {
  const usable = candidates.filter((c) => normalizeForCompare(c.text).length > 0)
  if (usable.length === 0) return { text: '', confidence: 0, agreed: false, alternatives: [] }
  const first = usable[0]!
  if (usable.length === 1) return { text: first.text, confidence: first.confidence, agreed: false, alternatives: [] }

  const allAgree = usable.every((c) => normalizeForCompare(c.text) === normalizeForCompare(first.text))
  if (allAgree) return { text: first.text, confidence: first.confidence, agreed: true, alternatives: [] }

  const ranked = [...usable].sort(
    (a, b) => scoreOcrCandidate(b.text, b.confidence) - scoreOcrCandidate(a.text, a.confidence),
  )
  return {
    text: ranked[0]!.text,
    confidence: ranked[0]!.confidence,
    agreed: false,
    alternatives: ranked.slice(1).map((c) => c.text).slice(0, 2),
  }
}

/**
 * Evaluates a reading as an arithmetic expression (`a + b`, `a x b`,
 * `a - b`, `a ÷ b`, optionally ending in `=`) and returns the computed value,
 * or null when the text is not a clean single expression. Lets the agent fill
 * computed captchas directly instead of doing the math itself.
 */
export function evaluateArithmetic(text: string): number | null {
  const compact = normalizeForCompare(text)
  const match = compact.match(/^(\d+(?:\.\d+)?)\s*([+xX*×\-÷/])\s*(\d+(?:\.\d+)?)\s*=?$/)
  if (!match) return null
  const a = Number(match[1])
  const b = Number(match[3])
  const op = match[2]
  // `number | null`: division by zero yields null, handled below.
  let value: number | null
  switch (op) {
    case '+': value = a + b; break
    case '-': value = a - b; break
    case 'x': case 'X': case '*': case '×': value = a * b; break
    case '÷': case '/': value = b === 0 ? null : a / b; break
    default: return null
  }
  if (value === null) return null
  return Math.round(value * 1000) / 1000
}
