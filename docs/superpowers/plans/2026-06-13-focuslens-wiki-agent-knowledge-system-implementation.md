# FocusLens V2 Wiki Agent Knowledge System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current conversation-shaped Wiki with a Markdown-first, evidence-backed knowledge system that supports safe ingest, atomic knowledge pages, actionable weak-point graphs, reviewed Agent organization, and validated learning artifacts.

**Architecture:** Keep Tutor answering fast and append-only, then process completed learning events through an asynchronous ingest service. Move Wiki responsibilities out of `main.py` into focused stores and services; expose compatible FastAPI routes while the React Wiki workspace is replaced by five focused views. All Agent changes are planned as structured operations, reviewed by the user, and executed inside snapshot-backed transactions.

**Tech Stack:** Python 3, FastAPI, Pydantic, SQLAlchemy/SQLite, Markdown with JSON frontmatter, React 19, TypeScript, Vite, KaTeX, Canvas-based graph rendering, unittest, Vitest, Playwright/browser verification.

---

## Delivery Strategy

This specification spans several independently testable subsystems. Implement it as five consecutive milestones. Each milestone must leave FocusLens runnable and must be committed independently:

1. **Evidence and atomic knowledge foundation**
2. **Wiki APIs, inbox, trash, transactions, and ingest**
3. **Five-view Wiki workspace and actionable graph**
4. **Reviewed three-round Agent organizer**
5. **Validated papers, flashcards, reports, runtime sync, and regression**

Do not remove legacy Wiki routes until the replacement routes and frontend have passed regression testing.

## File Responsibility Map

### Backend files to create

- `focuslens-api/wiki_models.py`: Pydantic/domain types, enums, operation schemas, and artifact schemas.
- `focuslens-api/wiki_markdown.py`: Markdown frontmatter parsing/rendering and stable internal-link helpers.
- `focuslens-api/wiki_store.py`: atomic file access, page lookup, archive, trash, snapshots, changelog, and transactions.
- `focuslens-api/wiki_ingest.py`: completed-event ingest, classification confidence handling, deduplication, evidence archive, and knowledge updates.
- `focuslens-api/wiki_graph.py`: cached weak/full graph construction and actionable insight summaries.
- `focuslens-api/wiki_agent.py`: bounded three-round Agent planning, tool whitelist, operation validation, and execution orchestration.
- `focuslens-api/wiki_artifacts.py`: structured artifact validation and Markdown template rendering.
- `focuslens-api/wiki_routes.py`: focused FastAPI router for new Wiki APIs.
- `focuslens-api/test_wiki_markdown.py`
- `focuslens-api/test_wiki_store.py`
- `focuslens-api/test_wiki_ingest.py`
- `focuslens-api/test_wiki_graph.py`
- `focuslens-api/test_wiki_agent.py`
- `focuslens-api/test_wiki_artifacts.py`
- `focuslens-api/test_wiki_routes.py`

### Backend files to modify

- `focuslens-api/event_store.py`: move completed events into the new evidence lifecycle without breaking follow-ups.
- `focuslens-api/main.py`: mount the Wiki router, call lightweight ingest after Tutor completion, and retain legacy compatibility wrappers.
- `focuslens-api/test_event_store.py`: verify follow-up and evidence behavior.
- `focuslens-api/test_main.py`: regression coverage for Tutor and legacy Wiki compatibility.
- `focuslens-api/README.md`: document Wiki directories, transactions, and Agent behavior.

### Frontend files to create

- `focuslens-v2/src/wiki/types.ts`: Wiki-specific UI/API types.
- `focuslens-v2/src/wiki/api.ts`: Wiki API client isolated from Tutor API.
- `focuslens-v2/src/wiki/WikiWorkspace.tsx`: five-view Wiki shell.
- `focuslens-v2/src/wiki/WeakDiagnosisView.tsx`: graph filters, Canvas graph, and action drawer.
- `focuslens-v2/src/wiki/KnowledgeBrowserView.tsx`: collapsible tree, wide Markdown reader, and property drawer.
- `focuslens-v2/src/wiki/InboxView.tsx`: editable review cards and field locking.
- `focuslens-v2/src/wiki/OrganizerView.tsx`: Agent scope, current-run instruction, operation diff review, execute, and undo.
- `focuslens-v2/src/wiki/MaterialsView.tsx`: papers, flashcards, and reports.
- `focuslens-v2/src/wiki/wiki.css`: Wiki-only layout and responsive styles.
- `focuslens-v2/src/wiki/*.test.tsx`: focused Vitest tests for pure transforms and interaction-critical views.

### Frontend files to modify

- `focuslens-v2/src/main.tsx`: replace embedded Wiki implementation with `WikiWorkspace`.
- `focuslens-v2/src/api.ts`: retain non-Wiki API calls and remove migrated Wiki functions after compatibility verification.
- `focuslens-v2/src/types.ts`: retain shared Tutor types; re-export Wiki types temporarily.
- `focuslens-v2/src/markdown.ts`: resolve stable `wiki://<page-id>` links through callbacks.
- `focuslens-v2/src/styles.css`: remove superseded Wiki rules after visual verification.
- `focuslens-v2/package.json`: add Vitest and React Testing Library.

---

### Task 1: Define Stable Wiki Domain Types

**Files:**
- Create: `focuslens-api/wiki_models.py`
- Create: `focuslens-api/test_wiki_markdown.py`
- Create: `focuslens-v2/src/wiki/types.ts`
- Modify: `focuslens-v2/src/types.ts`

- [ ] **Step 1: Write a failing backend schema test**

