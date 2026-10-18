/**
 * 播放器区的布局与控件冒烟。
 *
 * 覆盖（2026-10-17 需求）：
 *   1. 窗口严格 16:9，且**完整落在播放器块内**（不再超出被裁）
 *   2. 播放器区不出现滚动条（以前视频 + 常驻控制条超出容器，硬生生滚出一条）
 *   3. 控制条悬浮在画面上（底部渐变层内），而不是单独占一行
 *   4. 有 5 秒 / 10 秒 的前进与后退共四个按钮
 *   5. 倍速菜单能改播放速率；全屏按钮存在
 *   6. 播放中鼠标静置后控制条自动淡出，鼠标一动又回来
 *   7. 两侧面板折叠后中栏变得很宽，画面依然保持 16:9 且不出块
 *      （章节搬到左栏后没有横向分割线了，高度只能由播放区自己夹）
 *
 * 前置：CDP 浏览器（9222）+ 前端 5173 + 后端 8000。
 * 用法：node frontend/scripts/probe-player.mjs
 */
import { createRequire } from 'node:module'

const WORKSPACE = 'C:/Users/momo/.workbuddy/binaries/node/workspace/node_modules'
const require = createRequire(WORKSPACE + '/')
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:5173'
const CDP = 'http://127.0.0.1:9222'
const KEYWORD = '锹农炮虫'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures += 1
}

const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0] ?? (await browser.newContext())
const page = await context.newPage()
await page.setViewportSize({ width: 1440, height: 900 })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

async function openVideo(keyword) {
  for (let pass = 0; pass < 6; pass += 1) {
    await page.evaluate(() => {
      for (const r of document.querySelectorAll('[data-panel="left"] [data-folder-row][data-expanded="false"]')) {
        r.click()
      }
    })
    await page.waitForTimeout(250)
    const rows = page.locator('[data-panel="left"] .cursor-pointer')
    const total = await rows.count()
    for (let i = 0; i < total; i += 1) {
      const t = await rows.nth(i).innerText().catch(() => '')
      if (t.includes(keyword)) {
        await rows.nth(i).click()
        return true
      }
    }
  }
  return false
}

await page.goto(BASE + '/videomind/', { waitUntil: 'networkidle' })
await page.evaluate(() => localStorage.removeItem('video-mind:layout.v1'))
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
check('打开 video-mind', (await page.locator('text=video-mind').count()) > 0)
check('点开目标视频', await openVideo(KEYWORD))
await page.waitForTimeout(2500)

// ================= A. 16:9 且不溢出 =================
console.log('\n[A] 播放器窗口')
const geo = await page.evaluate(() => {
  const R = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }
  }
  const block = document.querySelector('[data-player-block]')
  const stage = document.querySelector('[data-player-stage]')
  // 播放器区里任何出现滚动溢出的盒子（视频自己除外）
  const overflowing = [...document.querySelectorAll('[data-player-block] *')]
    .filter((e) => e.tagName !== 'P' && e.scrollHeight > e.clientHeight + 2)
    .map((e) => `${e.tagName}.${(e.className || '').toString().slice(0, 30)}`)
  return {
    block: R(block),
    stage: R(stage),
    ratio: stage ? stage.getBoundingClientRect().width / stage.getBoundingClientRect().height : 0,
    overflowing,
    // 章节已经搬到左栏 tab，中栏里不该再出现章节卡：
    // 一旦它还在，「上视频下章节」的老布局就又回来了
    chaptersInMain: document.querySelectorAll('main [data-chapter-id]').length,
    // 中栏内部纵向滚动（含状态卡）也算溢出
    scrollOverflow: (() => {
      const m = document.querySelector('main')
      return m ? m.scrollHeight - m.clientHeight : 0
    })(),
  }
})
console.log(`  info 播放器块 ${geo.block?.w}×${geo.block?.h}，窗口 ${geo.stage?.w}×${geo.stage?.h}`)
check(
  '窗口比例为 16:9',
  Math.abs(geo.ratio - 16 / 9) < 0.02,
  `实测 ${geo.ratio.toFixed(3)}`,
)
check(
  '窗口完整落在播放器块内（不被裁切）',
  !!geo.stage && !!geo.block && geo.stage.bottom <= geo.block.bottom + 1,
  `窗口底 ${geo.stage?.bottom} vs 块底 ${geo.block?.bottom}`,
)
check('播放器区没有滚动溢出', geo.overflowing.length === 0, geo.overflowing.slice(0, 2).join(' | '))
check('中栏不再挤着章节卡', geo.chaptersInMain === 0, `中栏里有 ${geo.chaptersInMain} 条`)
check('中栏没有纵向溢出', geo.scrollOverflow <= 1, `溢出 ${geo.scrollOverflow}px`)

