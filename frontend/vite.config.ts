import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 端口被占直接报错，不允许静默漂移到 5174：
    // 漂移过 → 用户书签里的 5173 打开的是旧实例，新改动全不生效，极难排查。
    strictPort: true,
    host: '127.0.0.1',
    // 单一前端服务：lingoSeek 与 video-mind 融合在同一个工程里，
    // 页面分发由前端路由负责（src/App.tsx），dev server 只代理 API。
    proxy: {
      // lingoSeek 自己的 API
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      // video-mind 的 API：后端把它挂在 /videomind 子路径下，原样转发即可。
      // 去掉前缀会打到 lingoSeek 的根路由上并返回 404，
      // 表现为「页面能打开但所有数据都拿不到」。
      '/videomind/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      // video-mind 的产物文件（思维导图图片等），同样挂在后端子路径下
      '/videomind/artifacts': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