```python
# focuslens-api/test_wiki_markdown.py
import unittest
from pydantic import ValidationError

from wiki_models import KnowledgePageMeta, MasteryState, WikiOperation


class WikiModelTests(unittest.TestCase):
    def test_knowledge_page_requires_stable_id_and_short_title(self):
        meta = KnowledgePageMeta(
            id="kp_math_7f31",
            subject="数学",
            chapter="数与代数",
            short_title="分数裂项",
            full_title="分数裂项相消求和",
        )
        self.assertEqual(meta.mastery_state, MasteryState.PENDING_VERIFICATION)

    def test_operation_rejects_unknown_tool(self):
        with self.assertRaises(ValidationError):
            WikiOperation(id="op-1", tool="overwrite_filesystem", reason="bad", before={}, after={})
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
cd focuslens-api
python -m unittest -v test_wiki_markdown.py
```

Expected: `ModuleNotFoundError: No module named 'wiki_models'`.

- [ ] **Step 3: Implement the shared backend domain types**

```python
# focuslens-api/wiki_models.py
from enum import StrEnum
from typing import Any, Literal
from pydantic import BaseModel, Field


class MasteryState(StrEnum):
    PENDING_VERIFICATION = "pending_verification"
    WEAK = "weak"
    LEARNING = "learning"
    PENDING_RETEST = "pending_retest"
    MASTERED = "mastered"


class KnowledgePageMeta(BaseModel):
    id: str = Field(pattern=r"^kp_[a-z0-9_]+$")
    subject: str
    chapter: str
    short_title: str = Field(min_length=1, max_length=20)
    full_title: str
    mastery_state: MasteryState = MasteryState.PENDING_VERIFICATION
    manual_fields: set[str] = Field(default_factory=set)
    locked_fields: set[str] = Field(default_factory=set)
    prerequisites: list[str] = Field(default_factory=list)
    related: list[str] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)


AllowedTool = Literal[
    "create_page", "update_fields", "merge_pages", "move_page",
    "add_links", "remove_links", "archive_evidence", "trash_page",
]


class WikiOperation(BaseModel):
    id: str
    tool: AllowedTool
    reason: str
    risk: Literal["low", "medium", "high"] = "low"
    before: dict[str, Any] = Field(default_factory=dict)
    after: dict[str, Any] = Field(default_factory=dict)
    conflicts: list[str] = Field(default_factory=list)
    selected: bool = True
```

- [ ] **Step 4: Add matching frontend types**

```ts
// focuslens-v2/src/wiki/types.ts
export type MasteryState =
  | "pending_verification"
  | "weak"
  | "learning"
  | "pending_retest"
  | "mastered";

export type WikiView = "diagnosis" | "library" | "inbox" | "organizer" | "materials";

export type WikiOperation = {
  id: string;
  tool: "create_page" | "update_fields" | "merge_pages" | "move_page" |
    "add_links" | "remove_links" | "archive_evidence" | "trash_page";
  reason: string;
  risk: "low" | "medium" | "high";
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  conflicts: string[];
  selected: boolean;
};
```

Temporarily re-export these types from `focuslens-v2/src/types.ts` so existing imports continue to build.

- [ ] **Step 5: Run tests and frontend build**

Run:

```powershell
cd focuslens-api
python -m unittest -v test_wiki_markdown.py
cd ..\focuslens-v2
npm.cmd run build
```

Expected: backend test passes and Vite build succeeds.

- [ ] **Step 6: Commit**

```powershell
git add focuslens-api/wiki_models.py focuslens-api/test_wiki_markdown.py focuslens-v2/src/wiki/types.ts focuslens-v2/src/types.ts
git commit -m "feat: define stable Wiki domain types"
```

---

### Task 2: Implement Markdown Rendering and Stable Links

**Files:**
- Create: `focuslens-api/wiki_markdown.py`
- Modify: `focuslens-api/test_wiki_markdown.py`
- Modify: `focuslens-v2/src/markdown.ts`

- [ ] **Step 1: Add failing Markdown round-trip and link tests**

```python
from wiki_markdown import parse_page, render_knowledge_page, wiki_link
from wiki_models import KnowledgePageMeta


def test_knowledge_page_round_trip():
    meta = KnowledgePageMeta(
        id="kp_math_7f31",
        subject="数学",
        chapter="数与代数",
        short_title="分数裂项",
        full_title="分数裂项相消求和",
    )
    markdown = render_knowledge_page(meta, {"核心概念": "相邻项相消。"})
    parsed_meta, sections = parse_page(markdown)
    assert parsed_meta["id"] == "kp_math_7f31"
    assert sections["核心概念"] == "相邻项相消。"
    assert wiki_link(meta.id, meta.short_title) == "[[wiki://kp_math_7f31|分数裂项]]"
```

- [ ] **Step 2: Run the test and verify missing functions fail**

Run: `python -m unittest -v test_wiki_markdown.py`

Expected: import or attribute failure for `wiki_markdown`.

- [ ] **Step 3: Implement deterministic Markdown helpers**

```python
# focuslens-api/wiki_markdown.py
import json
import re
from typing import Any
from wiki_models import KnowledgePageMeta


def wiki_link(page_id: str, label: str) -> str:
    return f"[[wiki://{page_id}|{label}]]"


def render_knowledge_page(meta: KnowledgePageMeta, sections: dict[str, str]) -> str:
    body = ["---json", meta.model_dump_json(indent=2), "---", "", f"# {meta.full_title}", ""]
    for heading in ["核心概念", "常见错因", "解题方法", "前置知识", "相关知识", "学习证据", "掌握验证"]:
        body.extend([f"## {heading}", "", sections.get(heading, ""), ""])
    return "\n".join(body)


def parse_page(markdown: str) -> tuple[dict[str, Any], dict[str, str]]:
    frontmatter = re.match(r"^---json\r?\n(.*?)\r?\n---\r?\n", markdown, re.S)
    if not frontmatter:
        raise ValueError("Wiki page is missing JSON frontmatter.")
    sections = {
        match.group(1): match.group(2).strip()
        for match in re.finditer(r"^## (.+?)\r?\n\r?\n(.*?)(?=^## |\Z)", markdown, re.M | re.S)
    }
    return json.loads(frontmatter.group(1)), sections
```