// ================= B. 悬浮控制条 =================
console.log('\n[B] 悬浮控制条')
const stage = page.locator('[data-player-stage]').first()
await stage.hover()
await page.waitForTimeout(300)
const bar = await page.evaluate(() => {
  const st = document.querySelector('[data-player-stage]')
  const el = [...st.querySelectorAll('div')].find((d) =>
    (d.className || '').includes('bg-gradient-to-t'),
  )
  if (!el) return null
  const r = el.getBoundingClientRect()
  const s = st.getBoundingClientRect()
  return {
    insideStage: r.bottom <= s.bottom + 1 && r.top >= s.top,
    height: Math.round(r.height),
    opacity: getComputedStyle(el).opacity,
  }
})
check('控制条存在且在画面内（浮于视频之上）', !!bar && bar.insideStage, bar ? `高 ${bar.height}px` : '未找到')
check('控制条当前可见', bar && bar.opacity === '1', `opacity=${bar?.opacity}`)

// ================= C. 快进 / 快退按钮 =================
console.log('\n[C] 快进快退')
for (const label of ['后退 10 秒', '后退 5 秒', '前进 5 秒', '前进 10 秒']) {
  const btn = page.locator(`[data-player-stage] button[aria-label="${label}"]`)
  const box = (await btn.count()) > 0 ? await btn.first().boundingBox() : null
  check(
    `「${label}」按钮存在且不小于 24×24`,
    !!box && box.width >= 24 && box.height >= 24,
    box ? `${Math.round(box.width)}×${Math.round(box.height)}` : '未找到',
  )
}

// 真按一下「前进 10 秒」，看播放位置有没有动
const t0 = await page.evaluate(() => document.querySelector('video').currentTime)
await page.locator('[data-player-stage] button[aria-label="前进 10 秒"]').click()
await page.waitForTimeout(400)
const t1 = await page.evaluate(() => document.querySelector('video').currentTime)
check('点「前进 10 秒」播放位置前移', t1 > t0 + 5, `${t0.toFixed(1)}s -> ${t1.toFixed(1)}s`)

// 档位文字：必须是「10 秒 / 5 秒」，不能只剩一个数字（2026-10-18 用户要求）
for (const label of ['后退 10 秒', '后退 5 秒', '前进 5 秒', '前进 10 秒']) {
  const txt = (
    await page
      .locator(`[data-player-stage] button[aria-label="${label}"]`)
      .first()
      .innerText()
      .catch(() => '')
  ).replace(/\s+/g, '')
  check(
    `「${label}」按钮上写着秒数`,
    txt.includes('秒') && /(10|5)/.test(txt),
    txt || '(空)',
  )
}

