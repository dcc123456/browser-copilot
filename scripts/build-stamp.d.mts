/**
 * Types for `build-stamp.mjs`, which vite.config.ts imports to stamp the bundle.
 *
 * The config is TypeScript and the script is plain ESM with Node built-ins;
 * without this declaration `pnpm typecheck` calls the import implicit `any`.
 */
export function sourceFingerprintSync(cwd?: string): string
export function buildFingerprint(cwd?: string): Promise<string>
export function stampFile(cwd?: string): string
export function readLoadedStamp(cwd?: string): Promise<string>
export function writeLoadedStamp(fingerprint: string, cwd?: string): Promise<boolean>
