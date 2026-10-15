import { useEffect, useRef, useState } from 'react'

interface Props {
  keyword: string
  /** 点击笔记时回调（noteId 来自 iframe 内 postMessage），由父组件弹详情浮层 */
  onOpenNote: (noteId: string, cover: string) => void
}

/**
 * 小红书「整页嵌入」结果区。
 *
 * 方案 A：切换到小红书平台时，不走我们自己的卡片 + 详情浮层，
 * 而是把小红书官方搜索页通过服务端代理（同源）嵌进 iframe，
 * 让用户直接看平台原生搜索结果。
 * 点击笔记时，iframe 内通过 postMessage 通知本组件，再由父组件
 * 弹出站内详情浮层（复用 fetch_detail，图文可完整看图）。
 */
export default function XhsEmbedResult({ keyword, onOpenNote }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const embedSrc = `/api/platforms/xiaohongshu/embed?keyword=${encodeURIComponent(keyword)}`

  // keyword 变化时重新加载并重置 loading
  useEffect(() => {
    setLoading(true)
    setError('')
  }, [keyword])

  // 监听 iframe 内点击笔记发出的 postMessage
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data
      if (data && data.type === 'lingoseek-xhs-open' && data.noteId) {
        onOpenNote(data.noteId, data.cover || '')
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onOpenNote])

  return (
    <div className="flex h-[calc(100vh-170px)] min-h-[480px] flex-col overflow-hidden rounded-xl border border-ink-100 bg-white">
      {/* 顶部提示条 */}
      <div className="flex items-center justify-between gap-3 border-b border-ink-100 bg-slate-50 px-3 py-1.5">
        <p className="truncate text-[11px] leading-relaxed text-ink-500">
          已嵌入小红书官方搜索结果（含登录态），点击笔记在站内查看详情，已隐藏顶部导航与推荐干扰区。
        </p>
        <a
          href={`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 text-[11px] text-bilibili hover:underline"
        >
          在新窗口打开 ↗
        </a>
      </div>

      {/* iframe 区 */}
      <div className="relative flex-1">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 text-sm text-ink-500">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-ink-700" />
              正在载入小红书搜索结果…
            </div>
          </div>
        ) : null}

        <iframe
          ref={iframeRef}
          src={embedSrc}
          title={`小红书搜索：${keyword}`}
          className="h-full w-full"
          frameBorder="0"
          // 关键：iframe 内图片走小红书 CDN 有防盗链（Referer 校验），
          // 默认 Referer 是 127.0.0.1 会被拒（naturalWidth=0）。
          // no-referrer 让图片请求不带 Referer，实测绕过防盗链返回 200。
          referrerPolicy="no-referrer"
          onLoad={() => setLoading(false)}
          onError={() => {
            setLoading(false)
            setError('小红书搜索页加载失败，请稍后重试或点击右上角在新窗口打开')
          }}
          // 不含 allow-top-navigation：阻止站方脚本破框跳转
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
        />
      </div>

      {error ? (
        <p className="bg-amber-50 px-3 py-2 text-[11px] text-amber-700">{error}</p>
      ) : null}
    </div>
  )
}

