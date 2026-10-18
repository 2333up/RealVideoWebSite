import type { VideoSummary } from '../types'
import { formatBytes, formatDuration, formatDurationShort } from '../lib/format'
import { IconButton, PlayIcon, RefreshIcon } from './icons'

interface Props {
  video: VideoSummary
  selected: boolean
  onSelect: (id: number) => void
  onAnalyze: (id: number, force: boolean) => void
  /**
   * 宽面板模式。
   *
   * 左栏最窄 200px、最宽 560px。窄的时候一切为了「多塞几条」，行高 24px、
   * 体积之类全塞进 tooltip；可一旦拉到 400px 以上，同样 24px 高的行就会
   * 在中间撑出一大片空白，看着像没加载完。所以宽的时候把行放开：
   * 高 32px、标题 13px、时长和体积都摊到右边——空间用来放信息，而不是留白。
   */
  wide?: boolean
}

/** 状态徽章的文案与配色。四种状态都要有字：列表里最要紧的信息就是「这条能不能看」 */
const STATUS: Record<VideoSummary['status'], { text: string; cls: string }> = {
  pending: { text: '待分析', cls: 'bg-gray-100 text-gray-500' },
  processing: { text: '处理中', cls: 'bg-blue-100 text-blue-700' },
  ready: { text: '已完成', cls: 'bg-green-100 text-green-700' },
  failed: { text: '失败', cls: 'bg-red-100 text-red-700' },
}

/**
 * 分类树里的单个视频条目（挂在某个分类节点下方）。
 *
 * 2026-10-18 收紧成**一行**。之前是三行：
 *   ① 标题  ② 时长 · 体积  ③ 选中后长出来的「开始分析 + 移动到」下拉框
 * 左栏只有 256px 宽，一屏放不下几条，翻列表得一直滚。
 * 现在的取舍：
 *   - 体积挪进 title 提示：挑视频看的是时长，体积只在排查导入问题时才有用；
 *   - 「移动到分类」下拉**删掉**：拖到分类行才是主路径，那个下拉只为键盘
 *     用户留一个等价入口，却让每条视频都白付一行高度和一个小控件；
 *   - 「开始分析」从文字按钮换成 24×24 的图标按钮（未分析=播放三角，
 *     已完成=环形箭头），高度正好落在这一行里，不再另起一行。
 *
 * 仍保留 draggable：把这条丢进那个分类是肌肉记忆级操作，不能丢。
 */
export default function VideoRow({ video: v, selected, onSelect, onAnalyze, wide = false }: Props) {
  const busy = v.status === 'processing'
  const ready = v.status === 'ready'
  const badge = STATUS[v.status] ?? STATUS.pending

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(v.id))
        e.dataTransfer.effectAllowed = 'move'
        // 拖视频时别把父节点的展开状态搅乱
        e.stopPropagation()
      }}
      onClick={() => onSelect(v.id)}
      // 第二行信息（体积）走 tooltip：窄面板里一寸空间都要留给标题
      title={`${v.title}\n${formatDuration(v.duration)} · ${formatBytes(v.size_bytes)} · ${badge.text}`}
      className={[
        'group flex items-center rounded cursor-pointer transition',
        wide ? 'h-8 gap-2 px-2' : 'h-6 gap-1.5 px-1.5',
        selected ? 'bg-blue-50' : 'hover:bg-gray-50',
      ].join(' ')}
    >
      <span
        className={[
          'shrink-0 rounded leading-4',
          wide ? 'px-1.5 text-[11px]' : 'px-1 text-[10px]',
          badge.cls,
        ].join(' ')}
        // 颜色只是辅助，状态本身由文字表达——色弱用户也读得懂
      >
        {badge.text}
      </span>

      <span
        className={[
          'min-w-0 flex-1 truncate',
          wide ? 'text-[13px] text-gray-800' : 'text-[11px] text-gray-800',
        ].join(' ')}
      >
        {v.title}
      </span>

      {/* 宽的时候把体积也摊出来：右侧有富余，藏着等于浪费 */}
      {wide && (
        <span className="shrink-0 text-[11px] tabular-nums text-gray-400">
          {formatBytes(v.size_bytes)}
        </span>
      )}

      <span
        className={[
          'shrink-0 tabular-nums text-gray-400',
          wide ? 'text-[11px]' : 'text-[10px]',
        ].join(' ')}
      >
        {formatDurationShort(v.duration)}
      </span>

      {/* 处理中不给按钮：任务在跑，点了也只会再来一次排队 */}
      {!busy && (
        <IconButton
          icon={ready ? <RefreshIcon size={wide ? 14 : 13} /> : <PlayIcon size={wide ? 12 : 11} />}
          label={ready ? '重新分析' : '开始分析'}
          onClick={(e) => {
            // 别让按钮的点击顺带把这一行也选中/触发跳转
            e.stopPropagation()
            onAnalyze(v.id, ready)
          }}
          // 平时浅灰、悬停变深：图标常驻（这是每行最主要的动作），
          // 但不跟标题抢视觉重量
          className="group-hover:bg-gray-100 group-hover:text-gray-700"
        />
      )}
    </div>
  )
}
