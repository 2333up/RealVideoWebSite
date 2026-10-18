/**
 * video-mind 的图标集（内联 SVG）。
 *
 * 为什么自己画而不是装一套图标库：
 *   - 全站需要的形状不到 20 个，为它们引入一个依赖包不划算；
 *   - 之前混用了 emoji（📁 📂 📥 🎬）和字符（▸ ▾ » « ✕ ＋ ↑ ↓ ⌨ ▶）——
 *     它们在 Windows / macOS 上的字形、字重、基线全不一致，同一个「×」
 *     换台机器大小能差一倍，按钮高度也跟着飘。这正是这一版要根治的问题。
 *   - 统一到「24×24 视口 + 1.75 描边 + currentColor」之后，
 *     形状、线宽、颜色全部可控，也不会再受系统字体影响。
 *
 * 两条硬规则：
 *   1. 图标不自带颜色，一律 currentColor，颜色由外层文字色决定；
 *   2. 纯图标按钮必须走 IconButton（触控区不小于 24×24）——
 *      这既是 WCAG 2.2 的最小目标尺寸，也是鼠标下最容易点中的大小。
 */
import type { ReactNode, SVGProps } from 'react'

export interface IconProps extends SVGProps<SVGSVGElement> {
  /** 边长（px）。默认 16：配 11px 文字；密集行里可用 14 */
  size?: number
}

/** 描边图标：线宽 1.75，圆角端点，视觉重量和 11-13px 中文相当 */
function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** 填充图标（播放三角这类实心形状用；描边版会显得空） */
function FilledIcon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
      {...rest}
    >
      {children}
    </svg>
  )
}

// ------------------------------------------------------------------ 图标

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const PencilIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </Icon>
)

export const TrashIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
    <path d="M19 6l-1 13.5A1.5 1.5 0 0 1 16.5 21h-9A1.5 1.5 0 0 1 6 19.5L5 6" />
    <path d="M10 11v6M14 11v6" />
  </Icon>
)

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
)

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 6L9 17l-5-5" />
  </Icon>
)

export const ChevronRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 5l7 7-7 7" />
  </Icon>
)

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 9l7 7 7-7" />
  </Icon>
)

/** « 向左收起面板 */
export const ChevronsLeftIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
  </Icon>
)

/** » 向右收起面板 */
export const ChevronsRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 17l5-5-5-5M13 17l5-5-5-5" />
  </Icon>
)

export const ArrowUpIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
  </Icon>
)

export const ArrowDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5.5 12.5L12 19l6.5-6.5" />
  </Icon>
)

export const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
)

export const KeyboardIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6.5 10h.01M10.5 10h.01M14.5 10h.01M18 10h.01M8.5 14h7" />
  </Icon>
)

/**
 * 笔记节点：一张便签（右下角折起 + 两道文字线）。
 *
 * 它必须一眼区别于普通节点——笔记不在时间轴上，是用户自己补的注记。
 * 用「便签」而不是「书签 / 卡片」：便签天然传达「这是贴上去的补充说明」。
 */
export const NoteIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9L15.5 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5z" />
    <path d="M20.5 15H16a1 1 0 0 0-1 1v4.5" />
    <path d="M7.5 9.5h9M7.5 13h5" />
  </Icon>
)

/**
 * 节点笔记（Markdown）标记。
 *
 * 和上面的 NoteIcon（便签=不挂时间轴的笔记节点）刻意画得不一样：
 * 这个是「一张写了字的本子页」，用在节点角上表示「这里有附加笔记」，
 * 两个概念混用同一个形状会让人分不清「节点类型」和「节点内容」。
 */
export const MemoIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.5" y="3.5" width="15" height="17" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </Icon>
)

export const FolderIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l1 1.4a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </Icon>
)

export const FolderOpenIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8V6a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.6.8l1 1.4a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2v1" />
    <path d="M3 8h17.2a1 1 0 0 1 .95 1.32l-1.6 5A2 2 0 0 1 17.7 15.5H4.6L3 8z" />
  </Icon>
)

export const InboxIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12h5l1.5 2.5h5L16 12h5" />
    <path d="M5.4 5h13.2a2 2 0 0 1 1.8 1.1l2.6 5.4v6a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-6l2.6-5.4A2 2 0 0 1 5.4 5z" />
  </Icon>
)

/** 视频（空状态插画、导入按钮上的装饰图标） */
export const VideoIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="6" width="14" height="12" rx="2" />
    <path d="M16.5 10.5l5-3v9l-5-3v-3z" />
  </Icon>
)

