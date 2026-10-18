import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CloseIcon, MemoIcon, MIN_TAPPABLE } from './icons'

/**
 * 节点笔记（Markdown）。
 *
 * 与「笔记节点」是两件事，别混：
 *   - 笔记节点（`kind: 'note'`）是一种**节点类型**：不挂时间轴、不参与父节点派生；
 *   - 这里说的笔记是**挂在任意节点上的一段 Markdown**：读书笔记、待办、链接……
 *     节点上靠一个小图标标记，正文显示在右侧导图区下方的这块面板里。
 *
 * 渲染用 react-markdown + remark-gfm（GFM 表格/任务列表/删除线都是常用语法），
 * 自己不再造一套解析。编辑态就是一个纯文本 textarea——用户要的是「能直接写
 * Markdown 源码」，所见即所得反而会挡住这件事。
 *
 * 保存策略（刻意不设「取消」按钮）：
 *   - 停止输入 1.2 秒自动存；
 *   - textarea 失焦立刻存（点别的节点、点收起都会先失焦）；
 *   - Ctrl/⌘ + Enter 立刻存。
 * 三条都走同一个 `flush()`，靠「和已保存内容相同就不发请求」去重。
 */
export interface NodeNoteProps {
  /** 当前展示哪个节点的笔记 */
  nodeId: string
  /** 节点标题，显示在面板表头，避免「这块笔记是谁的」搞不清 */
  label: string
  /** 已保存的 Markdown 原文 */
  note: string
  /** 浏览模式下只能读，不能改（与导图的「只读 / 编辑中」保持一致） */
  editable: boolean
  onSave: (nodeId: string, text: string) => Promise<void>
  onClose: () => void
}

type Mode = 'read' | 'edit'
type Status = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

const AUTOSAVE_MS = 1200

export default function NodeNote({
  nodeId,
  label,
  note,
  editable,
  onSave,
  onClose,
}: NodeNoteProps) {
  // 没写过笔记的节点直接进编辑态——打开面板就是为了写点什么
  const [mode, setMode] = useState<Mode>(note.trim() ? 'read' : 'edit')
  const [draft, setDraft] = useState(note)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const timer = useRef<number | undefined>(undefined)
  /** 最近一次成功保存的内容。用它判断「要不要发请求」 */
  const savedRef = useRef(note)

  // 切节点：重置草稿与模式。上一次的未保存内容由失焦时的 flush 负责落库
  useEffect(() => {
    savedRef.current = note
    setDraft(note)
    setMode(note.trim() ? 'read' : 'edit')
    setStatus('idle')
    setError('')
  }, [nodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 保存回执回来（父级刷新了 note）：同步基准值，别把用户正在打的内容冲掉
  useEffect(() => {
    savedRef.current = note
    setDraft((d) => (d.trim() === '' ? note : d))
  }, [note])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const flush = (text: string, id = nodeId) => {
    window.clearTimeout(timer.current)
    if (!editable) return
    if (text.trim() === savedRef.current.trim()) {
      setStatus('idle')
      return
    }
    setStatus('saving')
    onSave(id, text)
      .then(() => {
        savedRef.current = text
        setStatus('saved')
        setError('')
      })
      .catch((e: unknown) => {
        setStatus('error')
        setError(e instanceof Error ? e.message : '保存失败')
      })
  }

  const change = (text: string) => {
    setDraft(text)
    if (!editable) return
    setStatus('dirty')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => flush(text), AUTOSAVE_MS)
  }

  const switchMode = (next: Mode) => {
    if (next === mode) return
    if (next === 'read' && editable) flush(draft)
    setMode(next)
  }

  const statusText =
    status === 'saving'
      ? '保存中…'
      : status === 'saved'
        ? '已保存'
        : status === 'dirty'
          ? '未保存'
          : status === 'error'
            ? error || '保存失败'
            : ''

  return (
    <div
      className="shrink-0 flex flex-col border-t border-gray-200 bg-white"
      data-role="node-note"
      style={{ height: '38%', minHeight: 140 }}
    >
      {/* 表头：这是哪个节点的笔记 + 阅读/编辑切换 */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-gray-100 bg-gray-50/70">
        <MemoIcon size={13} className="text-amber-600" />
        <span className="text-[11px] text-gray-500 shrink-0">笔记</span>
        <span className="text-[11px] font-medium text-gray-800 truncate min-w-[40px]">
          {label}
        </span>
        {statusText && (
          <span
            className={`text-[10px] shrink-0 ${
              status === 'error' ? 'text-red-600' : 'text-gray-400'
            }`}
          >
            {statusText}
          </span>
        )}
        <span className="flex-1" />

        <div className="flex rounded border border-gray-200 overflow-hidden shrink-0">
          {(
            [
              ['read', '阅读'],
              ['edit', '编辑'],
            ] as const
          ).map(([key, text]) => (
            <button
              key={key}
              onClick={() => switchMode(key)}
              disabled={key === 'edit' && !editable}
              title={
                key === 'edit' && !editable
                  ? '只读模式：点左上角「只读」切到编辑模式后才能改笔记'
                  : key === 'read'
                    ? '看渲染后的效果'
                    : '编辑 Markdown 源码'
              }
              data-role={key === 'edit' ? 'note-edit-mode' : 'note-read-mode'}
              className={[
                'px-2 text-[11px] transition',
                mode === key
                  ? 'bg-slate-800 text-white'
                  : key === 'edit' && !editable
                    ? 'bg-white text-gray-300 cursor-not-allowed'
                    : 'bg-white text-gray-500 hover:text-gray-900 hover:bg-gray-50',
                MIN_TAPPABLE,
              ].join(' ')}
            >
              {text}
            </button>
          ))}
        </div>

        <button
          onClick={onClose}
          title="收起笔记面板"
          aria-label="收起笔记面板"
          data-role="note-close"
          className={`shrink-0 inline-flex items-center justify-center h-6 w-6 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 ${MIN_TAPPABLE}`}
        >
          <CloseIcon size={13} />
        </button>
      </div>

      {/* 正文 */}
      {mode === 'edit' ? (
        <textarea
          value={draft}
          onChange={(e) => change(e.target.value)}
          onBlur={() => flush(draft)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              flush(draft)
            }
            // Tab 缩进：Markdown 里嵌套列表全靠它，默认行为会把焦点带走
            if (e.key === 'Tab') {
              e.preventDefault()
              const el = e.currentTarget
              const s = el.selectionStart
              const t = el.value
              const next = `${t.slice(0, s)}  ${t.slice(el.selectionEnd)}`
              change(next)
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = s + 2
              })
            }
          }}
          placeholder="支持 Markdown：# 标题、- 列表、**粗体**、`代码`、| 表格 |"
          aria-label="节点笔记 Markdown 源码"
          data-role="note-textarea"
          className="flex-1 min-h-0 w-full resize-none px-2.5 py-2 text-[12px] leading-relaxed font-mono text-gray-800 outline-none thin-scroll"
          spellCheck={false}
        />
      ) : (
        <div
          className="flex-1 min-h-0 overflow-y-auto thin-scroll px-2.5 py-2"
          data-role="note-rendered"
        >
          {note.trim() ? (
            <div className="vm-md">
              <Markdown remarkPlugins={[remarkGfm]}>{note}</Markdown>
            </div>
          ) : (
            <div className="text-[11px] text-gray-400">
              {editable ? '这个节点还没有笔记，点「编辑」开始写。' : '这个节点还没有笔记。'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
