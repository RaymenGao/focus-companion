# FocusLens V2 API

FastAPI backend for FocusLens V2 AI teacher proxying, budget checks, mistake book records, and knowledge wiki aggregation.

## Run

```powershell
python -m venv .venv
.\\.venv\\Scripts\\python -m pip install -r requirements.txt
.\\.venv\\Scripts\\python -m uvicorn main:app --reload --host 127.0.0.1 --port 8012
```

The frontend should call this local API first. Third-party OpenAI-compatible base URLs and API keys are configured through the app UI and proxied by this backend.

Do not commit real API keys. Use local environment variables or the app settings UI for private credentials.

`DATABASE_URL` defaults to local SQLite for development. Use a PostgreSQL URL in production, for example:

```text
postgresql+psycopg://user:password@host:5432/focuslens
```
