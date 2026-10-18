import { Route, Routes } from 'react-router-dom'
import LingoSeekApp from './LingoSeekApp'
import VideoMindApp from './videomind/VideoMindApp'
import AnimeApp from './anime/AnimeApp'
import ErrorBoundary from './components/ErrorBoundary'
import WebPet from './components/webPet/WebPet'

/**
 * 单一前端应用的统一路由入口。
 *
 * 两个应用曾经各自是一个独立的 Vite 工程（5173 / 5273），用户要记两个地址、
 * 跨应用跳转靠 window.open。融合后只剩一个工程、一个入口：
 *   - /              → 灵搜 LingoSeek（跨平台视频搜索）
 *   - /videomind/*   → Video-Mind（本地视频章节与思维导图）
 *   - /anime         → 追番（agedm 数据源，管理列表 + 更新提醒）
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
    <>
      <Routes>
        <Route path="/videomind/*" element={<VideoMindApp />} />
        <Route path="/anime" element={<AnimeApp />} />
        <Route path="*" element={<LingoSeekApp />} />
      </Routes>
      {/* 桌宠挂在路由之外：切换页面时不重新挂载，走动/位置状态都能延续。
          z-40 低于各种浮层（z-50），不会挡住登录、详情、设置这些弹窗。
          必须用错误边界圈起来：它在 Routes 之外，一旦渲染期抛错会卸载整棵树，
          灵搜和 video-mind 会一起白屏 —— 一个装饰组件不该有这种破坏力。 */}
      <ErrorBoundary>
        <WebPet />
      </ErrorBoundary>
    </>
  )
}
