# FocusLens V2 Frontend

Vite + React + TypeScript PWA frontend for FocusLens V2.

## Run

```powershell
npm.cmd install
npm.cmd run dev
```

Open the Vite URL, usually `http://127.0.0.1:5173`.

## Notes

- The original `adhd-warning/index.html` remains untouched.
- FaceMesh still loads from jsDelivr, matching the v1 app behavior.
- AI calls go through the backend at `http://127.0.0.1:8012` by default.
- The app stays usable in local-only mode when the backend is offline; AI teacher, remote cost summary, and remote mistake sync require the backend.
- Do not hard-code real API keys in frontend files. Configure OpenAI-compatible providers through the settings UI and the local backend proxy.
