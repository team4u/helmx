import type { CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'
import Activity from 'lucide-react/icons/activity'
import AlertCircle from 'lucide-react/icons/alert-circle'
import AlertTriangle from 'lucide-react/icons/alert-triangle'
import Archive from 'lucide-react/icons/archive'
import ArrowDown from 'lucide-react/icons/arrow-down'
import ArrowDownToLine from 'lucide-react/icons/arrow-down-to-line'
import ArrowLeft from 'lucide-react/icons/arrow-left'
import ArrowRight from 'lucide-react/icons/arrow-right'
import ArrowUp from 'lucide-react/icons/arrow-up'
import Bell from 'lucide-react/icons/bell'
import BellOff from 'lucide-react/icons/bell-off'
import Bot from 'lucide-react/icons/bot'
import Boxes from 'lucide-react/icons/boxes'
import Check from 'lucide-react/icons/check'
import CheckCircle2 from 'lucide-react/icons/check-circle-2'
import CheckSquare from 'lucide-react/icons/check-square'
import ChevronDown from 'lucide-react/icons/chevron-down'
import ChevronLeft from 'lucide-react/icons/chevron-left'
import ChevronRight from 'lucide-react/icons/chevron-right'
import ChevronUp from 'lucide-react/icons/chevron-up'
import ChevronsUpDown from 'lucide-react/icons/chevrons-up-down'
import Circle from 'lucide-react/icons/circle'
import CircleSlash from 'lucide-react/icons/circle-slash'
import Clock from 'lucide-react/icons/clock'
import Code2 from 'lucide-react/icons/code-2'
import Columns2 from 'lucide-react/icons/columns-2'
import Copy from 'lucide-react/icons/copy'
import CornerDownRight from 'lucide-react/icons/corner-down-right'
import Cpu from 'lucide-react/icons/cpu'
import Download from 'lucide-react/icons/download'
import Edit3 from 'lucide-react/icons/edit-3'
import ExternalLink from 'lucide-react/icons/external-link'
import Eye from 'lucide-react/icons/eye'
import File from 'lucide-react/icons/file'
import FileCode from 'lucide-react/icons/file-code'
import FileDiff from 'lucide-react/icons/file-diff'
import FileText from 'lucide-react/icons/file-text'
import Folder from 'lucide-react/icons/folder'
import Gauge from 'lucide-react/icons/gauge'
import GitBranch from 'lucide-react/icons/git-branch'
import GitCommitHorizontal from 'lucide-react/icons/git-commit-horizontal'
import GitFork from 'lucide-react/icons/git-fork'
import GitPullRequest from 'lucide-react/icons/git-pull-request'
import Globe from 'lucide-react/icons/globe'
import HardDrive from 'lucide-react/icons/hard-drive'
import Info from 'lucide-react/icons/info'
import Key from 'lucide-react/icons/key'
import Laptop from 'lucide-react/icons/laptop'
import Layers from 'lucide-react/icons/layers'
import LayoutGrid from 'lucide-react/icons/layout-grid'
import ListFilter from 'lucide-react/icons/list-filter'
import ListTree from 'lucide-react/icons/list-tree'
import Loader2 from 'lucide-react/icons/loader-2'
import Lock from 'lucide-react/icons/lock'
import Maximize2 from 'lucide-react/icons/maximize-2'
import Menu from 'lucide-react/icons/menu'
import MessageSquare from 'lucide-react/icons/message-square'
import Minimize2 from 'lucide-react/icons/minimize-2'
import Minus from 'lucide-react/icons/minus'
import Monitor from 'lucide-react/icons/monitor'
import Moon from 'lucide-react/icons/moon'
import MoonStar from 'lucide-react/icons/moon-star'
import MoreHorizontal from 'lucide-react/icons/more-horizontal'
import Network from 'lucide-react/icons/network'
import PanelRight from 'lucide-react/icons/panel-right'
import PanelsTopLeft from 'lucide-react/icons/panels-top-left'
import Paperclip from 'lucide-react/icons/paperclip'
import Play from 'lucide-react/icons/play'
import Plug from 'lucide-react/icons/plug'
import Plus from 'lucide-react/icons/plus'
import Puzzle from 'lucide-react/icons/puzzle'
import RefreshCw from 'lucide-react/icons/refresh-cw'
import RotateCcw from 'lucide-react/icons/rotate-ccw'
import RotateCw from 'lucide-react/icons/rotate-cw'
import Save from 'lucide-react/icons/save'
import Search from 'lucide-react/icons/search'
import Send from 'lucide-react/icons/send'
import Server from 'lucide-react/icons/server'
import Settings from 'lucide-react/icons/settings'
import Shield from 'lucide-react/icons/shield'
import ShieldAlert from 'lucide-react/icons/shield-alert'
import Sliders from 'lucide-react/icons/sliders'
import Sparkles from 'lucide-react/icons/sparkles'
import Square from 'lucide-react/icons/square'
import Sun from 'lucide-react/icons/sun'
import Terminal from 'lucide-react/icons/terminal'
import Trash2 from 'lucide-react/icons/trash-2'
import Upload from 'lucide-react/icons/upload'
import Webhook from 'lucide-react/icons/webhook'
import Workflow from 'lucide-react/icons/workflow'
import WrapText from 'lucide-react/icons/wrap-text'
import Wrench from 'lucide-react/icons/wrench'
import X from 'lucide-react/icons/x'
import Zap from 'lucide-react/icons/zap'
import ZoomIn from 'lucide-react/icons/zoom-in'
import ZoomOut from 'lucide-react/icons/zoom-out'

export type HelmxIconName =
  | 'sparkles'
  | 'bot'
  | 'boxes'
  | 'layout'
  | 'globe'
  | 'terminal'
  | 'shield'
  | 'shield-alert'
  | 'network'
  | 'clock'
  | 'webhook'
  | 'check'
  | 'check-circle'
  | 'check-square'
  | 'x'
  | 'alert-triangle'
  | 'alert-circle'
  | 'play'
  | 'square'
  | 'git-branch'
  | 'git-commit'
  | 'git-fork'
  | 'file'
  | 'file-text'
  | 'file-code'
  | 'file-diff'
  | 'cpu'
  | 'hard-drive'
  | 'laptop'
  | 'server'
  | 'search'
  | 'settings'
  | 'puzzle'
  | 'plugin'
  | 'plugins'
  | 'plug'
  | 'plus'
  | 'trash-2'
  | 'trash'
  | 'archive'
  | 'eye'
  | 'refresh-cw'
  | 'rotate-ccw'
  | 'rotate-cw'
  | 'folder'
  | 'paperclip'
  | 'send'
  | 'sliders'
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'chevron-up'
  | 'chevrons-up-down'
  | 'columns'
  | 'panel-right'
  | 'copy'
  | 'edit'
  | 'edit-3'
  | 'workflow'
  | 'wrench'
  | 'zap'
  | 'key'
  | 'lock'
  | 'layers'
  | 'loader'
  | 'activity'
  | 'bell'
  | 'bell-off'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'system'
  | 'more'
  | 'more-horizontal'
  | 'minus'
  | 'download'
  | 'upload'
  | 'maximize'
  | 'maximize-2'
  | 'menu'
  | 'minimize'
  | 'minimize-2'
  | 'zoom-in'
  | 'zoom-out'
  | 'external-link'
  | 'arrow-down'
  | 'arrow-down-to-line'
  | 'arrow-left'
  | 'arrow-right'
  | 'arrow-up'
  | 'git-pull-request'
  | 'corner-down-right'
  | 'message-square'
  | 'code'
  | 'circle'
  | 'circle-slash'
  | 'layout-grid'
  | 'list-filter'
  | 'list-tree'
  | 'outline'
  | 'info'
  | 'moon-star'
  | 'save'
  | 'gauge'
  | 'wrap-text'

const ICON_MAP: Record<HelmxIconName, LucideIcon> = {
  sparkles: Sparkles,
  bot: Bot,
  boxes: Boxes,
  layout: PanelsTopLeft,
  globe: Globe,
  terminal: Terminal,
  shield: Shield,
  'shield-alert': ShieldAlert,
  network: Network,
  clock: Clock,
  webhook: Webhook,
  check: Check,
  'check-circle': CheckCircle2,
  'check-square': CheckSquare,
  x: X,
  'alert-triangle': AlertTriangle,
  'alert-circle': AlertCircle,
  play: Play,
  square: Square,
  'git-branch': GitBranch,
  'git-commit': GitCommitHorizontal,
  'git-fork': GitFork,
  file: File,
  'file-text': FileText,
  'file-code': FileCode,
  'file-diff': FileDiff,
  cpu: Cpu,
  'hard-drive': HardDrive,
  laptop: Laptop,
  server: Server,
  search: Search,
  settings: Settings,
  puzzle: Puzzle,
  plugin: Puzzle,
  plugins: Puzzle,
  plug: Plug,
  plus: Plus,
  'trash-2': Trash2,
  trash: Trash2,
  archive: Archive,
  eye: Eye,
  'refresh-cw': RefreshCw,
  'rotate-ccw': RotateCcw,
  'rotate-cw': RotateCw,
  folder: Folder,
  paperclip: Paperclip,
  send: Send,
  sliders: Sliders,
  'chevron-right': ChevronRight,
  'chevron-left': ChevronLeft,
  'chevron-down': ChevronDown,
  'chevron-up': ChevronUp,
  'chevrons-up-down': ChevronsUpDown,
  columns: Columns2,
  'panel-right': PanelRight,
  copy: Copy,
  edit: Edit3,
  'edit-3': Edit3,
  workflow: Workflow,
  wrench: Wrench,
  zap: Zap,
  key: Key,
  lock: Lock,
  layers: Layers,
  loader: Loader2,
  activity: Activity,
  bell: Bell,
  'bell-off': BellOff,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  system: Monitor,
  more: MoreHorizontal,
  'more-horizontal': MoreHorizontal,
  minus: Minus,
  download: Download,
  upload: Upload,
  maximize: Maximize2,
  'maximize-2': Maximize2,
  menu: Menu,
  minimize: Minimize2,
  'minimize-2': Minimize2,
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  'external-link': ExternalLink,
  'arrow-down': ArrowDown,
  'arrow-down-to-line': ArrowDownToLine,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'git-pull-request': GitPullRequest,
  'corner-down-right': CornerDownRight,
  'message-square': MessageSquare,
  code: Code2,
  circle: Circle,
  'circle-slash': CircleSlash,
  'layout-grid': LayoutGrid,
  'list-filter': ListFilter,
  'list-tree': ListTree,
  outline: ListTree,
  info: Info,
  'moon-star': MoonStar,
  save: Save,
  gauge: Gauge,
  'wrap-text': WrapText,
}

export interface HelmxIconProps {
  name?: HelmxIconName | (string & {})
  size?: number
  className?: string
  style?: CSSProperties
}

export function HelmxIcon({ name, size = 14, className, style }: HelmxIconProps) {
  const key = (name ?? 'circle').toLowerCase().trim()
  const Comp = Object.hasOwn(ICON_MAP, key)
    ? (ICON_MAP as Record<string, LucideIcon>)[key]!
    : Circle
  return <Comp size={size} strokeWidth={1.75} className={className} style={style} />
}
