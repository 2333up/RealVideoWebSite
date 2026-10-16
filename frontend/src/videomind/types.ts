// 与后端 Pydantic / SQLAlchemy 模型一一对应的前端类型。

export interface Segment {
  start: number
  end: number
  text: string
}

export interface Chapter {
  /** 章节主键：编辑 / 删除都要用它，之前只下发 idx 导致前端根本无法调用 */
  id: number
  idx: number
  title: string
  start: number
  end: number
  summary: string
  key_points: string[]
  /** 由哪个导图节点生成；不为 null 表示这条章节的时间由该节点驱动 */
  source_node_id: string | null
}

export interface MindMapNode {
  /** 节点稳定 id。手工编辑后章节靠它认人，缺失时后端会补 */
  id?: string
  label: string
  start: number | null
  /** 节点缩放系数（同时决定字体大小），1 为原始尺寸 */
  scale?: number | null
  /** 用户是否显式设置过时间戳。后端据此决定是否生成对应章节 */
  pinned?: boolean | null
  children?: MindMapNode[]
}

export interface Transcript {
  provider: string
  segments: Segment[]
}

export interface VideoSummary {
  id: number
  title: string
  filename: string
  duration: number
  size_bytes: number
  status: 'pending' | 'processing' | 'ready' | 'failed'
  error: string
  created_at: string | null
  /** 所属分类文件夹 id；null = 未分类 */
  folder_id: number | null
  chapter_count: number
  has_mindmap: boolean
  has_transcript: boolean
}

/** 应用内分类文件夹（与磁盘目录无关，只是给视频打组） */
export interface Folder {
  id: number
  name: string
  video_count: number
  created_at: string | null
}

/** 原生选择对话框的能力探测结果 */
export interface PickerInfo {
  available: boolean
  method: string | null
  exe: string | null
  reason: string
  last_dir: string
  extensions: string
}

export interface PickResult {
  paths: string[]
  cancelled: boolean
}

export interface ImportItem {
  id: number
  duplicate: boolean
  status: string
  duration?: number
}

export interface BatchImportResult {
  items: ImportItem[]
  created: number
  duplicates: number
  failed: { path: string; reason: string }[]
}

export interface FolderImportResult {
  folder: Folder | null
  created: number
  duplicates: number
  failed: { path: string; reason: string }[]
  imported_ids: number[]
  message: string | null
}

/** 保存导图后的回执：顺带告知这一改影响了几条章节，让「改动生效了」可见 */
export interface MindMapSaveResult {
  ok: boolean
  tree: MindMapNode
  chapters_created: number
  chapters_updated: number
  chapters_removed: number
  chapters: Chapter[]
}

export interface AssignResult {
  ok: boolean
  moved: number
  missing: number[]
  folder_id: number | null
}

export interface VideoDetail extends VideoSummary {
  transcript: Transcript | null
  chapters: Chapter[]
  mindmap: MindMapNode | null
  /** 该视频累计的模型用量；未分析过时为 null */
  token_usage: TokenUsage | null
}

/** 一组 token 汇总 */
export interface TokenTotals {
  calls: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  total_tokens: number
}

/** 视频维度的用量汇总（视频详情接口直接带出，省一次请求） */
export interface TokenUsage extends TokenTotals {
  by_purpose: { key: string; calls: number; total_tokens: number }[]
}

/** 全局用量查询结果 */
export interface UsageReport {
  totals: TokenTotals
  by_purpose: { key: string; calls: number; total_tokens: number }[]
  by_model: { key: string; calls: number; total_tokens: number }[]
  by_video: { video_id: number | null; title: string; calls: number; total_tokens: number }[]
  items: UsageItem[]
}

export interface UsageItem {
  id: number
  job_id: number | null
  video_id: number | null
  provider: string
  model: string
  purpose: string
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  total_tokens: number
  created_at: string | null
}

export interface Job {
  id: number
  video_id: number
  stage: string
  progress: number
  message: string
  error: string
  cancel_requested: boolean
}

export interface ProviderInfo {
  id: string
  name: string
  kind: string
  base_url: string
  default_model: string
  /** 候选模型列表，供设置页下拉建议；为空表示自由填写 */
  models: string[]
  env_key: string
  note: string
  requires_key: boolean
  key_configured: boolean
  key_masked: string
}

export interface SettingsData {
  current: {
    asr_provider: string
    whisper_model_size: string
    whisper_device: string
    whisper_compute_type: string
    cloud_asr_provider: string
    cloud_asr_model: string
    llm_provider: string
    llm_model: string
    llm_temperature: number
    llm_max_tokens: number
    llm_timeout_s: number
    chapter_target_chars: number
    chunk_overlap_chars: number
    language: string
    keyframe_enabled: boolean
    keyframes_per_chapter: number
  }
  llm_providers: ProviderInfo[]
  asr_providers: ProviderInfo[]
  resolved_whisper: { device: string; compute_type: string }
}
