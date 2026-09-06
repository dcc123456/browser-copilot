/**
 * Block icon rendering.
 *
 * Every block icon is a lucide icon, referenced from the catalog by a spec
 * string of the form `lucide:<PascalName>` (e.g. `lucide:Zap`). The components
 * are imported explicitly and resolved through a static map — not through a
 * dynamic all-icons registry — so the bundle ships only the glyphs the catalog
 * actually uses.
 *
 * Backward compatibility: workflows saved by older versions persist icon specs
 * in three older formats, and all of them still render:
 *  - `riXxx` / `ri-xxx` RemixIcon names from the previous webfont-based system
 *    (e.g. a workflow meta icon of `ri-flow-chart`), mapped through
 *    {@link LEGACY_RI_ALIASES};
 *  - `path:<d>` inline SVG paths (Material Design aliases);
 *  - remote `https://…` images.
 *
 * Content scripts (element picker / recorder) cannot use React components —
 * they inline the same lucide geometry directly as SVG strings.
 *
 * @module lib/workflow/blocks/icons
 */
import type { LucideIcon } from 'lucide-react'
import {
  AppWindow,
  AppWindowMac,
  ArrowLeftRight,
  ArrowUpWideNarrow,
  ArrowUpDown,
  Bell,
  Bot,
  Brackets,
  Camera,
  Clipboard,
  CircleX,
  CodeXml,
  Cookie,
  Database,
  Diff,
  Download,
  FileClock,
  FileDown,
  FilePen,
  FileUp,
  Focus,
  FolderArchive,
  GitBranch,
  Globe,
  HardDrive,
  HardDriveUpload,
  Hourglass,
  Image,
  Keyboard,
  Lightbulb,
  Link,
  Link2,
  ListChecks,
  ListTree,
  MessageSquare,
  Mouse,
  MousePointer2,
  MousePointerClick,
  Network,
  Package,
  RefreshCcw,
  RefreshCw,
  Repeat2,
  RotateCcw,
  Save,
  ScanText,
  Settings,
  Bookmark,
  ShieldCheck,
  Slice,
  Square,
  SquareFunction,
  SquarePlus,
  SquareTerminal,
  Table,
  TextCursorInput,
  Timer,
  Trash2,
  Type,
  Undo2,
  Redo2,
  Webhook,
  Workflow,
  Zap,
} from 'lucide-react'

/** Fallback when a spec resolves to nothing (keeps nodes renderable). */
const DEFAULT_ICON = Workflow

/**
 * Catalog lucide specs → components.
 *
 * Keys are the bare Pascal names used after the `lucide:` prefix.
 */
const LUCIDE_ICONS: Record<string, LucideIcon> = {
  AppWindow,
  AppWindowMac,
  ArrowLeftRight,
  ArrowUpWideNarrow,
  ArrowUpDown,
  Bell,
  Bot,
  Brackets,
  Camera,
  Clipboard,
  CircleX,
  CodeXml,
  Cookie,
  Database,
  Diff,
  Download,
  FileClock,
  FileDown,
  FilePen,
  FileUp,
  Focus,
  FolderArchive,
  GitBranch,
  Globe,
  HardDrive,
  HardDriveUpload,
  Hourglass,
  Image,
  Keyboard,
  Lightbulb,
  Link,
  Link2,
  ListChecks,
  ListTree,
  MessageSquare,
  Mouse,
  MousePointer2,
  MousePointerClick,
  Network,
  Package,
  RefreshCcw,
  RefreshCw,
  Repeat2,
  Redo2,
  RotateCcw,
  Save,
  ScanText,
  Bookmark,
  Settings,
  ShieldCheck,
  Slice,
  Square,
  SquareFunction,
  SquarePlus,
  SquareTerminal,
  Table,
  TextCursorInput,
  Timer,
  Trash2,
  Type,
  Undo2,
  Webhook,
  Workflow,
  Zap,
}

/**
 * RemixIcon names used by catalog versions before the lucide migration, in
 * their Pascal form (`riFlashlightLine`). Workflows persisted by those
 * versions — and workflow meta icons, whose default was `ri-flow-chart` —
 * resolve through this table instead of a missing webfont.
 */
