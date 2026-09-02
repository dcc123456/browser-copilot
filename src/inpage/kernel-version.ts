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
 * @module inpage/kernel-version
 */

export const KERNEL_VERSION = 3
