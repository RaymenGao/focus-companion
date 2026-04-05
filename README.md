# FocusLens - ADHD Study Assistant 👁️✨ / 专注伴读仪

*[Skip to Chinese Version / 跳转至中文版](#中文版-chinese-version)*

![Pure Browser Environment](https://img.shields.io/badge/Environment-Pure%20Browser-success)
![Data Privacy](https://img.shields.io/badge/Privacy-100%25%20Local-blue)
![Architecture](https://img.shields.io/badge/Tech-HTML5_|_MediaPipe-orange)

FocusLens is a highly empathetic, **100% local, privacy-focused visual tracking companion**, engineered meticulously for children with ADHD and learners who need an immersive focus environment. It runs entirely within any modern browser—no server interactions, no invasive backend tracking, and absolute protection of your facial privacy data.

## 🌟 Core Concepts & Features

*   **100% Local & Absolute Data Security:**
    Powered by cutting-edge WebAssembly and MediaPipe JS. Your **camera feed streams, custom-recorded voice clips, study duration, and assessment profiles** will absolutely never leave your computer's RAM. Zero network requests! Historical data charts are securely persisted deep inside your browser's local sandbox.
    
*   **Empathetic "Grace Period" Mechanisms:**
    Traditional monitoring architectures are harsh and often trigger resentment. Our algorithm introduces a customizable "Thought Buffer Window". Minor, innocent distractions like glancing away to pick up an eraser or taking a deep breath will *not* trigger the alarm. Gentle interventions are only applied when the distraction threshold strictly exceeds the defined limit.
    
*   **Soft & Multi-layered Interventions:**
    When a distraction is caught, the system initiates a low-stress, progressive `beep-beep` countdown sequence. Should the distraction continue, it will play a **custom vocal recording** made by a parent or guardian, eliminating the robotic, anxiety-inducing alarms typical of commercial systems.

*   **Deep Immersion & Custom Ambience:**
    Import your favorite Alpha-Wave tracks, soft rain, or white noise natively within the app. Moreover, the dynamic `Spacebar` break mechanism allows students to seamlessly pause the radar and mute the music when stepping away for water or a restroom break.

*   **Positive Reinforcement & Clinical Insights:**
    We reward focus as aggressively as we correct distraction! Crossing sustained concentration milestones triggers an invisible, silent "Highlight Snapshot" capturing their peak state of flow to present as a Polaroid-style reward upon session completion. The tool also exports highly detailed `.CSV` timelines directly from memory, mapping focus/distraction metrics per second—an invaluable offline asset for pediatric clinical follow-ups.

---

## 🚀 Quick Start Instructions

This project requires zero dependency installations (No `Python`, no `.env`, no `Node.js`!)

1. Simply download this repository.
2. Double-click to open `index.html` (Google Chrome or Microsoft Edge recommended).
3. If deployed on GitHub Pages, grant the browser permission to access your Camera & Microphone.
4. Tweak the sensitivity sliders, toggle your background music, and click **[▶️ Start Focus Session]**.

## 🛠️ For Developers & Hacker Parents

Looking to modify the foundational thresholds, add granular logic, or understand how to prevent WebAudio context collisions during WebGL render loops? Please consult our [DEVELOPMENT.md](./DEVELOPMENT.md) before pushing massive logic modifications.

<br>
<br>

<h1 align="center" id="中文版-chinese-version">🇨🇳 中文版 (Chinese Version)</h1>

---

# FocusLens - 专注伴读仪 👁️✨

![纯本地浏览器环境](https://img.shields.io/badge/Environment-Pure%20Browser-success)
![Data Privacy](https://img.shields.io/badge/Privacy-100%25%20Local-blue)
![Architecture](https://img.shields.io/badge/Tech-HTML5_|_MediaPipe-orange)

这是一个为 ADHD（注意力缺陷与多动障碍）儿童及需要高度专注氛围的学习者而设计的——**充满人性和关怀温度的纯本地视觉护航系统**。它直接跑在任何一台带有现代浏览器的电脑上，不需要安装任何后台程序，绝对保护面部隐私。

## 🌟 核心理念与特色

*   **100% 纯本地与隐私绝对安全：**
    采用最前沿的 WebAssembly 和 MediaPipe 前端技术，你的**脸部视频流、录音留存、学习时间与评估分数**绝对无法被上传、且绝不会离开你这台电脑的内存。连历史数据图表也是储存在你的本地浏览器基座中的。
    
*   **同理心“包容干预”机制：**
    传统的监控系统粗暴且容易让孩子反感。我们的算法设立了基于时间轴的“缓冲思考期”。孩子短暂的转头捡橡皮、抬头深呼吸绝不会触发警报，只有当分心时间超过家长设定的阈值，才会启动温柔预警。
    
*   **全方位防惊吓的软干预：**
    发现跑神后，系统会先播放渐进式的柔和 `嘟嘟嘟` 倒计时。如果不听，才会播放家长亲自录制的**人声提醒**，完全摒弃了恐怖的系统机械音。

*   **支持环境心流沉浸：**
    内置背景学习音乐引擎，可以直接导入自己喜欢的“白噪音/雨声/阿尔法脑波音乐”。并且系统支持 `空格键` 一键急停去洗手间（音乐也会体贴地同步挂起）。加上一键纯正面的黑屏遮挡专注模式，杜绝电脑光干扰。

*   **正向医疗反馈（高光快照 + 历史走势排雷）：**
    不仅惩罚，更懂奖励！当孩子连续专注突破 X 分钟大关，系统会自动拍下一张极具仪式感的“高光学习快照”贴在结算战报上。一键导出的 `.CSV` 表格更可以拿给医生做最客观的长期复盘评估。

---

## 🚀 极简指南：跑起来！

本项目无需搭建繁重的代码环境（`Python`, `Node.js` 通通不需要！）。

1. 直接下载本仓库。
2. 双击运行 `index.html`（强烈建议使用 Chrome 或 Edge 浏览器）。
3. 如果是在 Github Pages 线上浏览本系统，请直接授予浏览器弹出的“摄像头/麦克风存取权限”。
4. 调参把玩后，点击绿色巨型按钮 **[开始专注打卡学习]**，让陪伴开始。

## 🛠️ 致开发者与极客父母

想修改警报灵敏度基准、或二创这套程序的判定逻辑吗？请务必阅读本工程的 [DEVELOPMENT.md](./DEVELOPMENT.md) 获取如何规避 WebAudio 失真与卡顿的最佳实践文档。
