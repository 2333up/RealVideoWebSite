import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    // 统一服务：lingoSeek 自身与 video-mind 全部走同一个后端（8000），
    // 同一个前端入口（5173）。
    proxy: {
      // lingoSeek 自己的 API
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      // video-mind 前端本体（Vite dev server 跑在 5273）。
      // 改走子路径后，用户只记 5173 一个地址；
      // ws: true 是热更新必需，否则页面上会一直显示连接中断。
      //
      // 顺序很关键：Vite 按对象键的声明顺序匹配前缀，/videomind/api 必须排在
      // /videomind 之前，否则 API 请求会被转发到前端 dev server（返回 404），
      // 表现为「页面能打开但所有数据都拿不到」。
      '/videomind/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        // 不去掉 /videomind：那是子应用的挂载点，去掉后请求会打到 lingoSeek 根路由
        // 并返回 404。后端已经是单一服务，路径原样转发即可。
      },
      '/videomind/artifacts': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        // 不去掉 /videomind：那是子应用的挂载点，去掉后请求会打到 lingoSeek 根路由
        // 并返回 404。后端已经是单一服务，路径原样转发即可。
      },
      '/videomind': {
        target: 'http://127.0.0.1:5273',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