- [ ] **Step 4: Make frontend Markdown links route by stable page ID**

In `focuslens-v2/src/markdown.ts`, convert `[[wiki://page-id|label]]` into anchors with `data-wiki-page-id="page-id"`. Keep external HTTPS links unchanged.

```ts
const wikiLink = /\[\[wiki:\/\/([^|\]]+)\|([^\]]+)\]\]/g;
source = source.replace(wikiLink, (_match, pageId, label) =>
  `[${label}](wiki://${encodeURIComponent(pageId)})`
);
```

- [ ] **Step 5: Run tests and build**

Run:

```powershell
cd focuslens-api
python -m unittest -v test_wiki_markdown.py
cd ..\focuslens-v2
npm.cmd run build
```

- [ ] **Step 6: Commit**

```powershell
git add focuslens-api/wiki_markdown.py focuslens-api/test_wiki_markdown.py focuslens-v2/src/markdown.ts
git commit -m "feat: add stable Wiki Markdown format"
```

---

### Task 3: Build Atomic Wiki Store, Trash, Snapshots, and Transactions

**Files:**
- Create: `focuslens-api/wiki_store.py`
- Create: `focuslens-api/test_wiki_store.py`

- [ ] **Step 1: Write failing store transaction tests**

```python
# focuslens-api/test_wiki_store.py
import tempfile
import unittest
from pathlib import Path
from wiki_store import WikiStore


class WikiStoreTests(unittest.TestCase):
    def test_transaction_can_rollback_and_trash_is_reversible(self):
        with tempfile.TemporaryDirectory() as temp:
            store = WikiStore(Path(temp))
            store.write_page("knowledge/math/a/kp_math_1.md", "# Original")
            tx = store.begin_transaction("organize")
            tx.write_page("knowledge/math/a/kp_math_1.md", "# Changed")
            tx.trash_page("knowledge/math/a/kp_math_1.md")
            tx.rollback()
            self.assertEqual(store.read_page("knowledge/math/a/kp_math_1.md"), "# Original")
            self.assertFalse(any(store.trash_dir.rglob("*.md")))
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `python -m unittest -v test_wiki_store.py`

Expected: missing `wiki_store`.

- [ ] **Step 3: Implement atomic store and transaction primitives**

Implement `WikiStore.write_page`, `read_page`, `find_page_by_id`, and `begin_transaction`, plus `WikiTransaction.write_page`, `move_page`, `trash_page`, `commit`, and `rollback`.

The exact write algorithm is:

```python
def atomic_write(path: Path, markdown: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(markdown)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
```

Snapshot every touched path before the first change. `commit` writes the selected operation list to `changelog/<transaction-id>.md`; `rollback` restores each snapshot and removes files created by the transaction.

- [ ] **Step 4: Add path-containment tests**

Verify `../outside.md`, absolute paths, and paths outside `wiki_dir` raise `ValueError`.

- [ ] **Step 5: Run the store tests**

Run: `python -m unittest -v test_wiki_store.py`

Expected: all store, containment, rollback, and trash tests pass.

- [ ] **Step 6: Commit**

```powershell
git add focuslens-api/wiki_store.py focuslens-api/test_wiki_store.py
git commit -m "feat: add transactional Wiki store"
```

---

### Task 4: Migrate Learning Events into Evidence Archive

**Files:**
- Modify: `focuslens-api/event_store.py`
- Modify: `focuslens-api/test_event_store.py`
- Modify: `focuslens-api/wiki_models.py`

- [ ] **Step 1: Add failing evidence lifecycle tests**

```python
def test_ingested_event_moves_to_evidence_without_losing_followups(self):
    draft = self.store.create_draft(
        interaction_mode="vision",
        original_question="第33题怎么做",
        grade="四年级",
    )
    self.store.complete(draft.id, {"subject": "数学", "answer_markdown": "步骤", "knowledge_point": "分数裂项"})
    self.store.append_follow_up(draft.id, "为什么裂项", "为了相消")

    archived = self.store.archive_as_evidence(draft.id, ["kp_math_7f31"])

    self.assertEqual(archived.write_status, "archived")
    self.assertEqual(archived.related_knowledge, ["kp_math_7f31"])
    self.assertEqual(len(archived.follow_ups), 1)
    self.assertTrue(self.store._find_path(draft.id).as_posix().find("/evidence/") >= 0)
```

- [ ] **Step 2: Run the failing test**

Run: `python -m unittest -v test_event_store.py`

Expected: `EventStore` has no `archive_as_evidence`.

- [ ] **Step 3: Implement the evidence archive move**

Add `evidence_dir`, make `_find_path` search drafts/events and evidence, and add:

```python
def archive_as_evidence(self, event_id_value: str, knowledge_ids: list[str]) -> LearningEvent:
    event = self.get(event_id_value)
    event.write_status = "archived"
    event.related_knowledge = sorted(set([*event.related_knowledge, *knowledge_ids]))
    source = self._find_path(event.id)
    target = self.evidence_dir / datetime.fromisoformat(event.created_at).strftime("%Y/%m") / source.name
    self._atomic_write(target, render_event_markdown(event))
    source.unlink(missing_ok=True)
    return event
```

- [ ] **Step 4: Preserve follow-up semantics**

Verify `append_follow_up` can update an archived evidence file and never creates a second event.

- [ ] **Step 5: Run tests**

Run: `python -m unittest -v test_event_store.py test_main.py`

- [ ] **Step 6: Commit**

```powershell
git add focuslens-api/event_store.py focuslens-api/test_event_store.py focuslens-api/wiki_models.py
git commit -m "feat: archive learning events as Wiki evidence"
```

---

### Task 5: Implement Lightweight Ingest and Deduplication

**Files:**
- Create: `focuslens-api/wiki_ingest.py`
- Create: `focuslens-api/test_wiki_ingest.py`
- Modify: `focuslens-api/main.py`

