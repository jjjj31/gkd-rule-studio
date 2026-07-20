# GKD Rule Studio - 安卓前端 UI 风格 Demo

本项目为 GKD Rule Studio 的安卓前端（WebView 内嵌 React）准备了 4 种不同风格的 UI Demo。每个 Demo 都是独立的 HTML 文件，可以直接用浏览器打开预览。

---

## 📁 文件清单

| 文件 | 风格 | 特点 |
|------|------|------|
| `demo-glassmorphism.html` | **Glassmorphism 毛玻璃** | 半透明面板 + 背景模糊 + 渐变浮动光球，现代 iOS/Android 风格 |
| `demo-material-you.html` | **Material You (Material 3)** | Google 最新设计语言，动态色彩、圆角卡片、Elevation 层级 |
| `demo-cyberpunk.html` | **Cyberpunk 赛博朋克** | 斜切角边框、霓虹发光、扫描线、Orbitron 字体，科技硬核风 |
| `demo-ios-style.html` | **iOS 原生风格** | 大标题导航、分组列表、Segmented Control、SF Pro 字体 |

---

## 🚀 预览方式

直接用浏览器打开任意 HTML 文件即可，建议：

1. **桌面浏览器**：按 `F12` 打开开发者工具，切换到手机模拟模式（iPhone 14 / Pixel 7 等）
2. **手机浏览器**：将文件传到手机上，用 Safari/Chrome 直接打开

每个 Demo 都包含：
- **首页 Demo**：设备连接面板 + 快照列表 + 底部导航栏
- **工作区 Demo**：截图画布 + 标签切换 + 面板区域
- 点击「切换工作区」按钮可在首页和工作区之间切换

---

## 🎨 各风格详细说明

### 1. Glassmorphism 毛玻璃风格
- **视觉核心**：半透明模糊面板（`backdrop-filter: blur`）+ 渐变浮动背景光球
- **色彩**：深空蓝底 + 青色/蓝色/紫色渐变点缀
- **适合**：追求现代感、轻盈通透的视觉效果
- **第三方库**：可搭配 `framer-motion` 实现光球动画

### 2. Material You (Material 3)
- **视觉核心**：动态色彩令牌（Color Tokens）+ Elevation 阴影层级 + 圆角卡片
- **色彩**：基于 Primary/Tertiary/Error 的系统化配色
- **适合**：与 Android 原生体验一致，Material Design 忠实用户
- **第三方库**：`@material/web` 或 `@mui/material`

### 3. Cyberpunk 赛博朋克
- **视觉核心**：斜切角边框（clip-path）+ 霓虹发光文字 + 扫描线 overlay
- **色彩**：纯黑底 + 青色/洋红/黄色霓虹高亮
- **适合**：技术极客、开发者工具、硬核科技感
- **第三方库**：`framer-motion` 做发光脉冲动画

### 4. iOS 原生风格
- **视觉核心**：大标题导航栏 + 分组列表（UITableView 风格）+ Segmented Control
- **色彩**：纯黑底 + 系统蓝/绿/橙强调色
- **适合**：iPhone 用户、追求原生系统一致性
- **第三方库**：`react-native` 风格的 CSS 变量系统

---

## 🛠️ 正式美化方案建议

选定风格后，正式集成时推荐的开源第三方库组合：

### 通用基础（必选）
| 库 | 用途 | 安装 |
|----|------|------|
| **Tailwind CSS v4** | 原子化 CSS 框架，替代手写 4500+ 行 styles.css | `npm install -D tailwindcss` |
| **Framer Motion** | 流畅的入场/过渡/交互动画 | `npm install framer-motion` |

### 风格专用（根据选择）
| 风格 | 推荐库 | 安装 |
|------|--------|------|
| Glassmorphism | `lucide-react`（已有）+ Tailwind + Framer Motion | — |
| Material You | `@mui/material` + `@emotion/react` | `npm install @mui/material @emotion/react @emotion/styled` |
| Cyberpunk | `framer-motion` + 自定义 CSS clip-path | — |
| iOS 风格 | `tailwindcss` + 自定义 design tokens | — |

---

## 📋 下一步

1. 在浏览器中打开 4 个 Demo，选择最喜欢的风格
2. 告诉我你的选择 + 是否需要混搭调整
3. 我会正式将选定风格集成到项目的 React 代码中，包括：
   - 安装必要的依赖库
   - 重构 `styles.css` 为 Tailwind / 组件库方案
   - 重写 `AndroidLiteApp.tsx` 的 UI 结构
   - 添加动画和交互效果