// ================= C2. 点画面播放/暂停 =================
// 2026-10-18 用户反馈：播放中点画面没反应，只有暂停时那个大播放按钮能点。
console.log('\n[C2] 点画面切换播放')
{
  // 先确保在播放：暂停时画面中央是播放按钮，点它一次即可。
  // 起播是异步的，等状态别等固定毫秒——等 600ms 偶尔会抢在 video.play() 生效之前。
  if (await page.evaluate(() => document.querySelector('video').paused)) {
    await page.locator('[data-player-stage]').click({ position: { x: 120, y: 60 } })
    await page
      .waitForFunction(() => !document.querySelector('video')?.paused, null, { timeout: 5000 })
      .catch(() => {})
  }
  const playing = await page.evaluate(() => !document.querySelector('video').paused)
  check('先让视频处于播放中', playing)
  // 点在画面上方 1/4 处：避开底部控制条
  await page.locator('[data-player-stage]').click({ position: { x: 160, y: 50 } })
  await page.waitForTimeout(500)
  const paused1 = await page.evaluate(() => document.querySelector('video').paused)
  check('播放中点画面能暂停', paused1)
  await page.locator('[data-player-stage]').click({ position: { x: 160, y: 50 } })
  await page.waitForTimeout(500)
  const paused2 = await page.evaluate(() => document.querySelector('video').paused)
  check('再点一下恢复播放', !paused2)
}

// ================= C3. 方向键快进快退 =================
// 2026-10-18 用户要求：← / → 控制视频（后退/前进 5 秒）。
console.log('\n[C3] 方向键')
{
  // 鼠标离开右栏（那边 ←/→ 是导图导航），并暂停，避免播放进度干扰测量
  await page.locator('[data-player-stage]').hover()
  await page.evaluate(() => document.querySelector('video').pause())
  await page.waitForTimeout(300)

  const t0 = await page.evaluate(() => document.querySelector('video').currentTime)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(400)
  const t1 = await page.evaluate(() => document.querySelector('video').currentTime)
  check('→ 前进 5 秒', Math.abs(t1 - t0 - 5) < 1.2, `${t0.toFixed(1)}s → ${t1.toFixed(1)}s`)

  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(400)
  const t2 = await page.evaluate(() => document.querySelector('video').currentTime)
  check('← 后退 5 秒', Math.abs(t2 - t1 + 5) < 1.2, `${t1.toFixed(1)}s → ${t2.toFixed(1)}s`)

  // 在输入框里按方向键：移光标，不该跳播
  await page.locator('input[placeholder="搜索节点…"]').click()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(400)
  const t3 = await page.evaluate(() => document.querySelector('video').currentTime)
  check('输入框里按方向键不跳播', Math.abs(t3 - t2) < 1, `${t2.toFixed(1)}s → ${t3.toFixed(1)}s`)
  await page.locator('[data-player-stage]').click({ position: { x: 160, y: 50 } })
  await page.evaluate(() => document.querySelector('video').pause())
  await page.waitForTimeout(200)
}

// ================= D. 倍速菜单 =================
console.log('\n[D] 倍速')
await page.locator('[data-player-stage] button[aria-label="播放倍速"]').click()
await page.waitForTimeout(300)
const rate2 = page.getByRole('button', { name: '1.5x', exact: true })
check('倍速菜单列出档位', (await rate2.count()) > 0)
if ((await rate2.count()) > 0) {
  await rate2.first().click()
  await page.waitForTimeout(300)
  const r = await page.evaluate(() => document.querySelector('video').playbackRate)
  check('选 1.5x 后播放器速率跟着变', Math.abs(r - 1.5) < 0.01, `playbackRate=${r}`)
  // 还原
  await page.locator('[data-player-stage] button[aria-label="播放倍速"]').click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: '1x', exact: true }).first().click()
  await page.waitForTimeout(200)
}
check('全屏按钮存在', (await page.locator('[data-player-stage] button[aria-label="全屏"]').count()) > 0)