- [ ] **Step 1: Write failing ingest tests**

Cover these concrete assertions:

- `test_followup_updates_existing_knowledge_instead_of_creating_duplicate`: ingest an event and a follow-up decision pointing to the same page ID; assert one knowledge file exists and the evidence list contains one event ID.
- `test_high_confidence_new_subject_is_created`: ingest a `0.95` confidence science decision; assert `subjects/science/index.md` and the knowledge page exist.
- `test_low_confidence_classification_goes_to_inbox`: ingest a `0.55` confidence decision; assert no knowledge file exists and one `inbox/pending_*.md` file exists.
- `test_manual_and_locked_fields_are_not_overwritten`: mark `chapter` manual and `full_title` locked; ingest conflicting AI values and assert both original values remain.
- `test_same_concept_merges_only_with_high_confidence`: submit `0.93` and `0.70` similarity matches; assert the first merges and the second enters the inbox.

Use deterministic fake classifier results; do not call a real AI service in unit tests.

- [ ] **Step 2: Run tests and verify missing ingest service fails**

Run: `python -m unittest -v test_wiki_ingest.py`

- [ ] **Step 3: Implement the ingest decision model**

```python
# focuslens-api/wiki_ingest.py
class IngestDecision(BaseModel):
    confidence: float
    subject: str
    chapter: str
    short_title: str
    full_title: str
    existing_page_id: str = ""
    independent_concept: bool = False
    common_reasons: list[str] = Field(default_factory=list)
    prerequisites: list[str] = Field(default_factory=list)


class WikiIngestService:
    def ingest_event(self, event: LearningEvent, decision: IngestDecision) -> IngestResult:
        if decision.confidence < self.auto_ingest_threshold:
            return self.create_inbox_item(event, decision)
        if decision.existing_page_id:
            return self.update_existing(event, decision)
        return self.create_knowledge(event, decision)
```

Ensure follow-up-derived candidates require `independent_concept=True`; otherwise they only enrich the existing event and knowledge page.

- [ ] **Step 4: Trigger ingest after Tutor completion without blocking response**

In `main.py`, call the ingest service only after the completed Tutor response has been saved. Use FastAPI `BackgroundTasks` or the existing post-response mechanism. Failure must be logged and must not turn a successful Tutor response into an error.

- [ ] **Step 5: Run backend regression**

Run:

```powershell
cd focuslens-api
python -m unittest -v test_wiki_ingest.py test_event_store.py test_main.py
python -m py_compile main.py wiki_models.py wiki_markdown.py wiki_store.py wiki_ingest.py
```

- [ ] **Step 6: Commit**

```powershell
git add focuslens-api/wiki_ingest.py focuslens-api/test_wiki_ingest.py focuslens-api/main.py
git commit -m "feat: add lightweight Wiki ingest"
```

---

### Task 6: Build New Wiki Page, Inbox, Trash, and Transaction APIs

**Files:**
- Create: `focuslens-api/wiki_routes.py`
- Create: `focuslens-api/test_wiki_routes.py`
- Modify: `focuslens-api/main.py`

- [ ] **Step 1: Write failing FastAPI route tests**

Use `TestClient` and temporary Wiki directories to verify:

- patching a locked field returns HTTP 409 and leaves the Markdown unchanged;
- deleting a page returns HTTP 200, removes the source, and creates a trash entry;
- confirming an inbox item creates a knowledge page and archives its evidence;
- rerunning an inbox item updates recommendations without changing locked user edits;
- undoing a committed transaction restores the exact previous Markdown.

- [ ] **Step 2: Run tests and verify routes return 404**

Run: `python -m unittest -v test_wiki_routes.py`

- [ ] **Step 3: Implement the focused router**

Create routes:

```python
router = APIRouter(prefix="/api/wiki", tags=["wiki"])

@router.get("/pages")
@router.get("/pages/{page_id}")
@router.patch("/pages/{page_id}")
@router.delete("/pages/{page_id}")
@router.get("/inbox")
@router.post("/inbox/{item_id}/confirm")
@router.post("/inbox/{item_id}/rerun")
@router.delete("/inbox/{item_id}")
@router.post("/transactions/{transaction_id}/undo")
```

All writes must use `WikiStore` transactions. `PATCH` must reject changes to locked fields unless the request explicitly unlocks them first.

- [ ] **Step 4: Mount the router and keep legacy wrappers**

In `main.py`:

```python
app.include_router(create_wiki_router(wiki_store, ingest_service))
```

Keep existing `/api/wiki/pages`, `/api/wiki/graph`, `/api/wiki/query`, `/api/wiki/flashcards`, and `/api/wiki/report` operational until later tasks replace their callers.

- [ ] **Step 5: Run tests**

Run: `python -m unittest -v test_wiki_routes.py test_main.py test_event_store.py test_wiki_ingest.py`

- [ ] **Step 6: Commit**

```powershell
git add focuslens-api/wiki_routes.py focuslens-api/test_wiki_routes.py focuslens-api/main.py
git commit -m "feat: expose transactional Wiki APIs"
```

---

### Task 7: Build Actionable Weak and Full Graphs

**Files:**
- Create: `focuslens-api/wiki_graph.py`
- Create: `focuslens-api/test_wiki_graph.py`
- Modify: `focuslens-api/wiki_routes.py`
- Modify: `focuslens-api/main.py`

- [ ] **Step 1: Write failing graph tests**

Add tests with these exact expectations:

- weak graph node types are limited to `subject/chapter/knowledge/prerequisite`;
- full graph includes mastered knowledge;
- selecting `subject=数学` returns no English nodes;
- every actionable weak knowledge node has non-empty `why` and `nextAction`;
- knowledge graph labels equal `short_title`, not `full_title`;
- trashing the only evidence changes the knowledge evidence count from one to zero.

- [ ] **Step 2: Run failing graph tests**

