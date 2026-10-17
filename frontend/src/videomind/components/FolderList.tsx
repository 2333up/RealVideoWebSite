import { useEffect, useMemo, useState } from 'react'
import type { Folder, VideoSummary } from '../types'
import VideoRow from './VideoRow'

interface Props {
  folders: Folder[]
  /** 全量视频：按 folder_id 分组后就地挂在对应分类节点下 */
  videos: VideoSummary[]
  /** 当前选中的分类：'none' 未分类 | '<id>' 某个分类 */
  active: string
  selectedId: number | null
  unfiledCount: number
  onSelect: (key: string) => void
  /** parentId=null 建在根级，否则建在该分类下 */
  onCreate: (name: string, parentId: number | null) => void
  onRename: (id: number, name: string) => void
  onDelete: (id: number) => void
  /** 把视频拖到分类上时触发；folderId=null 表示拖回「未分类」 */
  onDropVideo: (videoId: number, folderId: number | null) => void
  onSelectVideo: (id: number) => void
  onAnalyze: (id: number, force: boolean) => void
  onMove: (videoId: number, folderId: number | null) => void
}

/**
 * 分类树：分类是父节点，视频和子分类都是它的子节点。
 *
 * 两个真实需求驱动的设计：
 *  1. 必须能**就地新建**——用户是看到一堆杂乱视频之后才意识到要分类的，
 *     让他先去别的地方建分类再回来拖，等于没做。分类本身可以嵌套，
 *     所以每个分类行上还挂了一个「在此建子分类」的入口。
 *  2. 必须支持**拖拽**——「把这条丢进那个分类」是肌肉记忆级的操作，
 *     下拉框只是给键盘用户的等价入口。
 */
