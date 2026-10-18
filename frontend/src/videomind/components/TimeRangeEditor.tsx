import { useState } from 'react'
import { formatTs } from '../lib/format'
import { parseTimestamp } from '../lib/mindmapEdit'
import { ClockIcon, MIN_TAPPABLE } from './icons'

interface Props {
  start: number | null
  end: number | null
  /** 当前播放时间：「设为当前」按钮的取值 */
  currentTime: number
  /** inline = 在大纲行下方铺开；popover = 在画布节点下方浮出 */
  variant?: 'inline' | 'popover'
  onSubmit: (start: number | null, end: number | null) => void
  onCancel: () => void
}

/**
 * 节点时间范围编辑器（起点 + 终点）。
 *
 * 之前只有一个起点输入框，终点由后端按「下一个节点的时间」补——
 * 于是用户根本没法表达「这一段讲到 1:50 就结束了」，
 * 而章节的终点又是由节点终点推出来的，缺了它整条链路都对不上。
 *
 * 起与止是**两个独立的输入**，不是「起点 + 时长」：
 * 边看边标的时候，手里有的是「这里开始」「这里结束」两个时间点，
 * 让人心算时长再填，等于劝退。
 *
 * 三个出口都要有：起点留空 = 这个节点不持时间（清掉时间戳）；
 * 终点留空 = 只标起点，终点仍交给下一个节点推断。
 *
 * 2026-10-18 补了第四个出口：**「清除时间」按钮**。
 * 「把起点输入框删空再保存」虽然等价，但没人猜得到——用户明确要求
 * 「时间区域要能在编辑里增加或者取消」，那就得有个看得见的取消入口。
 */
export default function TimeRangeEditor({
  start,
  end,
  currentTime,
  variant = 'inline',
  onSubmit,
  onCancel,
}: Props) {
  const [startText, setStartText] = useState(start === null ? '' : formatTs(start))
  const [endText, setEndText] = useState(end === null ? '' : formatTs(end))
  /** 这个节点当前是否持时间：只有持着才需要「清除」 */
  const hasTime = start !== null || end !== null

  const submit = () => {
    const s = startText.trim() ? parseTimestamp(startText) : null
    if (startText.trim() && s === null) {
      alert('起点时间格式不对。可以填秒数（83）或 1:23 这样的写法。')
      return
    }
    const e = endText.trim() ? parseTimestamp(endText) : null
    if (endText.trim() && e === null) {
      alert('终点时间格式不对。可以填秒数（83）或 1:23 这样的写法。')
      return
    }
    if (s === null) {
      // 起点清空 = 这个节点不再持有时间；终点跟着一起清，不能留个孤儿终点
      onSubmit(null, null)
      return
    }
    if (e !== null && e <= s) {
      alert('结束时间必须晚于开始时间。')
      return
    }
    onSubmit(s, e)
  }

  const popover = variant === 'popover'

  return (
    <div
      // 画布上：nodrag 让 ReactFlow 别把它当成拖节点的起手；
      // 三个鼠标事件都要掐断，否则点输入框会顺带选中节点并跳转播放
      className={[
        'nodrag',
        popover
          ? 'absolute left-0 top-full mt-1 z-30 w-[236px] rounded-lg border border-gray-300 bg-white shadow-xl p-2 space-y-1.5'
          : 'mt-1 flex flex-wrap items-center gap-1.5',
      ].join(' ')}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          submit()
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    >
      <Field
        label="起点"
        value={startText}
        onChange={setStartText}
        onFill={() => setStartText(formatTs(currentTime))}
        fillLabel="把起点设为当前播放时间"
      />
      <Field
        label="终点"
        value={endText}
        onChange={setEndText}
        onFill={() => setEndText(formatTs(currentTime))}
        fillLabel="把终点设为当前播放时间"
      />

      <div className={['flex items-center gap-1', popover ? '' : 'w-full'].join(' ')}>
        {/* 清除放最左、离「保存」最远：它和「改一下」不是同一量级，
            摆在旁边容易手滑。只在确实有时间可清时出现。 */}
        {hasTime && (
          <button
            onClick={() => onSubmit(null, null)}
            title="取消这个节点的时间范围（它就不再对应视频里的一段了）"
            className={`text-[11px] px-2 rounded border border-gray-200 text-gray-500 hover:text-red-600 hover:border-red-200 hover:bg-red-50 ${MIN_TAPPABLE}`}
          >
            清除时间
          </button>
        )}
        <span className="flex-1" />
        <button
          onClick={submit}
          className={`text-[11px] px-2.5 rounded bg-blue-600 text-white hover:bg-blue-500 ${MIN_TAPPABLE}`}
        >
          保存
        </button>
        <button
          onClick={onCancel}
          className={`text-[11px] px-2.5 rounded border border-gray-300 bg-white hover:bg-gray-50 ${MIN_TAPPABLE}`}
        >
          取消
        </button>
      </div>

      {popover && (
        <p className="text-[10px] text-gray-400 leading-relaxed">
          起点留空 = 清掉这个节点的时间戳；终点留空 = 只标起点，终点由下一个节点推断。
          也可以点「清除时间」直接取消。
        </p>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  onFill,
  fillLabel,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onFill: () => void
  fillLabel: string
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-gray-500 shrink-0 w-6">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="1:23 或 83"
        aria-label={`时间范围${label}`}
        className="w-[70px] min-h-[24px] text-[11px] tabular-nums px-1.5 rounded border border-gray-300 bg-white text-gray-900 outline-none focus:border-blue-400"
      />
      <button
        type="button"
        // 画布里输入框失焦会立刻提交/关闭，先把默认行为掐掉，值才填得进去
        onMouseDown={(e) => e.preventDefault()}
        onClick={onFill}
        title={fillLabel}
        aria-label={fillLabel}
        className="inline-flex h-6 w-6 items-center justify-center shrink-0 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50"
      >
        <ClockIcon size={14} />
      </button>
    </div>
  )
}
