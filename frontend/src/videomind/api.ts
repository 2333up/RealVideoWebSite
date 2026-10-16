import type {
  AssignResult,
  BatchImportResult,
  Chapter,
  Folder,
  MindMapSaveResult,
  FolderImportResult,
  ImportItem,
  Job,
  PickResult,
  PickerInfo,
  ProviderInfo,
  SettingsData,
  UsageReport,
  VideoDetail,
  VideoSummary,
} from './types'

// 融合为单一前端应用后，video-mind 与 lingoSeek 同源同端口（同一个 5173），
// 由 vite 代理把 /videomind/api 原样转发到 8000 后端的子应用挂载点。
// 必须带 /videomind 前缀：去掉后会打到 lingoSeek 自己的 /api 上，表现为
// 「页面能打开但所有接口 404」。部署到其他前缀时可用环境变量覆盖。
const BASE = import.meta.env.VITE_VIDEOMIND_API_BASE ?? '/videomind/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!resp.ok) {
    // 后端在 4xx 上会给出可直接展示的中文原因，优先透传
    const text = await resp.text()
    let msg = text
    try {
      const data = JSON.parse(text)
      msg = data.detail ?? text
    } catch {
      /* 非 JSON 就用原文 */
    }
    throw new Error(msg)
  }
  return resp.json() as Promise<T>
}

export const api = {
  /** folder: '' 全部 | 'none' 未分类 | '<id>' 某个分类 */
  listVideos: (folder?: string) =>
    request<{ items: VideoSummary[] }>(`/videos${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`),
  getVideo: (id: number) => request<VideoDetail>(`/videos/${id}`),
  deleteVideo: (id: number) => request<{ ok: boolean }>(`/videos/${id}`, { method: 'DELETE' }),
  importVideo: (path: string, folderId?: number | null) =>
    request<ImportItem>('/videos/import', {
      method: 'POST',
      body: JSON.stringify({ path, folder_id: folderId ?? null }),
    }),
  importMany: (paths: string[], folderId?: number | null) =>
    request<BatchImportResult>('/videos/import-many', {
      method: 'POST',
      body: JSON.stringify({ paths, folder_id: folderId ?? null }),
    }),
  /** 把一个磁盘目录下的视频批量导入，并可自动建立同名分类 */
  importFolder: (path: string, opts?: { recursive?: boolean; create_folder?: boolean; max_files?: number }) =>
    request<FolderImportResult>('/videos/import-folder', {
      method: 'POST',
      body: JSON.stringify({
        path,
        recursive: opts?.recursive ?? true,
        create_folder: opts?.create_folder ?? true,
        max_files: opts?.max_files ?? 200,
      }),
    }),

  // ---------------------------------------------------------------- 分类文件夹
  listFolders: () => request<{ items: Folder[] }>('/folders'),
  createFolder: (name: string) =>
    request<Folder>('/folders', { method: 'POST', body: JSON.stringify({ name }) }),
  renameFolder: (id: number, name: string) =>
    request<Folder>(`/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteFolder: (id: number) =>
    request<{ ok: boolean; name: string; unfiled: number }>(`/folders/${id}`, { method: 'DELETE' }),
  /** 批量移动视频；folderId=null 表示移回未分类 */
  assignVideos: (videoIds: number[], folderId: number | null) =>
    request<AssignResult>('/folders/assign', {
      method: 'POST',
      body: JSON.stringify({ video_ids: videoIds, folder_id: folderId }),
    }),

  // ---------------------------------------------------------------- 原生选择对话框
  pickerInfo: () => request<PickerInfo>('/files/picker'),
  /** 弹出系统原生选择窗口，直到用户确认或取消才返回 */
  pick: (mode: 'file' | 'folder', startDir?: string) =>
    request<PickResult>('/files/pick', {
      method: 'POST',
      body: JSON.stringify({ mode, start_dir: startDir ?? '', timeout: 300 }),
    }),
  startJob: (videoId: number, force = false) =>
    request<{ job_id: number; video_id: number }>('/jobs', {
      method: 'POST',
      body: JSON.stringify({ video_id: videoId, force }),
    }),
  getJob: (id: number) => request<Job>(`/jobs/${id}`),
  cancelJob: (id: number) => request<{ ok: boolean }>(`/jobs/${id}/cancel`, { method: 'POST' }),
  getSettings: () => request<SettingsData>('/settings'),
  patchSettings: (patch: Partial<SettingsData['current']>) =>
    request<{ ok: boolean }>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  setKey: (envKey: string, value: string, baseUrl?: string) =>
    request<{ ok: boolean; masked: string }>('/settings/keys', {
      method: 'POST',
      body: JSON.stringify({ env_key: envKey, value, base_url: baseUrl }),
    }),
  testConnection: (kind: string, providerId: string, model?: string) =>
    request<{ ok: boolean; message: string }>('/settings/test', {
      method: 'POST',
      body: JSON.stringify({ kind, provider_id: providerId, model }),
    }),
  health: () => request<{ ok: boolean; ffmpeg: boolean; ffprobe: boolean }>('/health'),
  getUsage: (videoId?: number) =>
    request<UsageReport>(`/usage${videoId ? `?video_id=${videoId}` : ''}`),
  clearUsage: (videoId?: number) =>
    request<{ deleted: number }>(`/usage${videoId ? `?video_id=${videoId}` : ''}`, {
      method: 'DELETE',
    }),

  // ---------------------------------------------------------------- 章节编辑
  addChapter: (
    videoId: number,
    body: { title: string; start: number; end?: number; summary?: string; key_points?: string[] },
  ) => request<Chapter>(`/videos/${videoId}/chapters`, { method: 'POST', body: JSON.stringify(body) }),
  patchChapter: (videoId: number, chapterId: number, patch: Partial<Chapter>) =>
    request<{ ok: boolean; chapter: Chapter }>(`/videos/${videoId}/chapters/${chapterId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** 删除章节。若它来自导图节点，后端会一并清掉该节点的时间戳 */
  deleteChapter: (videoId: number, chapterId: number) =>
    request<{ ok: boolean; cleared_node_start: boolean }>(
      `/videos/${videoId}/chapters/${chapterId}`,
      { method: 'DELETE' },
    ),

  // ---------------------------------------------------------------- 思维导图编辑
  /** 保存编辑后的导图；默认按节点时间戳同步生成/更新章节 */
  patchMindmap: (videoId: number, tree: unknown, createChapters = true) =>
    request<MindMapSaveResult>(`/videos/${videoId}/mindmap`, {
      method: 'PATCH',
      body: JSON.stringify({ tree, create_chapters: createChapters }),
    }),

  // 视频流地址。后端实现了 Range 请求，<video> 才能拖动进度条。
  streamUrl: (id: number) => `${BASE}/videos/${id}/stream`,
}

export type { ProviderInfo }
