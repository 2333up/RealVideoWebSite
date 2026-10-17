import { Route, Routes } from 'react-router-dom'
import LingoSeekApp from './LingoSeekApp'
import VideoMindApp from './videomind/VideoMindApp'

/**
 * 单一前端应用的统一路由入口。
 *
 * 两个应用曾经各自是一个独立的 Vite 工程（5173 / 5273），用户要记两个地址、
 * 跨应用跳转靠 window.open。融合后只剩一个工程、一个入口：
 *   - /              → 灵搜 LingoSeek（跨平台视频搜索）
 *   - /videomind/*   → Video-Mind（本地视频章节与思维导图）
 *
 * 约定：
 *   - /videomind/* 用通配符，子应用内部以后若加自己的子路由不会被这里截断；
 *   - path="*" 兜底放在最后，保证未知路径也落到搜索页而不是白屏；
 *   - 后端把 video-mind 挂在 /videomind 子路径下，两边 API 都经同一个
 *     5173 → 8000 代理，所以前端这里只需要管页面分发，不管请求前缀
 *     （请求前缀由各自 api 模块里的 BASE 常量负责）。
 */
export default function App() {
  return (
    <Routes>
      <Route path="/videomind/*" element={<VideoMindApp />} />
      <Route path="*" element={<LingoSeekApp />} />
    </Routes>
  )
}
