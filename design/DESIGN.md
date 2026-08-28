# CC-Fix Design System

本项目采用 Warp-inspired 的深色工具界面参考：温暖近黑画布、低对比表面层、细边框、紧凑圆角和克制动效。中文字体必须来自本地随包资源；系统字体只作回退，不使用 CDN。

## Tokens

- `canvas`: `#0f1117`；`surface`: `#1a1d27`；`surface-elevated`: `#222633`
- `text-primary`: `#f4f4f5`；`text-secondary`: `#a1a1aa`；`text-disabled`: `#71717a`
- `border-subtle`: `#2a2d3a`；`focus`: `#a5b4fc`
- `accent`: `#818cf8`；`success`: `#22c55e`；`warning`: `#eab308`；`danger`: `#ef4444`
- spacing base: `4px`; cards `12px`; controls `8px`; status pills `9999px`
- body: local `CCFix Noto Sans SC` with system fallback; code: system monospace with local CJK fallback

## Type scale

- display：`56px/1`（风险评分）；标题 `24px/600`、`21px`（窄窗）；小节 `15px/600`
- 正文：`13-14px`；辅助：`12px`（`text-secondary`/`muted` ≥ 4.5:1 对比度）
- 长值/长路径：`word-break: break-all; overflow-wrap: anywhere`（信号值、detect 值）

## Focus & contrast

- 交互元素 `:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px }`；最小触达 44px（窄窗按钮 `min-height: 48px`）
- 语义色仅作增强，不单独承担状态（`text-success`/`text-danger`/坏点符号并存）
- 正文对比：`text-secondary` on `surface` ≈ 6.6:1；`muted` on `canvas` ≈ 7:1；均 ≥ 4.5:1

## Interaction

- Primary/secondary/danger actions use text plus an icon; color is never the only state cue.
- Every interactive control has a visible `:focus-visible` outline and a minimum 44px touch height.
- Motion yields to `prefers-reduced-motion`; forced-colors keeps borders and labels visible.
- HTML/API are `no-store`; local immutable font assets use explicit MIME and ETag.
