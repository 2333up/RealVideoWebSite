import { useState } from 'react'
import { api } from '../api'

interface Props {
  /** 本机能不能弹原生对话框；不能时自动退回手工粘贴路径 */
  pickerAvailable: boolean
  pickerReason: string
  busy: boolean
  busyHint: string
  /** 单选文件/选文件夹：真正的弹框在这里发起，导入动作交给 App */
  onPickFiles: (paths: string[]) => void
  onPickFolder: (dir: string) => void
  onPastePath: (path: string) => void
}

/**
 * 导入区。
 *
 * 这里的两个按钮都由**后端**弹出操作系统原生选择窗口：
 * 浏览器永远不会把文件的真实绝对路径交给网页（<input type=file> 只给 File 对象，
 * File System Access API 也不暴露磁盘路径），而本项目「只登记路径、不复制文件」，
 * 必须拿到真实路径。所以流程是：前端请求 -> 后端起 Windows 对话框 -> 用户选择
 * -> 路径回传 -> 再发给导入接口。
 */
export default function ImportPanel({
  pickerAvailable,
  pickerReason,
  busy,
  busyHint,
  onPickFiles,
  onPickFolder,
  onPastePath,
}: Props) {
  const [showManual, setShowManual] = useState(false)
  const [raw, setRaw] = useState('')
  const [picking, setPicking] = useState<'file' | 'folder' | null>(null)

  const pickAndImport = async (mode: 'file' | 'folder') => {
    setPicking(mode)
    try {
      const r = await api.pick(mode)
      if (r.paths.length === 0) return // 用户取消，静默返回
      if (mode === 'file') onPickFiles(r.paths)
      else onPickFolder(r.paths[0])
    } catch (e) {
      // 弹框失败要给出可执行的下一步——自动展开手工输入才是真正的兜底
      alert(String((e as Error).message || e))
      setShowManual(true)
    } finally {
      setPicking(null)
    }
  }

  const disabled = busy || picking !== null

  return (
    <div className="p-3 border-b border-gray-100">
      {pickerAvailable ? (
        <>
          <button
            onClick={() => pickAndImport('file')}
            disabled={disabled}
            className="w-full px-3 py-2 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-500 disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            <span>📁</span>
            {picking === 'file' ? '等待选择…' : '选择视频文件导入'}
          </button>
          <button
            onClick={() => pickAndImport('folder')}
            disabled={disabled}
            className="mt-1.5 w-full px-3 py-1.5 rounded border border-gray-300 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            <span>📂</span>
            {picking === 'folder' ? '等待选择…' : '选择文件夹批量导入'}
          </button>
          <p className="text-[10px] text-gray-400 mt-1.5 leading-relaxed">
            弹窗由本机系统提供，可多选；文件夹会顺带按目录名建一个同名分类。
            只登记路径不复制文件，不额外占用磁盘。
          </p>
        </>
      ) : (
        <>
          <div className="text-[10px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5 leading-relaxed">
            本机无法弹出选择窗口（{pickerReason}），请用下面的手工方式导入。
          </div>
          {!showManual && (
            <button
              onClick={() => setShowManual(true)}
              className="mt-1.5 w-full px-3 py-1.5 rounded border border-gray-300 text-xs hover:bg-gray-50"
            >
              手工粘贴路径
            </button>
          )}
        </>
      )}

      {showManual && (
        <div className="mt-1.5">
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (raw.trim()) onPastePath(raw.trim())
                setRaw('')
              }
            }}
            placeholder="粘贴视频完整路径，如 J:\Videos\lecture.mp4"
            rows={2}
            className="w-full text-[11px] border border-gray-300 rounded px-2 py-1 font-mono resize-none focus:outline-none focus:border-blue-400"
          />
          <button
            onClick={() => {
              if (!raw.trim()) return
              onPastePath(raw.trim())
              setRaw('')
            }}
            disabled={!raw.trim() || busy}
            className="mt-1 w-full px-3 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-500 disabled:opacity-40"
          >
            {busy ? '导入中…' : '导入'}
          </button>
          <p className="text-[10px] text-gray-400 mt-1">
            在资源管理器里按住 Shift 右键文件 →「复制文件地址」。
          </p>
        </div>
      )}

      {busyHint && (
        <p className="text-[10px] text-blue-600 mt-1">{busyHint}</p>
      )}
    </div>
  )
}
