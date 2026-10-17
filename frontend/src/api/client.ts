/// <reference types="vite/client" />

/**
 * 后端 API 客户端。
 *
 * 统一封装错误：任何非 2xx / 网络异常都会转换成带中文提示的 Error，
 * 页面只需 try-catch 后把 message 交给 UI 展示。
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

export type ContentKind = 'video' | 'article'
export type SearchOrder = 'relevance' | 'hot' | 'new'

export interface Author {
  uid: string
  name: string
  avatar_url: string
  homepage: string
}

export interface ContentCard {
  platform: string
  kind: ContentKind
  uid: string
  title: string
  summary: string
  cover_url: string
  page_url: string
  author: Author
  published_at: number | null
  duration: number | null
  view_count: number
  like_count: number
  comment_count: number
  favorite_count: number
  coin_count: number
  share_count: number
  danmaku_count: number
  tags: string[]
  score: number
  score_detail: Record<string, number>
  extra: Record<string, unknown>
}

export interface SearchResponse {
  keyword: string
  items: ContentCard[]
  total_recalled: number
  deduped: number
  platforms: string[]
  elapsed_ms: number
  credential_used: boolean
  warnings: string[]
  score_weights: Record<string, number>
}

export interface SearchPayload {
  keyword: string
  platforms: string[]
  page: number
  page_size: number
  // 本次要抓取的平台页数，配合 page 实现「加载更多」
  pages?: number
  kinds: ContentKind[]
  order: SearchOrder
  duration_min?: number | null
  duration_max?: number | null
  account_id?: number | null
}

export interface PlatformMeta {
  key: string
  display_name: string
  accent_color: string
  homepage: string
  supported_kinds: ContentKind[]
  supports_login: boolean
  // 支持手动粘贴 Cookie 接入（如抖音无可行扫码流程）
  manual_credential?: boolean
}

export interface AccountBrief {
  id: number
  platform: string
  platform_uid: string
  nickname: string
  avatar_url: string
  is_default: boolean
  is_active: boolean
  last_verified_at: string | null
  last_error: string
  health?: 'valid' | 'expired' | 'invalid' | 'error'
}

export interface LoginStartData {
  token: string
  qrcode_image: string
  qrcode_url: string
  expires_in: number
}

export interface LoginPollData {
  status: 'pending' | 'scanned' | 'success' | 'expired' | 'error'
  message: string
  account: AccountBrief | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    throw new Error('无法连接后端服务，请确认后端已启动（http://127.0.0.1:8000）')
  }

  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`
    try {
      const body = await response.json()
      const detail = body?.detail
      message = typeof detail === 'string' ? detail : (detail?.[0]?.msg ?? detail ?? message)
    } catch {
      /* 响应体非 JSON，保留默认提示 */
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

