import './index.css'
// video-mind 的页面级样式（.vm-root / ReactFlow 覆盖 / 细滚动条）。
// 放在 index.css 之后引入：两者作用域不重叠，顺序只影响同优先级规则，
// 而 video-mind 的规则全部收敛在 .vm-root 内，不会反向污染搜索页。
import './videomind/videomind.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'

// BrowserRouter：融合后两个应用同源同路径，需要前端路由来分发
// /videomind/*（以前那是另一个 dev server 的真实路径）。
// 生产部署时需服务端把所有未知路径回退到 index.html。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