Run: `python -m unittest -v test_wiki_graph.py`

- [ ] **Step 3: Implement graph service and cache**

Implement `WikiGraphService.build(mode, subject, date_range)` to return `WikiGraphResponse`, and `invalidate(page_ids)` to remove cache entries whose dependency set intersects `page_ids`. Cache keys must include graph mode, subject, and date range.

Weak graph rules:

- Include subject, chapter, weak/learning/pending-retest knowledge, and necessary prerequisites.
- Exclude evidence, raw mistakes, reasons, and mastered knowledge by default.
- Use `short_title` for labels.
- Generate action summaries with `why`, `recent_evidence`, `review_first`, and `next_action`.

- [ ] **Step 4: Replace graph route**

Support:

```text
GET /api/wiki/graph?mode=weak&subject=数学&dateRange=30d
GET /api/wiki/graph?mode=full
```

- [ ] **Step 5: Run graph and route tests**

Run: `python -m unittest -v test_wiki_graph.py test_wiki_routes.py test_main.py`

- [ ] **Step 6: Commit**

```powershell
git add focuslens-api/wiki_graph.py focuslens-api/test_wiki_graph.py focuslens-api/wiki_routes.py focuslens-api/main.py
git commit -m "feat: build actionable Wiki graphs"
```

---

### Task 8: Extract the Frontend Wiki API and Workspace Shell

**Files:**
- Create: `focuslens-v2/src/wiki/api.ts`
- Create: `focuslens-v2/src/wiki/WikiWorkspace.tsx`
- Create: `focuslens-v2/src/wiki/wiki.css`
- Modify: `focuslens-v2/src/main.tsx`
- Modify: `focuslens-v2/src/api.ts`
- Modify: `focuslens-v2/package.json`

- [ ] **Step 1: Add Vitest dependencies and a failing workspace test**

Add:

```json
"scripts": {
  "test": "vitest run"
},
"devDependencies": {
  "@testing-library/react": "^16.1.0",
  "@testing-library/jest-dom": "^6.6.3",
  "jsdom": "^26.0.0",
  "vitest": "^3.2.4"
}
```

Create a test verifying the five views exist and switching views does not remount the whole app.

- [ ] **Step 2: Run the test and verify missing workspace fails**

Run:

```powershell
cd focuslens-v2
npm.cmd test
```

- [ ] **Step 3: Implement isolated Wiki API client**

`focuslens-v2/src/wiki/api.ts` must expose `fetchWikiPages`, `fetchWikiPage`, `patchWikiPage`, `trashWikiPage`, `fetchWikiInbox`, `confirmWikiInboxItem`, `rerunWikiInboxItem`, `fetchWikiGraph`, `planWikiOrganization`, `executeWikiOrganization`, and `undoWikiOrganization`. Each function must call `safeFetch`, check `res.ok`, convert API error bodies with `readApiError`, and return its declared Wiki type.

Reuse the existing safe-fetch and error-message behavior; do not expose API keys in Wiki URLs or logs.

- [ ] **Step 4: Implement the five-view shell**

```tsx
const views = [
  ["diagnosis", "薄弱诊断"],
  ["library", "知识库"],
  ["inbox", "待确认箱"],
  ["organizer", "AI 整理"],
  ["materials", "学习材料"],
] as const;
```

`WikiWorkspace` owns Wiki-specific loading and selection state. `main.tsx` passes only `baseUrl`, AI config/profile, and an error callback.

- [ ] **Step 5: Replace the embedded Wiki page**

Remove `WikiPageView` usage from `main.tsx` and render:

```tsx
<WikiWorkspace
  baseUrl={aiConfig.baseUrl}
  aiConfig={aiConfig}
  profile={profile}
  onError={setError}
/>
```

Do not delete old helper functions until all replacement views build.

- [ ] **Step 6: Run tests and build**

Run:

```powershell
npm.cmd test
npm.cmd run build
```

- [ ] **Step 7: Commit**

```powershell
git add focuslens-v2/package.json focuslens-v2/package-lock.json focuslens-v2/src/wiki focuslens-v2/src/main.tsx focuslens-v2/src/api.ts
git commit -m "feat: add focused Wiki workspace shell"
```

---

### Task 9: Implement Knowledge Browser and Inbox Review Views

**Files:**
- Create: `focuslens-v2/src/wiki/KnowledgeBrowserView.tsx`
- Create: `focuslens-v2/src/wiki/InboxView.tsx`
- Create: `focuslens-v2/src/wiki/KnowledgeBrowserView.test.tsx`
- Create: `focuslens-v2/src/wiki/InboxView.test.tsx`
- Modify: `focuslens-v2/src/wiki/WikiWorkspace.tsx`
- Modify: `focuslens-v2/src/wiki/wiki.css`
- Modify: `focuslens-v2/src/markdown.ts`

- [ ] **Step 1: Write failing browser and inbox interaction tests**

Verify:

- all subjects render in the collapsible tree;
- Markdown reader uses remaining width while property drawer is closed;
- `wiki://` links call `onOpenPage(pageId)`;
- inbox cards allow subject/chapter/title edits;
- locked fields cannot be overwritten by a rerun response;
- confirm, merge, delete, ignore, and rerun buttons call correct APIs.

- [ ] **Step 2: Run tests and verify missing views fail**

Run: `npm.cmd test -- KnowledgeBrowserView InboxView`

- [ ] **Step 3: Implement the wide knowledge browser**

Layout:

```tsx
<section className="wiki-library-layout">
  <WikiTree />
  <WikiMarkdownReader />
  {propertyDrawerOpen && <WikiPropertyDrawer />}
</section>
```

Use CSS grid `minmax(240px, 300px) minmax(0, 1fr)` and add the third column only when the drawer opens.

- [ ] **Step 4: Implement editable inbox cards**

Each card must expose:

