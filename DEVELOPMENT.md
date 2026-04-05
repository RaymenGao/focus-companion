# 学习辅助系统 - 专注伴读仪 📖
**开发与架构文档 (Development Guide)**

> **给未来接手模型/开发者的提示词 (Prompt specifically for LLMs):**
> 这是一个基于浏览器纯前端架构（完全断网、本地算力、极高隐私）的 ADHD 辅助监督应用。系统的核心诉求是“温柔干预、去医疗化、极简操作与绝对的数据隐私”。接管本项目时，请务必阅读以下核心概念及曾经踩过的坑（尤其是 AudioContext 与 Canvas 的 WebGL 冲突坑）。

---

## 1. 系统宏观架构 (Architecture)
- **底层驱动:** 完全依赖一套 HTML 单页面文件 (`index.html`)。所有的 AI 视觉、渲染、评分和本地存储聚合在一处。曾经的 Python 原型 (`core_vision.py`) 已被废弃，无需再关注。
- **视觉引擎:** MediaPipe Face Mesh (CDN 加载 `@mediapipe/face_mesh`)。
- **音频引擎:**
    - 原生 Web Audio API (`AudioContext.createOscillator()`) 结合绝对底层的 `setTimeout` 生成稳定防卡顿的正弦波提示音。
    - Web Audio Tags (`new Audio()`) 用于播放家长实时录制的提醒语音，以及 **MP3 格式的纯白噪音学习 BGM 环境音（随暂停联动停播）**。
- **存储引擎:** 浏览器原生的 `localStorage` 存放长期打卡评估数据（无大小限制）。

---

## 2. 状态机与核心逻辑 (State Machine)
整个系统的判罚运转依赖于一个极其严密的“包容性状态机”。核心变量为 `globalState`：
- `FOCUSED`：完美专注状态（看着屏幕或低头看桌面书本）。
- `GRACE_PERIOD`：缓冲思考区。当识别到姿态偏离时，**绝不立刻报警**，而是进入此状态并抛出 UI 倒计时（默认 10 秒）。如果时间窗内恢复姿态，则倒计时取消。
- `ALARM`：倒计时归零，触发报警。此时会唤醒 `sharedAudioCtx` 播放轻柔预警，随后播放语音。
- `isSessionPaused`：暂停态。用于拦截所有的判断（上厕所/喝水）。当被激活时，记录器推入灰色的 `PAUSED` 块。

### 视觉判定指标 (在 `onResults` 中)
1. **YawRatio (偏头):** 鼻子在两眼间的偏移量。超出 `THRESH_YAW` 即为左右晃脑袋张望。
2. **PitchRatio (抬头/低头):** 鼻子与眼部中线在垂直方向上的比例。
    - 超出 `THRESH_DOWN` -> 判为低头看纸质书本（FOCUSED）。
    - 小于 `THRESH_UP` -> 判为过分抬头/后仰（分心）。
3. **IrisGaze (斜视/眼神飘忽):** 提取虹膜中心在左右眼角的偏移比例（默认阈值允许在 0.5 左右正负 0.18 波动）。即使头没动，眼珠子飘了也能瞬间察觉。

---

## 3. 闭环机制与激励模块 (Rewards & Analytics)

1. **会话控制 (`isSessionActive`)**: 
    - false 时：属于待机校准期，依然会有视觉渲染和提示音发声（供家长调适系统），但不产生任何历史记录。
    - true 时：通过点击开始按钮触发，启动一个 `setInterval(..., 1000)` 的 1 Hz 心跳。
2. **打卡记录仪 (`sessionLog`)**:
    - 心跳器每秒收集一次状态机数据压入数组 (`FOCUSED`=绿, `GRACE`=黄, `PAUSED`=灰, `ALARM`=红)。
3. **高光盲拍 (`highlightImageBase64`)**:
    - 内存中维护着连续保持专注的秒数计数器 (`continuousFocusSec`)。
    - 只要秒数越过家长设定的里程碑（如 15分钟），便立刻调用 `canvasElement.toDataURL("image/jpeg")` 在后台无声抓取人脸画面。
4. **战报与图表 (`generateReportUI`)**:
    - 在点击结束学习后爆发式渲染。利用 CSS Flexbox 将数组 `sessionLog` 转换为彩色的连续波段条带，并基于错误次数折算“专注百分比得分”。自动拼接高光截屏组成拍立得效果。
5. **纯前端大底座导出**:
    - 战报生成后调用 `saveSessionToHistory()` 入库 `localStorage`。
    - 点击「导出 CSV」，直接使用纯拼接 Blob 锚点法，让用户不经过任何服务器即可获得标准 Excel 下载。

---

## 4. 关键历史 Bug 及后续规避准则 (CRITICAL BUG FIXES)

> **⚠️ 下一任开发者务必注意以下天坑，修改代码时绝不要陷入重构陷阱或将其回退！**

1. **AudioContext WebGL 挤占死锁：**
    - **现象:** 倒计时走到 0 的瞬间，画面完全彻底卡死凝固。
    - **原因:** Chromium 内核下，如果在高频运行的带有 WebAssembly/WebGL 的帧回调 (`requestAnimationFrame` / `onResults`) 中使用 `new AudioContext()` 动态实例化声音引擎，会导致底层的 WebGL Context Lost，引发摄像追踪引擎死锁。还会因为单页面 AudioContext 限额触碰天花板导致整体噤声。
    - **修复 (已应用):** 全视野复用一个 `let sharedAudioCtx = null;`。并且通过 `document.body.addEventListener('click')` 极具技巧性地在全球任何一点产生互动时就懒加载提前激活引擎。
2. **AudioParam 的时钟偏移冲突 (The Ramp API Bug)：**
    - **现象:** 声音发不出，控制台产生数学错误红字。
    - **原因:** Web Audio 的 `exponentialRampToValueAtTime` 遇到 0 或负数底层会抛出 Exception 导致中断，且 `currentTime` 有时因为 Suspend 被延迟恢复。
    - **修复 (已应用):** 完全剥夺浏览器自己的排期时间线。把 Web Audio 全部降解至最基础的 `setTimeout` 发出 `osc.start()` -> 搭配 `linearRamp` 发声，永远不崩。

---

## 5. UI 定制化向导 (Where to modify UI)
如果接下来家长需要加新的交互功能，请定位 `index.html` 中的这几块领地：
- **`<div id="reportModal">`**: 战报复盘页面的容器（含图表和算分逻辑的 DOM 宿主）。
- **`<div id="historyModal">`**: 历史数据库面板。
- **`<div id="settingsPanel">`**: 控制悬浮窗（如果你要加新的检测阈值，在此处添加 `input type="range"` 并在 JS 的 `updateThresh()` 里进行赋值绑定）。
- **键盘监听区**: `document.addEventListener("keydown")`，现有的空格暂停被安置在这里。