const LEGACY_RI_ALIASES: Record<string, string> = {
  riFlashlightLine: 'Zap',
  riFlowChart: 'Workflow',
  riWindowLine: 'AppWindow',
  riGlobalLine: 'Globe',
  riArrowLeftRightLine: 'ArrowLeftRight',
  riWindow2Line: 'AppWindowMac',
  riShieldKeyholeLine: 'ShieldCheck',
  riArrowGoBackLine: 'Undo2',
  riArrowGoForwardLine: 'Redo2',
  riCloseCircleLine: 'CircleX',
  riImageLine: 'Image',
  riLightbulbLine: 'Lightbulb',
  riCursorLine: 'MousePointer2',
  riTimerLine: 'Timer',
  riParagraph: 'Type',
  riDownloadLine: 'Download',
  riMouseLine: 'Mouse',
  riLink: 'Link',
  riBracketsLine: 'Brackets',
  riInputCursorMove: 'TextCursorInput',
  riRepeat2Line: 'Repeat2',
  riCodeSSlashLine: 'CodeXml',
  riLightbulbFlashLine: 'MousePointerClick',
  riTableLine: 'Table',
  riDriveFill: 'HardDriveUpload',
  riDriveLine: 'HardDrive',
  riAB: 'GitBranch',
  riFocus3Line: 'Focus',
  riEarthLine: 'Webhook',
  riRefreshFill: 'RefreshCw',
  riRefreshLine: 'RefreshCcw',
  riRestartLine: 'RotateCcw',
  riStopLine: 'Square',
  riFolderZipLine: 'FolderArchive',
  riClipboardLine: 'Clipboard',
  riDatabase2Line: 'Database',
  riArrowUpDownLine: 'ArrowUpDown',
  riFileUploadLine: 'FileUp',
  riCursorFill: 'MousePointer2',
  riKeyboardLine: 'Keyboard',
  riChat3Line: 'MessageSquare',
  riFileDownloadLine: 'FileDown',
  riSaveLine: 'Save',
  riDeleteBin7Line: 'Trash2',
  riTimerFlashLine: 'Hourglass',
  riNotification3Line: 'Bell',
  riFileHistoryLine: 'FileClock',
  riLinksLine: 'Link2',
  riSliceLine: 'Slice',
  riIncreaseDecreaseLine: 'Diff',
  riFunctionLine: 'SquareFunction',
  riMindMap: 'Network',
  riSortAsc: 'ArrowUpWideNarrow',
  riHtml5Line: 'SquarePlus',
  riCookieLine: 'Cookie',
  riFileEditLine: 'FilePen',
  riSettings3Line: 'Settings',
  riCommandLine: 'SquareTerminal',
  riRobot2Line: 'Bot',
  riCharacterRecognitionLine: 'ScanText',
  riBookmarkLine: 'Bookmark',
}

/**
 * Kebab (`ri-flow-chart`) → Pascal (`riFlowChart`), so legacy specs written in
 * webfont-class form hit the alias table too.
 */
function pascalRiName(name: string): string {
  if (!name.includes('-')) return name
  const [ri, ...rest] = name.split('-')
  return ri + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
}

/**
 * Resolves any supported spec to the lucide icon name it renders, or `null`
 * when the spec is unknown and {@link BlockIcon} would fall back to the
 * default icon. Exported so tests can pin every catalog icon to a real glyph.
 */
export function resolveIconName(icon: string): string | null {
  const bare = icon.startsWith('lucide:') ? icon.slice('lucide:'.length) : icon
  if (LUCIDE_ICONS[bare]) return bare
  if (bare.startsWith('ri')) {
    const legacy = LEGACY_RI_ALIASES[bare] ?? LEGACY_RI_ALIASES[pascalRiName(bare)]
    if (legacy && LUCIDE_ICONS[legacy]) return legacy
  }
  return null
}

/** Resolves any supported icon spec to a lucide component. */
function resolveIcon(icon: string): LucideIcon {
  const name = resolveIconName(icon)
  return (name && LUCIDE_ICONS[name]) || DEFAULT_ICON
}

/** Inline SVG for the `path:<d>` icon spec (Material Design aliases). */
export function CustomPathIcon({ path, size = 20 }: { path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={path} />
    </svg>
  )
}

export interface BlockIconProps {
  /**
   * Icon spec: `lucide:<PascalName>` (catalog default) or, for data saved by
   * older versions, `riXxx`/`ri-xxx`, `path:<d>`, or an `https://…` image.
   */
  icon: string
  size?: number
  className?: string
  /** Apply the dark-mode image inversion Automa uses for remote icons. */
  invertInDark?: boolean
}

/** Renders a block icon regardless of which of the spec forms it uses. */
export function BlockIcon({ icon, size = 20, className, invertInDark }: BlockIconProps) {
  if (icon.startsWith('http')) {
    return (
      <img
        src={icon}
        width={size}
        height={size}
        alt=""
        className={className}
        style={invertInDark ? { filter: 'var(--bc-icon-invert, none)' } : undefined}
      />
    )
  }
  if (icon.startsWith('path:')) {
    return (
      <span className={className} style={{ display: 'inline-flex' }}>
        <CustomPathIcon path={icon.slice('path:'.length)} size={size} />
      </span>
    )
  }
  const Icon = resolveIcon(icon)
  return (
    <span className={className} style={{ display: 'inline-flex' }}>
      <Icon size={size} aria-hidden />
    </span>
  )
}