- original question and student voice text;
- answer summary;
- subject, chapter, short title, full title;
- core concept, common reason, prerequisite, mastery suggestion;
- lock toggle per editable field;
- confirm, merge, save, rerun, ignore, and delete actions.

- [ ] **Step 5: Run frontend tests and build**

Run:

```powershell
npm.cmd test
npm.cmd run build
```

- [ ] **Step 6: Commit**

```powershell
git add focuslens-v2/src/wiki/KnowledgeBrowserView.tsx focuslens-v2/src/wiki/InboxView.tsx focuslens-v2/src/wiki/*.test.tsx focuslens-v2/src/wiki/WikiWorkspace.tsx focuslens-v2/src/wiki/wiki.css focuslens-v2/src/markdown.ts
git commit -m "feat: add Wiki library and review inbox"
```

---

### Task 10: Implement Stable and Free Graph Views with Action Drawer

**Files:**
- Create: `focuslens-v2/src/wiki/WeakDiagnosisView.tsx`
- Create: `focuslens-v2/src/wiki/WeakDiagnosisView.test.tsx`
- Modify: `focuslens-v2/src/wiki/WikiWorkspace.tsx`
- Modify: `focuslens-v2/src/wiki/wiki.css`

- [ ] **Step 1: Write failing graph view tests**

Verify:

- default graph mode is weak/stable;
- subject filters do not mix visible subjects;
- labels use short titles;
- selecting a node opens the action drawer;
- drawer uses “为什么需要复习 / 最近在哪里出错 / 建议先复习什么 / 下一步行动”;
- switching stable/free modes preserves the selected subject and node.

- [ ] **Step 2: Run tests**

Run: `npm.cmd test -- WeakDiagnosisView`

- [ ] **Step 3: Implement stable layered Canvas graph**

Use a Canvas component with deterministic subject/section layers. Keep a small DOM overlay for readable labels and keyboard selection. Do not introduce Three.js.

- [ ] **Step 4: Implement free force-mode toggle**

Reuse the same graph data and filters. The free mode may use the existing force-layout logic, but must limit labels by zoom and selected neighborhood to prevent visual clutter.

- [ ] **Step 5: Add action drawer**

The drawer must preserve graph zoom and pan state and provide:

- concise title and full title;
- mastery state;
- why review;
- recent evidence;
- review-first prerequisite;
- next action;
- open full Wiki page;
- edit classification and lock fields.

- [ ] **Step 6: Run tests and visual build**

Run:

```powershell
npm.cmd test
npm.cmd run build
```

Then use the Browser plugin at `http://127.0.0.1:5173` to verify the graph at desktop and narrow widths.

- [ ] **Step 7: Commit**

```powershell
git add focuslens-v2/src/wiki/WeakDiagnosisView.tsx focuslens-v2/src/wiki/WeakDiagnosisView.test.tsx focuslens-v2/src/wiki/WikiWorkspace.tsx focuslens-v2/src/wiki/wiki.css
git commit -m "feat: add actionable Wiki diagnosis graph"
```

---

### Task 11: Implement Bounded Agent Planning and Operation Validation

**Files:**
- Create: `focuslens-api/wiki_agent.py`
- Create: `focuslens-api/test_wiki_agent.py`
- Modify: `focuslens-api/wiki_models.py`
- Modify: `focuslens-api/wiki_routes.py`

- [ ] **Step 1: Write failing Agent safety tests**

Cover these assertions:

- a fake model that always returns an invalid plan is called exactly three times;
- an unknown tool fails schema validation;
- a locked-field update becomes a conflict and is not executable;
- incremental mode reads only changed pages and directly linked neighbors;
- full mode is rejected unless the request explicitly contains `mode="full"`;
- the current-run instruction appears in the run log but not in knowledge pages;
- planning leaves all Wiki file hashes unchanged.

Use a fake model adapter that returns predetermined structured operations.

- [ ] **Step 2: Run tests and verify missing Agent fails**

Run: `python -m unittest -v test_wiki_agent.py`

- [ ] **Step 3: Implement the bounded Agent loop**

```python
class WikiAgent:
    MAX_ROUNDS = 3

    async def plan(self, request: OrganizePlanRequest) -> OrganizePlan:
        state = self.scan_scope(request)
        for round_number in range(1, self.MAX_ROUNDS + 1):
            response = await self.model.propose(state)
            operations = self.validator.validate(response.operations, state)
            validation = self.validate_plan(operations)
            if validation.ok:
                return OrganizePlan(
                    run_id=state.run_id,
                    rounds=round_number,
                    operations=operations,
                    conflicts=validation.conflicts,
                    source_hashes=state.source_hashes,
                    estimated_cost_usd=state.estimated_cost_usd,
                )
            state = state.with_validation_feedback(validation)
        raise AgentPlanError("三轮内未生成可安全执行的整理计划。")
```

The Agent may only propose tools listed in `AllowedTool`. It cannot execute writes during planning.

- [ ] **Step 4: Implement incremental scan metadata**

Store content hash and last organized transaction ID in the database/index. The default scan includes changed pages, inbox items, and directly affected neighbors. Full scan requires `mode="full"`.

- [ ] **Step 5: Add plan route**

```text
POST /api/wiki/organize/plan
```

Return operations with before/after values, reason, risk, conflicts, estimated cost, and selected state.

- [ ] **Step 6: Run tests**

Run: `python -m unittest -v test_wiki_agent.py test_wiki_routes.py`

- [ ] **Step 7: Commit**

```powershell
git add focuslens-api/wiki_agent.py focuslens-api/test_wiki_agent.py focuslens-api/wiki_models.py focuslens-api/wiki_routes.py
git commit -m "feat: add bounded Wiki organization Agent"
```

---

### Task 12: Execute Reviewed Agent Operations and Add Undo