export const api = {
  health: () => request<{ status: string; platforms: string[] }>('/health'),

  platforms: () => request<{ platforms: PlatformMeta[] }>('/platforms'),

  search: (payload: SearchPayload) =>
    request<SearchResponse>('/search', { method: 'POST', body: JSON.stringify(payload) }),

  /** 获取单条内容详情（用于详情浮层自渲染，避免嵌入平台网页夹带推荐） */
  fetchDetail: (platformKey: string, uid: string) =>
    request<{ platform: string; item: ContentCard }>(
      `/platforms/${platformKey}/detail?uid=${encodeURIComponent(uid)}`,
    ),

  /** 获取评论（可选能力，平台未实现时返回 404） */
  fetchComments: (
    platformKey: string,
    uid: string,
    page = 1,
    pageSize = 20,
    sort: 'hot' | 'time' = 'hot',
  ) =>
    request<CommentPage>(
      `/platforms/${platformKey}/comments?uid=${encodeURIComponent(uid)}` +
        `&page=${page}&page_size=${pageSize}&sort=${sort}`,
    ),

  /** 获取 B 站视频播放直链信息（分 P + 清晰度），供下载 */
  fetchPlayurl: (bvid: string, cid?: number) =>
    request<PlayurlInfo>(
      `/platforms/bilibili/playurl?bvid=${encodeURIComponent(bvid)}` +
        (cid ? `&cid=${cid}` : ''),
    ),

  /** 获取 YouTube 视频可下载流列表（清晰度 / 是否含音轨） */
  fetchYoutubeStreams: (videoId: string) =>
    request<YoutubeStreamsInfo>(
      `/platforms/youtube/streams?video_id=${encodeURIComponent(videoId)}`,
    ),

  /**
   * YouTube 下载直链（走后端代理：直链绑定 IP 与时效，且浏览器通常连不上 YouTube）。
   * format_id 传 'merge' 表示最佳视频+最佳音频用 ffmpeg 合并。
   */
  youtubeDownloadUrl: (videoId: string, formatId: string) =>
    `/api/platforms/youtube/download?video_id=${encodeURIComponent(videoId)}` +
    `&format_id=${encodeURIComponent(formatId)}`,

  listAccounts: (platform?: string) =>
    request<{ accounts: AccountBrief[] }>(`/accounts${platform ? `?platform=${platform}` : ''}`),

  loginStart: (platformKey: string) =>
    request<LoginStartData>(`/platforms/${platformKey}/login/start`, { method: 'POST' }),

  loginPoll: (platformKey: string, token: string) =>
    request<LoginPollData>(`/platforms/${platformKey}/login/poll?token=${encodeURIComponent(token)}`),

  deleteAccount: (id: number) =>
    request<{ message: string }>(`/accounts/${id}`, { method: 'DELETE' }),

  setDefaultAccount: (id: number) =>
    request<{ message: string }>(`/accounts/${id}/default`, { method: 'POST' }),

  /** 手动粘贴 Cookie 注入账号（抖音等无扫码流程的平台） */
  addManualCredential: (platformKey: string, cookieStr: string, nickname = '') =>
    request<{ message: string; account: AccountBrief | null }>(
      `/platforms/${platformKey}/credentials`,
      { method: 'POST', body: JSON.stringify({ cookie_str: cookieStr, nickname }) },
    ),

  verifyAccounts: (platform?: string) =>
    request<{ accounts: AccountBrief[] }>(
      `/accounts/verify${platform ? `?platform=${platform}` : ''}`,
      { method: 'POST' },
    ),
}

// ------------------------------------------------------------------ 展示工具

export interface CommentItem {
  id: string
  author: string
  avatar: string
  content: string
  like: number
  reply_count: number
  created_at: number
  /** 楼中楼（子回复） */
  replies: CommentItem[]
}

export interface CommentPage {
  platform: string
  items: CommentItem[]
  total: number
  has_more: boolean
  page: number
}

export interface PlayurlPage {
  cid: number
  page: number
  part: string
  duration: number
}

export interface PlayurlFormat {
  quality: number
  desc: string
}

export interface PlayurlInfo {
  bvid: string
  aid: string
  title: string
  pages: PlayurlPage[]
  current_cid: number
  quality: number
  quality_desc: string
  formats: PlayurlFormat[]
  durl: { url: string; size: number; length: number }[]
}

// ---------------------------------------------------------------- YouTube

export interface YoutubeStream {
  format_id: string
  ext: string
  resolution: string
  note: string
  /** 该流是否含画面 */
  has_video: boolean
  /** 该流是否含音轨 —— YouTube 的 DASH 流音视频是分开的 */
  has_audio: boolean
  filesize: number
  abr: number
}

export interface YoutubeStreamsInfo {
  title: string
  duration: number
  thumbnail: string
  /** 后端能否找到 ffmpeg；决定「音视频合并」选项是否可用 */
  ffmpeg_available: boolean
  streams: YoutubeStream[]
}

/** 播放量之类的数字压缩为「1.2万」 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`
  if (value >= 10_000) {
    const w = value / 10_000
    return `${w >= 100 ? Math.round(w) : w.toFixed(1)}万`
  }
  return String(value)
}

/** 秒 -> "12:34" / "1:02:03" */
export function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** Unix 秒 -> "3天前" / "2026-04-12" */
export function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return ''
  const diff = Date.now() / 1000 - timestamp
  if (diff < 0) return '刚刚'
  const MINUTE = 60
  const HOUR = 3600
  const DAY = 86400
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时前`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}天前`
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}个月前`
  const d = new Date(timestamp * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** B 站图片 CDN 要求带 Referer 策略，统一走 referrerpolicy 处理 */
export const IMG_PROPS = {
  referrerPolicy: 'no-referrer' as const,
  loading: 'lazy' as const,
}