export default function FolderList({
  folders,
  videos,
  active,
  selectedId,
  unfiledCount,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onDropVideo,
  onSelectVideo,
  onAnalyze,
  onMove,
}: Props) {
  const [draft, setDraft] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)
  /** 展开的分类 key 集合；默认展开「未分类」——它是所有新导入视频的落点，打开就有东西看 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['none']))
  /** undefined=没在新建；null=建在根级；number=建在该分类下 */
  const [newParentId, setNewParentId] = useState<number | null | undefined>(undefined)

  const folderPaths = useMemo(() => buildPaths(folders), [folders])

  const childrenOf = (parentId: number | null) =>
    folders.filter((f) => (f.parent_id ?? null) === parentId)

  /** key 只有两种取值：'none'=未分类，'<id>'=某个分类。没有「全部」这一档了 */
  const videosOf = (key: string): VideoSummary[] => {
    if (key === 'none') return videos.filter((v) => v.folder_id === null)
    return videos.filter((v) => v.folder_id === Number(key))
  }

  const beginRename = (f: Folder) => {
    setRenamingId(f.id)
    setRenameDraft(f.name)
  }

  const submitRename = (id: number) => {
    const name = renameDraft.trim()
    if (name) onRename(id, name)
    setRenamingId(null)
    setRenameDraft('')
  }

  const submitNew = (parentId: number | null) => {
    const name = draft.trim()
    if (!name) {
      setNewParentId(undefined)
      return
    }
    onCreate(name, parentId)
    setDraft('')
    // 建完保持父级展开，否则刚建的子分类看不见，像是没生效
    if (parentId !== null) {
      setExpanded((prev) => new Set(prev).add(String(parentId)))
    }
    setNewParentId(undefined)
  }

  /**
   * 当前分类由外部改变时（比如导入文件夹后自动切到新建的分类）同步展开，
   * 否则会出现「分类是选中的，下面却什么都没展开」的怪状态。
   * 点击展开走的是 toggle，这里只补外部驱动的那一次。
   */
  useEffect(() => {
    setExpanded((prev) => {
      if (prev.has(active)) return prev
      return new Set(prev).add(active)
    })
  }, [active])

  /** 展开/折叠，并把它设为当前分类 */
  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    onSelect(key)
  }

  const newInput = (parentId: number | null) => (
    <div className="flex gap-1 mb-0.5">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submitNew(parentId)
          if (e.key === 'Escape') {
            setNewParentId(undefined)
            setDraft('')
          }
        }}
        placeholder={parentId === null ? '根级分类名称，回车确认' : '子分类名称，回车确认'}
        maxLength={32}
        className="flex-1 min-w-0 text-[11px] border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:border-blue-400"
      />
      <button
        onClick={() => submitNew(parentId)}
        disabled={!draft.trim()}
        className="text-[10px] px-2 rounded bg-blue-600 text-white disabled:opacity-40"
      >
        建
      </button>
    </div>
  )

  /** 展开后的子节点区：靠缩进和左竖线表达「这些属于上面那个分类」 */
  const children = (key: string) => {
    if (!expanded.has(key)) return null
    const list = videosOf(key)
    return (
      <div className="ml-3 pl-1.5 mb-0.5 border-l border-gray-200">
        {list.length === 0 ? (
          <div className="text-[10px] text-gray-400 px-2 py-1.5">该分类下还没有视频</div>
        ) : (
          list.map((v) => (
            <VideoRow
              key={v.id}
              video={v}
              selected={selectedId === v.id}
              folders={folders}
              folderPaths={folderPaths}
              onSelect={onSelectVideo}
              onAnalyze={onAnalyze}
              onMove={onMove}
            />
          ))
        )}
      </div>
    )
  }

  const dropProps = (key: string, folderId: number | null) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragOver(key)
    },
    onDragLeave: () => setDragOver((cur) => (cur === key ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      const raw = e.dataTransfer.getData('text/plain')
      if (!raw) return
      const videoId = Number(raw)
      if (Number.isFinite(videoId)) onDropVideo(videoId, folderId)
      setDragOver(null)
    },
  })

  /** 递归渲染：缩进靠嵌套容器累积，不用手算层级深度 */
  const renderFolder = (f: Folder): React.ReactNode => {
    const key = String(f.id)
    const open = expanded.has(key)
    const kids = childrenOf(f.id)
    const list = videosOf(key)

    if (renamingId === f.id) {
      return (
        <div key={f.id} className="flex gap-1 mb-0.5">
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename(f.id)
              if (e.key === 'Escape') setRenamingId(null)
            }}
            maxLength={32}
            className="flex-1 min-w-0 text-[11px] border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:border-blue-400"
          />
          <button
            onClick={() => submitRename(f.id)}
            className="text-[10px] px-1.5 rounded border border-gray-300 hover:bg-gray-50"
          >
            ✓
          </button>
        </div>
      )
    }

    return (
      <div key={f.id}>
        <Row
          label={f.name}
          count={f.video_count}
          icon={open ? '📂' : '📁'}
          active={active === key}
          expanded={open}
          onClick={() => toggle(key)}
          onAddChild={() => {
            setNewParentId(f.id)
            setExpanded((prev) => new Set(prev).add(key))
          }}
          onRename={() => beginRename(f)}
          onDelete={() => {
            const extra = kids.length ? `它的 ${kids.length} 个子分类会提升一层，` : ''
            if (
              !confirm(
                `删除分类「${f.name}」？${extra}里面的视频会退回「未分类」，分析结果不受影响。`,
              )
            )
              return
            onDelete(f.id)
          }}
          dropHighlight={dragOver === `f${f.id}`}
          {...dropProps(`f${f.id}`, f.id)}
        />
        {open && (
          <div className="ml-3 pl-1.5 mb-0.5 border-l border-gray-200">
            {newParentId === f.id && newInput(f.id)}
            {list.map((v) => (
              <VideoRow
                key={v.id}
                video={v}
                selected={selectedId === v.id}
                folders={folders}
                folderPaths={folderPaths}
                onSelect={onSelectVideo}
                onAnalyze={onAnalyze}
                onMove={onMove}
              />
            ))}
            {kids.map((k) => renderFolder(k))}
            {list.length === 0 && kids.length === 0 && newParentId !== f.id && (
              <div className="text-[10px] text-gray-400 px-2 py-1.5">该分类下还没有视频</div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto thin-scroll px-2 py-2 border-b border-gray-100">
      <div className="flex items-center justify-between px-1 mb-1">
        <span className="text-[10px] text-gray-400">分类</span>
        <button
          onClick={() => setNewParentId((v) => (v === undefined ? null : undefined))}
          title="新建根级分类"
          className="text-[10px] text-gray-400 hover:text-blue-600"
        >
          {newParentId !== undefined ? '取消' : '＋ 新建'}
        </button>
      </div>

      {newParentId === null && newInput(null)}

      <Row
        label="未分类"
        count={unfiledCount}
        icon="📥"
        active={active === 'none'}
        expanded={expanded.has('none')}
        onClick={() => toggle('none')}
        dropHighlight={dragOver === 'none'}
        {...dropProps('none', null)}
      />
      {children('none')}

      {childrenOf(null).map((f) => renderFolder(f))}
    </div>
  )
}

/** 「课程/进阶」这样的完整路径：多级下同名分类靠它区分 */
function buildPaths(folders: Folder[]): Record<number, string> {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const walk = (f: Folder, depth = 0): string => {
    if (depth > 12) return f.name // 数据异常时兜底，不把界面卡死
    const parent = f.parent_id != null ? byId.get(f.parent_id) : undefined
    return parent ? `${walk(parent, depth + 1)}/${f.name}` : f.name
  }
  const out: Record<number, string> = {}
  for (const f of folders) out[f.id] = walk(f)
  return out
}

function Row({
  label,
  count,
  icon,
  active,
  expanded,
  dropHighlight,
  onClick,
  onAddChild,
  onRename,
  onDelete,
  ...rest
}: {
  label: string
  count: number
  icon: string
  active: boolean
  /** 是否展开：决定前面那个三角的朝向 */
  expanded: boolean
  dropHighlight?: boolean
  onClick: () => void
  onAddChild?: () => void
  onRename?: () => void
  onDelete?: () => void
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      onClick={onClick}
      title={label}
      className={[
        'group flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer text-[11px] transition',
        active ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50',
        dropHighlight ? 'ring-2 ring-blue-400 bg-blue-50' : '',
      ].join(' ')}
      {...rest}
    >
      <span className="shrink-0 w-2.5 text-[9px] text-gray-400">{expanded ? '▾' : '▸'}</span>
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      <span className="text-[10px] text-gray-400 tabular-nums shrink-0">{count}</span>
      {(onAddChild || onRename || onDelete) && (
        <span className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100">
          {onAddChild && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onAddChild()
              }}
              title="在此分类下新建子分类"
              className="text-[10px] text-gray-400 hover:text-blue-600 px-0.5"
            >
              ＋
            </button>
          )}
          {onRename && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onRename()
              }}
              title="重命名"
              className="text-[10px] text-gray-400 hover:text-blue-600 px-0.5"
            >
              ✎
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
              title="删除分类"
              className="text-[10px] text-gray-400 hover:text-red-600 px-0.5"
            >
              ✕
            </button>
          )}
        </span>
      )}
    </div>
  )
}
