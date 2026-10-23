/**
 * Version stamp of the in-page kernel's op vocabulary, shared by the persistent
 * content script (which installs the kernel) and the driver (which dispatches
 * to it). Bump when `Op`/`OpResult` shape or kernel behavior changes in a way
 * that older resident kernels would mishandle: the trampoline then treats the
 * stale kernel as absent and re-injects the fresh one.
 *
 * Exists as its own runtime module because `lib/ops.ts` is types-only by the
 * kernel's serialization rules.
 *
 * 4: `get_value` (read one form control's live value) joined the vocabulary. A
 *    kernel from build 3 still resident in a frame — an extension reload with
 *    no navigation since — has no branch for it, so without this bump the op
 *    would fall through to whatever the old kernel does with an unknown action.
 * 5: element selectors given to `count_elements` / `element_selector_at` resolve
 *    XPath as well as CSS (Automa element loops). A kernel from build 4 would
 *    report 0 matches for an XPath selector and the loop would run 0 times.
 *
 * @module inpage/kernel-version
 */

export const KERNEL_VERSION = 5