**Files:**
- Modify: `focuslens-api/wiki_agent.py`
- Modify: `focuslens-api/wiki_routes.py`
- Modify: `focuslens-api/test_wiki_agent.py`
- Create: `focuslens-v2/src/wiki/OrganizerView.tsx`
- Create: `focuslens-v2/src/wiki/OrganizerView.test.tsx`
- Modify: `focuslens-v2/src/wiki/WikiWorkspace.tsx`
- Modify: `focuslens-v2/src/wiki/wiki.css`

- [ ] **Step 1: Add failing reviewed-execution tests**

Backend tests must verify:

- only selected operations execute;
- stale plans are rejected if source hashes changed;
- protected fields remain unchanged;
- commit writes snapshot and changelog;
- any failed operation rolls back the entire transaction;
- undo restores the prior Wiki.

Frontend tests must verify:

- current-run instruction is submitted;
- operation cards show before/after differences;
- operations can be unchecked;
- execute and undo buttons call correct APIs.

- [ ] **Step 2: Run tests and verify failures**

Run:

```powershell
cd focuslens-api
python -m unittest -v test_wiki_agent.py
cd ..\focuslens-v2
npm.cmd test -- OrganizerView
```

- [ ] **Step 3: Implement reviewed execution**

Add:

```text
POST /api/wiki/organize/execute
POST /api/wiki/organize/undo
GET  /api/wiki/organize/runs/{runId}
```

Execute operations using a single `WikiTransaction`. Revalidate selected operations immediately before execution.

- [ ] **Step 4: Implement Organizer view**

The view must show:

- incremental/full scope;
- subject and date filters;
- “本次整理意见” input;
- up to three Agent stages;
- operation groups;
- before/after diff;
- reason, risk, conflicts, estimated cost;
- per-operation checkboxes;
- execute and undo.

- [ ] **Step 5: Run tests and build**

Run:

```powershell
cd focuslens-api
python -m unittest -v test_wiki_agent.py test_wiki_routes.py
cd ..\focuslens-v2
npm.cmd test
npm.cmd run build
```

- [ ] **Step 6: Commit**

```powershell
git add focuslens-api/wiki_agent.py focuslens-api/wiki_routes.py focuslens-api/test_wiki_agent.py focuslens-v2/src/wiki/OrganizerView.tsx focuslens-v2/src/wiki/OrganizerView.test.tsx focuslens-v2/src/wiki/WikiWorkspace.tsx focuslens-v2/src/wiki/wiki.css
git commit -m "feat: review and execute Wiki Agent changes"
```

---

### Task 13: Generate Validated Papers, Flashcards, and Reports

**Files:**
- Create: `focuslens-api/wiki_artifacts.py`
- Create: `focuslens-api/test_wiki_artifacts.py`
- Modify: `focuslens-api/wiki_routes.py`
- Modify: `focuslens-api/wiki_models.py`
- Create: `focuslens-v2/src/wiki/MaterialsView.tsx`
- Create: `focuslens-v2/src/wiki/MaterialsView.test.tsx`
- Modify: `focuslens-v2/src/wiki/WikiWorkspace.tsx`

- [ ] **Step 1: Write failing artifact validation tests**

Cover these assertions:

- a valid paper request creates separate question and answer files;
- a flashcard whose back is only “回顾相关错因” fails validation;
- a report missing evidence summary or next actions fails validation;
- output containing `Thinking Process:` fails validation;
- invalid output leaves the artifact directory unchanged;
- valid artifacts include stable knowledge and evidence links.

- [ ] **Step 2: Run tests and verify missing artifact service fails**

Run: `python -m unittest -v test_wiki_artifacts.py`

- [ ] **Step 3: Implement structured artifact schemas and validators**

```python
class PracticeQuestion(BaseModel):
    prompt_markdown: str
    knowledge_ids: list[str]
    evidence_ids: list[str]
    steps_markdown: str
    final_answer_markdown: str


class FlashcardRecord(BaseModel):
    front_markdown: str = Field(min_length=8)
    back_markdown: str = Field(min_length=8)
    knowledge_ids: list[str]


class StageReport(BaseModel):
    overview: str
    evidence_summary: list[str]
    state_changes: list[str]
    repeated_reasons: list[str]
    review_order: list[str]
    next_actions: list[str]
```

Reject output containing `Thinking Process:`, empty/generic placeholders, missing source IDs, or invalid schemas.

- [ ] **Step 4: Render formal Markdown with local templates**

The model returns structured data only. `wiki_artifacts.py` renders:

- `papers/<id>_paper.md`
- `papers/<id>_answers.md`
- `flashcards/<id>.md`
- `reports/<id>.md`

Do not save partial files when validation fails.

- [ ] **Step 5: Replace artifact routes**

Add:

```text
POST /api/wiki/papers
POST /api/wiki/flashcards
POST /api/wiki/reports
GET  /api/wiki/artifacts
DELETE /api/wiki/artifacts/{pageId}
```

Keep legacy query/report routes as temporary wrappers that call the new artifact service.

- [ ] **Step 6: Implement Materials view**

Show separate sections for papers, flashcard decks, and reports. Support opening, deleting, regenerating, source tracing, answer-file opening, flashcard flip/next/mastery marking.

- [ ] **Step 7: Run tests and build**

Run:

```powershell
cd focuslens-api
python -m unittest -v test_wiki_artifacts.py test_wiki_routes.py
cd ..\focuslens-v2
npm.cmd test
npm.cmd run build
```

- [ ] **Step 8: Commit**

```powershell
git add focuslens-api/wiki_artifacts.py focuslens-api/test_wiki_artifacts.py focuslens-api/wiki_routes.py focuslens-api/wiki_models.py focuslens-v2/src/wiki/MaterialsView.tsx focuslens-v2/src/wiki/MaterialsView.test.tsx focuslens-v2/src/wiki/WikiWorkspace.tsx
git commit -m "feat: generate validated Wiki learning materials"
```

---

### Task 14: Remove Superseded Embedded Wiki Code and Preserve Compatibility