// ================= E. 播放中自动淡出 =================
console.log('\n[E] 播放时控制条自动隐藏')
// 上一段结束时视频可能在播也可能停着——播放中画面中央没有那个播放按钮，
// 所以统一走「点画面」：暂停时点到的是中央按钮，播放时点到的是画面本身。
if (await page.evaluate(() => document.querySelector('video').paused)) {
  await page.locator('[data-player-stage]').click({ position: { x: 160, y: 50 } })
}
await page.waitForTimeout(600)
const playing = await page.evaluate(() => !document.querySelector('video').paused)
console.log(`  info 播放状态：${playing ? '播放中' : '未播放（浏览器可能拦截了自动播放）'}`)
if (playing) {
  await page.waitForTimeout(3200) // 超过 IDLE_HIDE_MS
  const op = await page.evaluate(() => {
    const st = document.querySelector('[data-player-stage]')
    const el = [...st.querySelectorAll('div')].find((d) =>
      (d.className || '').includes('bg-gradient-to-t'),
    )
    return el ? getComputedStyle(el).opacity : null
  })
  check('静置后控制条淡出', op === '0', `opacity=${op}`)
  await page.locator('[data-player-stage]').hover()
  await page.mouse.move(700, 300)
  await page.waitForTimeout(400)
  const op2 = await page.evaluate(() => {
    const st = document.querySelector('[data-player-stage]')
    const el = [...st.querySelectorAll('div')].find((d) =>
      (d.className || '').includes('bg-gradient-to-t'),
    )
    return el ? getComputedStyle(el).opacity : null
  })
  check('鼠标一动控制条回来', op2 === '1', `opacity=${op2}`)
  await page.locator('[data-player-stage] button[aria-label="暂停"]').first().click()
}

/**
 * F. 折叠两侧面板，中栏一下子变得很宽。
 *
 * 这是换布局之后新冒出来的场景：以前章节在中栏下面顶着，中栏宽度受两侧面板
 * 限制，满宽算 16:9 也顶不到天；现在章节去了左栏，把两侧都折叠掉之后
 * 中栏能宽到 1300+，按满宽算出来的高度直接超出窗口——画面下半截被裁掉。
 * 所以必须验证「高度不够时按高度内接」，以及夹住之后两侧黑边是对称的。
 */
console.log('\n[F] 折叠两侧面板，中栏变宽后仍装得下')
await page.locator('div[role="separator"][aria-label="调整左侧栏宽度"]').first().dblclick()
await page.waitForTimeout(300)
await page.locator('div[role="separator"][aria-label="调整导图区宽度"]').first().dblclick()
await page.waitForTimeout(800)
const wide = await page.evaluate(() => {
  const R = (el) => {
    const r = el.getBoundingClientRect()
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      left: Math.round(r.left),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
    }
  }
  const block = document.querySelector('[data-player-block]')
  const stage = document.querySelector('[data-player-stage]')
  const br = block.getBoundingClientRect()
  const sr = stage.getBoundingClientRect()
  return {
    block: R(block),
    stage: R(stage),
    ratio: sr.width / sr.height,
    fits: sr.bottom <= br.bottom + 1 && sr.width <= br.width + 1,
    // 画面被高度夹住时两侧会留黑边：黑边应当左右对称，而不是被裁掉一截
    leftPad: Math.round(sr.left - br.left),
    rightPad: Math.round(br.right - sr.right),
  }
})
console.log(`  info 折叠后：块 ${wide.block.w}×${wide.block.h}，窗口 ${wide.stage.w}×${wide.stage.h}`)
check('中栏变宽后仍是 16:9', Math.abs(wide.ratio - 16 / 9) < 0.02, `实测 ${wide.ratio.toFixed(3)}`)
check('中栏变宽后仍完整装在块内', wide.fits)
check(
  '高度夹住时两侧余量对称',
  Math.abs(wide.leftPad - wide.rightPad) <= 2,
  `左 ${wide.leftPad}px / 右 ${wide.rightPad}px`,
)

await page.screenshot({ path: 'J:/AIProject/RealVideoWebSite/.probe/player-final.png' })

// 还原：不还原的话折叠状态会写进 localStorage，后面几个脚本的起点就不对了
await page.locator('button[aria-label="展开视频库"]').first().click()
await page.waitForTimeout(300)
await page.locator('button[aria-label="展开思维导图"]').first().click()
await page.waitForTimeout(300)
check(
  '两侧面板可再展开',
  (await page.locator('div[role="separator"][aria-label="调整左侧栏宽度"]').count()) > 0 &&
    (await page.locator('div[role="separator"][aria-label="调整导图区宽度"]').count()) > 0,
)
check('无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)
