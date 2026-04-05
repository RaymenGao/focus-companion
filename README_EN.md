# FocusLens - ADHD Study Assistant 👁️✨

[中文版 (Chinese version)](./README.md)

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
