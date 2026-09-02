/**
 * Persistent kernel host: a static content script that installs the in-page
 * kernel once per frame and keeps it resident for the document's lifetime.
 *
 * ## Why this exists
 *
 * The driver used to serialize the whole kernel (`runOp`, ~1800 lines) into
 * every op via `chrome.scripting.executeScript`. Now it ships only the op
 * through a tiny trampoline and this script provides the kernel it calls:
 * install cost moves off the per-op interaction path and onto page load.
 *
 * ## World sharing
 *
 * This script and the driver's `func` injections both run in the extension's
 * ISOLATED world of the frame, so the global installed here is visible to the
 * trampoline. `runOp` is self-contained (the kernel's "one rule"), so holding
 * the function object needs no closure over this module.
 *
 * ## Footprint note
 *
 * This is the extension's first static content script: it loads into every
 * http(s) frame at document_idle. It does nothing on its own — it registers a
 * global and waits; no page data leaves the frame until the user triggers an
 * agent action, exactly like the previous on-demand injection.
 *
 * @module inpage/content-kernel
 */

import { runOp } from './kernel'
import { KERNEL_VERSION } from './kernel-version'

type KernelGlobal = {
  __browserCopilotKernel?: typeof runOp
  __browserCopilotKernelVersion?: number
}

const g = globalThis as KernelGlobal
// Replace a stale kernel: after an extension reload the previous version stays
// resident in existing tabs until each frame navigates. A version mismatch
// makes the driver's trampoline treat the old kernel as absent, so the next op
// re-injects the fresh one over it.
if (!g.__browserCopilotKernel || g.__browserCopilotKernelVersion !== KERNEL_VERSION) {
  g.__browserCopilotKernel = runOp
  g.__browserCopilotKernelVersion = KERNEL_VERSION
}