/** 实心播放三角：中央大按钮和「正在播放」标记都用它 */
export const PlayIcon = (p: IconProps) => (
  <FilledIcon {...p}>
    <path d="M8 5.2v13.6a.6.6 0 0 0 .92.5l10.4-6.8a.6.6 0 0 0 0-1L8.92 4.7a.6.6 0 0 0-.92.5z" />
  </FilledIcon>
)

/** 实心暂停：暂停态的按钮就是它，描边版在深色底上看不清 */
export const PauseIcon = (p: IconProps) => (
  <FilledIcon {...p}>
    <path d="M7.5 4.5h3.2v15H7.5zM13.3 4.5h3.2v15h-3.2z" />
  </FilledIcon>
)

/**
 * 重新分析：环形箭头（顺时针）。
 * 和播放三角必须一眼分得开——「已完成」的视频点下去是重跑，
 * 用三角会让人以为是「播放这个视频」。
 */
export const RefreshIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01" />
    <path d="M20.5 3.2v5.1h-5.1" />
  </Icon>
)

export const VolumeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5z" />
    <path d="M15 9a4 4 0 0 1 0 6M17.8 6.5a8 8 0 0 1 0 11" />
  </Icon>
)

export const VolumeMuteIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5z" />
    <path d="M15.5 9.5l5 5M20.5 9.5l-5 5" />
  </Icon>
)

export const FullscreenIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3H5.5A2.5 2.5 0 0 0 3 5.5V8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16M16 21h2.5a2.5 2.5 0 0 0 2.5-2.5V16" />
  </Icon>
)

export const ExitFullscreenIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8h2.5A2.5 2.5 0 0 0 8 5.5V3M21 8h-2.5A2.5 2.5 0 0 1 16 5.5V3M3 16h2.5A2.5 2.5 0 0 1 8 18.5V21M21 16h-2.5a2.5 2.5 0 0 0-2.5 2.5V21" />
  </Icon>
)

/** 全部收起：两个箭头向中间合拢 */
export const FoldAllIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 3v6M18 3v6M3.5 9h17M12 11v10M8.5 17.5L12 21l3.5-3.5" />
  </Icon>
)

/** 全部展开：两个箭头向外张开 */
export const UnfoldAllIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 9V3M18 9V3M3.5 9h17M12 21V11M8.5 14.5L12 11l3.5 3.5" />
  </Icon>
)

export const RewindIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 5v14L2.5 12 11 5z" />
    <path d="M21 5v14l-8.5-7L21 5z" />
  </Icon>
)

export const ForwardIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 5v14l8.5-7L13 5z" />
    <path d="M3 5v14l8.5-7L3 5z" />
  </Icon>
)

// ------------------------------------------------------------------ 图标按钮

type Tone = 'default' | 'danger' | 'primary'

/**
 * 纯图标按钮。
 *
 * 触控区按 WCAG 2.2 的最小目标尺寸给到 24×24（size='lg' 是 28×28），
 * 图标本身仍是 16px——视觉上不会变笨重，但点中的面积是够的。
 * 之前那些 text-[10px] + px-0.5 的字符按钮实测只有 13×16，
 * 鼠标都要瞄一下才点得中，更别说触控屏。
 *
 * 注意：title 与 aria-label 必须给，图标按钮没有可访问名称就等于不存在。
 */
export function IconButton({
  icon,
  label,
  onClick,
  tone = 'default',
  size = 'md',
  className = '',
  ...rest
}: {
  /** 图标节点，如 <TrashIcon size={14} /> */
  icon: ReactNode
  /** 无障碍名称，同时作为悬浮提示 */
  label: string
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  tone?: Tone
  size?: 'md' | 'lg'
  className?: string
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'title' | 'children'>) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={[
        'inline-flex items-center justify-center shrink-0 rounded transition-colors',
        size === 'lg' ? 'h-7 w-7' : 'h-6 w-6',
        rest.disabled
          ? 'text-gray-300 cursor-not-allowed'
          : tone === 'danger'
            ? 'text-gray-400 hover:text-red-600 hover:bg-red-50'
            : tone === 'primary'
              ? 'text-blue-600 hover:bg-blue-50'
              : 'text-gray-400 hover:text-gray-900 hover:bg-gray-100',
        className,
      ].join(' ')}
      {...rest}
    >
      {icon}
    </button>
  )
}

/**
 * 带文字的小按钮统一的最小高度。
 *
 * 全站小号按钮此前是 py-1 + text-[10px] ≈ 22px，差一点点；
 * 统一拉到 24px，和纯图标按钮同高，一排混排时才不会高低不齐。
 */
export const MIN_TAPPABLE = 'min-h-[24px] inline-flex items-center justify-center'