**Files:**
- Modify: `focuslens-api/main.py`
- Modify: `focuslens-api/test_main.py`
- Modify: `focuslens-v2/src/main.tsx`
- Modify: `focuslens-v2/src/api.ts`
- Modify: `focuslens-v2/src/types.ts`
- Modify: `focuslens-v2/src/styles.css`

- [ ] **Step 1: Add compatibility regression tests**

Verify:

- Tutor photo questions still return and save events;
- F9 follow-ups update the selected event;
- legacy mistake list still loads;
- old generated Wiki files remain readable;
- existing `/api/wiki/pages` and `/api/wiki/graph` clients receive compatible responses during migration.

- [ ] **Step 2: Run regression before cleanup**

Run:

```powershell
cd focuslens-api
python -m unittest -v
cd ..\focuslens-v2
npm.cmd test
npm.cmd run build
```

- [ ] **Step 3: Remove superseded embedded implementations**

After confirming new modules own the behavior:

- remove old Wiki graph/action helpers from `main.py`;
- remove old `WikiPageView`, graph, tree, action controls, and flashcard components from `main.tsx`;
- remove migrated Wiki API functions from `src/api.ts`;
- remove superseded Wiki types from `src/types.ts`;
- remove unused Wiki CSS from `src/styles.css`.

Keep small compatibility adapters only where existing non-Wiki pages still depend on them.

- [ ] **Step 4: Run full regression again**

Run the same commands as Step 2. Expected: all tests and build pass with no unused-import TypeScript errors.

- [ ] **Step 5: Commit**

```powershell
git add focuslens-api/main.py focuslens-api/test_main.py focuslens-v2/src/main.tsx focuslens-v2/src/api.ts focuslens-v2/src/types.ts focuslens-v2/src/styles.css
git commit -m "refactor: remove legacy embedded Wiki implementation"
```

---

### Task 15: Documentation, Ignore Rules, Runtime Sync, and End-to-End Verification

**Files:**
- Modify: `focuslens-api/README.md`
- Modify: `README.md`
- Modify: `.gitignore`
- Modify: `focuslens-api/_run.bat`
- Modify: `focuslens-v2/_run.bat`
- Modify: `start.bat`

- [ ] **Step 1: Document the Wiki lifecycle**

Document:

- Markdown directory structure;
- lightweight ingest versus manual Agent organization;
- evidence archive and follow-up behavior;
- snapshots, changelog, trash, and undo;
- new Wiki routes;
- artifact generation;
- generated Wiki files and secrets remaining local.

- [ ] **Step 2: Verify ignore rules**

Ensure `.gitignore` excludes:

```gitignore
focuslens-api/wiki/
focuslens-api/*.db
focuslens-api/.env*
focuslens-v2/.env*
```

Do not ignore source tests, specifications, or empty directory documentation.

- [ ] **Step 3: Run full backend verification**

Run:

```powershell
cd focuslens-api
python -m py_compile main.py event_store.py wiki_models.py wiki_markdown.py wiki_store.py wiki_ingest.py wiki_graph.py wiki_agent.py wiki_artifacts.py wiki_routes.py
python -m unittest -v
```

Expected: all tests pass.

- [ ] **Step 4: Run full frontend verification**

Run:

```powershell
cd focuslens-v2
npm.cmd test
npm.cmd run build
```

Expected: tests and production build pass.

- [ ] **Step 5: Sync source to runtime directories**

Copy only changed source files from:

```text
D:\adhd\adhd-warning\focuslens-api  -> D:\adhd\focuslens-api
D:\adhd\adhd-warning\focuslens-v2   -> D:\adhd\focuslens-v2
```

Do not copy `.env`, database files, generated Wiki files, API keys, audio, screenshots, or node_modules.

- [ ] **Step 6: Restart and verify runtime**

Start with `D:\adhd\adhd-warning\start.bat`, then verify:

```text
GET http://127.0.0.1:8012/health
GET http://127.0.0.1:8012/api/wiki/pages
GET http://127.0.0.1:8012/api/wiki/graph?mode=weak
http://127.0.0.1:5173
```

- [ ] **Step 7: Browser end-to-end acceptance**

Use the Browser plugin to verify:

1. create one photographed Tutor event and one follow-up;
2. confirm follow-up remains in the same event;
3. inspect the inbox and edit/lock a field;
4. confirm ingest and open the atomic knowledge page;
5. view the weak graph without raw event nodes;
6. plan an incremental organization run;
7. uncheck one operation and execute the rest;
8. undo the run;
9. generate and open a paper plus answer file;
10. generate valid flashcards and a stage report;
11. verify no `Thinking Process` text appears;
12. verify internal links open the intended Wiki page.

- [ ] **Step 8: Confirm secrets and generated files are not staged**

Run:

```powershell
git status --short
git check-ignore -v focuslens-api/wiki/index.md focuslens-api/.env focuslens-v2/.env.local
```

Expected: generated Wiki and environment files are ignored and no API key is present in tracked changes.

- [ ] **Step 9: Commit**

```powershell
git add README.md focuslens-api/README.md .gitignore focuslens-api/_run.bat focuslens-v2/_run.bat start.bat
git commit -m "docs: document Wiki Agent knowledge workflow"
```

---

## Plan Self-Review Checklist

- Every confirmed design decision maps to at least one task.
- Tutor response remains independent from Wiki ingest and deep organization.
- Follow-ups update the original event.
- Stable IDs prevent link breakage after rename or move.
- Manual, locked, and curriculum fields are protected.
- New subjects can be created at high confidence; low confidence uses the inbox.
- Agent planning is bounded to three rounds and cannot write directly.
- Agent execution requires reviewed selected operations and uses transactions.
- Incremental organization is default; full organization is explicit.
- Weak graph and full graph are separate modes.
- Formal artifacts are schema-validated and template-rendered.
- Invalid AI output is never saved as a formal artifact.
- Runtime sync excludes secrets and generated local Wiki files.
