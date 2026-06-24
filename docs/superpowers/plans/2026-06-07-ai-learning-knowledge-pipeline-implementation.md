# FocusLens V2 AI Learning Knowledge Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct mistake-to-Wiki ingestion with a Markdown-first learning-event pipeline that supports photographed questions, simple voice questions, contextual follow-ups, curated knowledge pages, review materials, and reports.

**Architecture:** Add a focused backend event store that atomically writes Markdown and image assets, then expose event APIs and route each Tutor interaction through an event lifecycle. Keep SQLite as a rebuildable index and adapt the existing Wiki actions to read events and knowledge pages instead of treating every interaction as a knowledge point.

**Tech Stack:** FastAPI, SQLAlchemy/SQLite, Pydantic, Markdown frontmatter, React, TypeScript, Vite.

---

### Task 1: Markdown Event Store

**Files:**
- Create: `focuslens-api/event_store.py`
- Create: `focuslens-api/test_event_store.py`
- Modify: `focuslens-api/main.py`

- [ ] Write tests proving draft creation, atomic completion, follow-up append, answer reveal, image persistence, and event listing.
- [ ] Implement `LearningEvent`, `EventStore`, frontmatter serialization, atomic file replacement, WebP/data-URL asset persistence, and Markdown parsing.
- [ ] Add `LearningEventIndex` SQLAlchemy model and rebuild the index from Markdown without modifying source files.
- [ ] Run `python -m unittest -v test_event_store.py test_main.py`.

### Task 2: Event APIs and Tutor Routing

**Files:**
- Modify: `focuslens-api/main.py`
- Modify: `focuslens-api/test_main.py`

- [ ] Add event create/list/read/follow-up/reveal/archive/rebuild endpoints.
- [ ] Extend Tutor requests with `interactionMode` and `eventId`.
- [ ] Create a draft before AI execution, complete it after parsing, and append follow-ups to the selected event.
- [ ] Stop rebuilding the entire Wiki in the synchronous Tutor response path.
- [ ] Verify photographed questions and voice-only questions create events, while follow-ups update the original event.

### Task 3: Frontend Event-Aware Tutor

**Files:**
- Modify: `focuslens-v2/src/types.ts`
- Modify: `focuslens-v2/src/api.ts`
- Modify: `focuslens-v2/src/main.tsx`
- Modify: `focuslens-v2/src/styles.css`

- [ ] Add learning-event types and API client functions.
- [ ] Track the current event returned by the Tutor response.
- [ ] Make F8/photo ask create a photographed-question event, F10 voice ask create a voice-question event, and F9 append a follow-up to the current event.
- [ ] Split displayed reasoning from final answer and add an explicit reveal button.
- [ ] Add an event-history area with event switching for follow-ups.
- [ ] Run `npm run build`.

### Task 4: Knowledge Pages and Manual Status

**Files:**
- Modify: `focuslens-api/main.py`
- Modify: `focuslens-v2/src/types.ts`
- Modify: `focuslens-v2/src/api.ts`
- Modify: `focuslens-v2/src/main.tsx`

- [ ] Build knowledge pages from approved event-to-knowledge links rather than every event.
- [ ] Add manual `weak/learning/mastered/ignored` status APIs.
- [ ] Exclude mastered and ignored pages from default review generation.
- [ ] Add “沉淀为知识点” and status controls in the Wiki UI.

### Task 5: Curator Proposals, Papers, Flashcards, Reports

**Files:**
- Modify: `focuslens-api/main.py`
- Modify: `focuslens-v2/src/api.ts`
- Modify: `focuslens-v2/src/main.tsx`

- [ ] Make Lint output low-risk applied changes and high-risk approval proposals with rollback records.
- [ ] Save generated practice papers under `wiki/papers/`.
- [ ] Save flashcards under `wiki/flashcards/`, and add archive/restore endpoints.
- [ ] Save weekly/monthly/semester report versions under their report folders.
- [ ] Verify all generated Markdown links back to source events and knowledge pages.

### Task 6: Integration and Runtime Sync

**Files:**
- Modify: `focuslens-api/README.md`
- Modify: `README.md`

- [ ] Run backend unit and API regression tests.
- [ ] Run frontend production build.
- [ ] Copy changed frontend/backend files to `D:\adhd\focuslens-v2` and `D:\adhd\focuslens-api`.
- [ ] Restart port 8012 and verify health, event APIs, Tutor stream, and final-answer reveal.
- [ ] Confirm `.env`, database files, generated Wiki files, images, and audio remain ignored by Git.
