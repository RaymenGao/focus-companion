# FocusLens V2

FocusLens V2 is a multimodal study companion for children who need gentler focus support. It keeps the original browser-only focus tracker as a stable fallback, and adds a new Web/PWA app plus a local backend proxy for AI teacher workflows.

## What Is New In V2

- Web/PWA frontend built with Vite, React, and TypeScript.
- Dual-camera workflow: front camera for face/head attention tracking, overhead camera for writing activity and paper capture.
- AI teacher support through a local FastAPI proxy and OpenAI-compatible multimodal APIs.
- Voice-first interaction: F8 for capture-and-ask, F9 for contextual follow-up, F10 for voice-only questions.
- Mistake book and knowledge wiki with Markdown + LaTeX rendering.
- Study dashboard, calendar, reminders, custom voice prompt, background music, and local focus reports.

## Repository Layout

```text
.
├─ index.html              # V1 stable browser-only app, kept as fallback
├─ sw.js                   # V1 service worker
├─ libs/                   # V1 local MediaPipe assets
├─ release-v1.0/           # V1 release snapshot
├─ focuslens-v2/           # V2 React/PWA frontend
└─ focuslens-api/          # V2 FastAPI local AI proxy and mistake/wiki backend
```

## Run V2 Locally

Start the backend:

```powershell
cd focuslens-api
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn main:app --reload --host 127.0.0.1 --port 8012
```

Start the frontend:

```powershell
cd focuslens-v2
npm.cmd install
npm.cmd run dev
```

Open the Vite URL, usually `http://127.0.0.1:5173` or the next available local port.

## AI Configuration

V2 expects third-party OpenAI-compatible model settings to be configured in the app UI:

- Local backend URL: usually `http://127.0.0.1:8012`
- AI API base URL: for example an OpenAI-compatible `/v1` endpoint
- API key
- Model name
- Streaming mode
- Budget and image-upload limits

The browser should talk to the local FocusLens API. The local API then talks to the model provider. This keeps API keys out of frontend source code and avoids browser CORS problems.

## Privacy And Secret Safety

Do not commit real API keys or local study data.

Ignored by default:

- `.env` and `.env.*`
- key/certificate files such as `*.pem`, `*.key`, `*.p12`, `*.pfx`
- local databases such as `*.db`, `*.sqlite`
- generated `focuslens-api/wiki/` records
- `node_modules/`, `.venv/`, `dist/`, logs, caches, and tool scratch files

If you need to share configuration, add an example file with fake values only.

## Run V1 Fallback

The original v1 app remains available:

```text
index.html
```

Open it directly in Chrome or Edge. It is still a pure browser app and does not require the V2 backend.

