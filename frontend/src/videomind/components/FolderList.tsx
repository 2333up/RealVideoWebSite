import { useEffect, useState } from 'react'
import type { Folder, VideoSummary } from '../types'
import VideoRow from './VideoRow'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CheckIcon,
  CloseIcon,
  FolderIcon,
  FolderOpenIcon,
  IconButton,
  InboxIcon,
  MIN_TAPPABLE,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from './icons'

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
  /** 左栏被拉宽时行也跟着放开，否则中间会撑出一大片空白（见 VideoRow 的说明） */
  wide?: boolean
}

/**
 * 分类树：分类是父节点，视频和子分类都是它的子节点。
 *
 * 两个真实需求驱动的设计：
 *  1. 必须能**就地新建**——用户是看到一堆杂乱视频之后才意识到要分类的，
 *     让他先去别的地方建分类再回来拖，等于没做。分类本身可以嵌套，
 *     所以每个分类行上还挂了一个「在此建子分类」的入口。
 *  2. 必须支持**拖拽**——「把这条丢进那个分类」是肌肉记忆级的操作。
 *     视频行上原来还挂了个「移动到分类」下拉框当键盘入口，
 *     2026-10-18 为了把每条视频压成一行删掉了（拖拽是主路径，
 *     下拉让每条视频白付一行高度）。要移动，拖就行。
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
  wide = false,
}: Props) {
  const [draft, setDraft] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)
  /** 展开的分类 key 集合；默认展开「未分类」——它是所有新导入视频的落点，打开就有东西看 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['none']))
  /** undefined=没在新建；null=建在根级；number=建在该分类下 */
  const [newParentId, setNewParentId] = useState<number | null | undefined>(undefined)

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
        className={`text-[10px] px-2 rounded bg-blue-600 text-white disabled:opacity-40 ${MIN_TAPPABLE}`}
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
              onSelect={onSelectVideo}
              onAnalyze={onAnalyze}
              wide={wide}
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
          {/* 确认按钮也曾是个 20px 的「✓」字符；换成 24×24 的图标按钮后
              和左边的输入框一样高，不会显得短一截 */}
          <IconButton
            icon={<CheckIcon size={15} />}
            label="确认重命名"
            onClick={() => submitRename(f.id)}
            className="border border-gray-300 hover:bg-gray-50 hover:text-gray-900"
          />
        </div>
      )
    }

    return (
      <div key={f.id}>
        <Row
          wide={wide}
          label={f.name}
          count={f.video_count}
          icon={open ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />}
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
                onSelect={onSelectVideo}
                onAnalyze={onAnalyze}
                wide={wide}
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
        {/* 「＋ 新建」原来是纯文字，10px 字高 15px、没有内边距，
            点中的面积只有一行字的宽度 × 15px。现在图标 + 文字共用一个
            24px 高的按钮，点哪都算。 */}
        <button
          onClick={() => setNewParentId((v) => (v === undefined ? null : undefined))}
          title={newParentId !== undefined ? '取消新建' : '新建根级分类'}
          className={`gap-1 px-1.5 rounded text-[11px] text-gray-400 hover:text-blue-600 hover:bg-blue-50 ${MIN_TAPPABLE}`}
        >
          {newParentId !== undefined ? (
            <>
              <CloseIcon size={13} />
              取消
            </>
          ) : (
            <>
              <PlusIcon size={13} />
              新建
            </>
          )}
        </button>
      </div>

      {newParentId === null && newInput(null)}

      <Row
        wide={wide}
        label="未分类"
        count={unfiledCount}
        icon={<InboxIcon size={14} />}
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

function Row({
  label,
  count,
  icon,
  active,
  expanded,
  wide = false,
  dropHighlight,
  onClick,
  onAddChild,
  onRename,
  onDelete,
  ...rest
}: {
  label: string
  count: number
  icon: React.ReactNode
  active: boolean
  /** 是否展开：决定前面那个三角的朝向 */
  expanded: boolean
  dropHighlight?: boolean
  /** 宽面板下把行放开一点（更高的行、稍大的字），窄面板保持密集 */
  wide?: boolean
  onClick: () => void
  onAddChild?: () => void
  onRename?: () => void
  onDelete?: () => void
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      onClick={onClick}
      title={label}
      // data-* 给冒烟脚本用：折叠态以前靠行里有没有「▸」字符判断，
      // 三角换成 SVG 之后文本里就没这个字了，改用显式状态属性
      data-folder-row="1"
      data-expanded={expanded ? 'true' : 'false'}
      className={[
        'group flex items-center gap-1 px-2 rounded cursor-pointer transition',
        wide ? 'py-1 text-[12px]' : 'py-0.5 text-[11px]',
        active ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50',
        dropHighlight ? 'ring-2 ring-blue-400 bg-blue-50' : '',
      ].join(' ')}
      {...rest}
    >
      {/* 三角是装饰：整行本身就是展开/折叠的热区，它只负责指示方向。
          固定 14px 宽、垂直居中，保证所有行的文字左边缘对齐成一条线。 */}
      <span className="shrink-0 flex items-center justify-center text-gray-400" style={{ width: 14 }}>
        {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
      </span>
      <span className="shrink-0 flex items-center">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      <span className="text-[10px] text-gray-400 tabular-nums shrink-0">{count}</span>
      {(onAddChild || onRename || onDelete) && (
        <span className="flex items-center shrink-0 opacity-0 group-hover:opacity-100">
          {onAddChild && (
            <IconButton
              icon={<PlusIcon size={14} />}
              label="在此分类下新建子分类"
              onClick={(e) => {
                e.stopPropagation()
                onAddChild()
              }}
              className="hover:text-blue-600 hover:bg-blue-50"
            />
          )}
          {onRename && (
            <IconButton
              icon={<PencilIcon size={14} />}
              label="重命名"
              onClick={(e) => {
                e.stopPropagation()
                onRename()
              }}
              className="hover:text-blue-600 hover:bg-blue-50"
            />
          )}
          {onDelete && (
            <IconButton
              icon={<TrashIcon size={14} />}
              label="删除分类"
              tone="danger"
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            />
          )}
        </span>
      )}
    </div>
  )
}
