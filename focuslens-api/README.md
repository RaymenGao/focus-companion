# FocusLens V2 API

FastAPI backend for FocusLens V2 AI teacher proxying, budget checks, Markdown-first learning events, and curated knowledge wiki aggregation.

## Run

```powershell
python -m venv .venv
.\\.venv\\Scripts\\python -m pip install -r requirements.txt
.\\.venv\\Scripts\\python -m uvicorn main:app --reload --host 127.0.0.1 --port 8012
```

The frontend should call this local API first. Third-party OpenAI-compatible base URLs and API keys are configured through the app UI and proxied by this backend.

## Local Markdown Data

- `wiki/events/YYYY/MM/`: photographed questions, voice questions, and contextual follow-ups
- `wiki/assets/questions/`: locally captured question images
- `wiki/knowledge/`: user-approved knowledge pages and manual mastery status
- `wiki/papers/`: generated practice papers
- `wiki/flashcards/`: generated flashcard sets
- `wiki/reports/`: weekly, monthly, semester, and custom reports

SQLite is a rebuildable index; Markdown files remain the local source of truth. The event endpoints support list/read/follow-up/reveal/promote/rebuild workflows, while the Wiki endpoints support knowledge status and review generation.

Do not commit real API keys. Use local environment variables or the app settings UI for private credentials.

`DATABASE_URL` defaults to local SQLite for development. Use a PostgreSQL URL in production, for example:

```text
postgresql+psycopg://user:password@host:5432/focuslens
```
