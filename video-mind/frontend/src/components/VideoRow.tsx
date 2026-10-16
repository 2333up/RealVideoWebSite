import type { Folder, VideoSummary } from '../types'
import { formatBytes, formatDuration } from '../lib/format'

interface Props {
  video: VideoSummary
  selected: boolean
  folders: Folder[]
  onSelect: (id: number) => void
  onAnalyze: (id: number, force: boolean) => void
  onMove: (videoId: number, folderId: number | null) => void
}

/**
 * 分类树里的单个视频条目（挂在某个分类节点下方）。
 *
 * 每条都可拖拽——「把这条拖到别的分类」是肌肉记忆级操作；选中后额外给出
 * 「移动到」下拉，那是给键盘用户的等价入口，两者缺一不可。
 */
export default function VideoRow({
  video: v,
  selected,
  folders,
  onSelect,
  onAnalyze,
  onMove,
}: Props) {
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
      className={[
        'px-2 py-1.5 rounded cursor-pointer transition',
        selected ? 'bg-blue-50' : 'hover:bg-gray-50',
      ].join(' ')}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-gray-800 truncate" title={v.title}>
            {v.title}
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            {formatDuration(v.duration)} · {formatBytes(v.size_bytes)}
          </div>
        </div>
        <StatusBadge status={v.status} />
      </div>

      {selected && v.status !== 'processing' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onAnalyze(v.id, v.status === 'ready')
            }}
            className="text-[10px] px-2 py-1 rounded border border-gray-300 hover:bg-white"
          >
            {v.status === 'ready' ? '重新分析' : '开始分析'}
          </button>
          <select
            value={v.folder_id === null ? '' : String(v.folder_id)}
            onChange={(e) => {
              e.stopPropagation()
              onMove(v.id, e.target.value === '' ? null : Number(e.target.value))
            }}
            onClick={(e) => e.stopPropagation()}
            title="移动到分类文件夹"
            className="text-[10px] px-1 py-1 rounded border border-gray-300 bg-white max-w-[110px]"
          >
            <option value="">未分类</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: VideoSummary['status'] }) {
  const map: Record<string, { text: string; cls: string }> = {
    pending: { text: '待分析', cls: 'bg-gray-100 text-gray-600' },
    processing: { text: '处理中', cls: 'bg-blue-100 text-blue-700' },
    ready: { text: '已完成', cls: 'bg-green-100 text-green-700' },
    failed: { text: '失败', cls: 'bg-red-100 text-red-700' },
  }
  const m = map[status] ?? map.pending
  return (
    <span className={['text-[10px] px-1.5 py-0.5 rounded shrink-0', m.cls].join(' ')}>
      {m.text}
    </span>
  )
}
