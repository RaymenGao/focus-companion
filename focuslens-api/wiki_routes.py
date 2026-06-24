from __future__ import annotations

import os
import platform
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ValidationError

from event_store import EventStore
from wiki_ingest import WikiIngestService, stable_slug, subject_slug
from wiki_graph import WikiGraphService
from wiki_markdown import parse_page, render_knowledge_page
from wiki_models import IngestDecision, KnowledgePageMeta, OrganizePlanRequest, CreatePaperRequest, CreateFlashcardsRequest, CreateReportRequest
from wiki_store import WikiStore
from wiki_agent import WikiAgent, AgentPlanError
from wiki_artifacts import (
    generate_practice_paper,
    generate_flashcards,
    generate_stage_report,
    list_artifacts,
    delete_artifact,
    archive_flashcard_deck,
    normalize_artifact_links,
    ArtifactValidationError
)
from wiki_migration import migrate_legacy_wiki
from wiki_terms import (
    LEGACY_TERM_ID,
    active_term_id,
    create_term,
    load_terms,
    set_active_term,
    set_term_archived,
    term_matches,
)


class WikiPagePatch(BaseModel):
    fields: dict[str, Any] = Field(default_factory=dict)
    unlock_fields: list[str] = Field(default_factory=list)
    sections: dict[str, str] = Field(default_factory=dict)


class InboxRerunRequest(BaseModel):
    decision: IngestDecision
    locked_fields: list[str] = Field(default_factory=list)


class OrganizeExecuteRequest(BaseModel):
    runId: str
    operationIds: list[str] = Field(default_factory=list)


class OrganizeUndoRequest(BaseModel):
    runId: str


class OpenLocalWikiRequest(BaseModel):
    target: str = "wiki"


class OpenLocalWikiPageRequest(BaseModel):
    page_id: str


class CreateTermRequest(BaseModel):
    label: str


class SetActiveTermRequest(BaseModel):
    term_id: str


def knowledge_relative(meta: KnowledgePageMeta) -> str:
    subject = subject_slug(meta.subject)
    chapter = stable_slug(meta.chapter, "chapter")
    return f"knowledge/{subject}/{chapter}/{meta.id}.md"


def open_local_path(path: Path) -> None:
    system = platform.system()
    if system == "Windows":
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif system == "Darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def markdown_ids(markdown: str, scheme: str) -> list[str]:
    return list(dict.fromkeys(__import__("re").findall(rf"\[\[{scheme}://([^|\]]+)\|[^\]]+\]\]", markdown)))


def page_title_from_markdown(markdown: str) -> str:
    match = __import__("re").search(r"(?m)^#\s+(.+)$", markdown)
    return match.group(1).strip() if match else ""


def label_for_page(store: WikiStore, page_id: str, fallback: str = "") -> str:
    try:
        path = store.find_page_by_id(page_id)
        markdown = path.read_text(encoding="utf-8")
        meta, _ = parse_page(markdown)
    except (FileNotFoundError, OSError, ValueError):
        return fallback or page_id
    relative_parts = path.relative_to(store.wiki_dir).parts
    if meta.get("type") in {"legacy_mistake", "evidence"} or "evidence" in relative_parts:
        title = page_title_from_markdown(markdown)
        if title and title != "错题证据":
            return title
        return meta.get("knowledge_point") or Path(str(meta.get("source_path") or "")).stem or fallback or page_id
    return meta.get("short_title") or meta.get("full_title") or page_title_from_markdown(markdown) or fallback or page_id


def create_wiki_router(
    store: WikiStore,
    events: EventStore,
    ingest: WikiIngestService,
    agent: WikiAgent | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/wiki", tags=["wiki"])
    graph_service = WikiGraphService(store)

    @router.get("/terms")
    def get_terms():
        return load_terms(store)

    @router.post("/terms")
    def create_wiki_term(request: CreateTermRequest):
        try:
            term = create_term(store, request.label)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        graph_service.invalidate({"*"})
        return {"term": term, "terms": load_terms(store)}

    @router.post("/terms/active")
    def set_wiki_active_term(request: SetActiveTermRequest):
        try:
            data = set_active_term(store, request.term_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Term not found.") from exc
        graph_service.invalidate({"*"})
        return data

    @router.post("/terms/{term_id}/archive")
    def archive_wiki_term(term_id: str, archived: bool = True):
        try:
            data = set_term_archived(store, term_id, archived)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Term not found.") from exc
        graph_service.invalidate({"*"})
        return data

    @router.get("/pages/v2")
    def list_pages_v2(term_id: str = ""):
        pages = []
        knowledge_dir = store.wiki_dir / "knowledge"
        if knowledge_dir.exists():
            for path in knowledge_dir.rglob("*.md"):
                try:
                    meta, _ = parse_page(path.read_text(encoding="utf-8"))
                    page = KnowledgePageMeta(**meta)
                except (ValueError, OSError):
                    continue
                if not term_matches(meta, term_id):
                    continue
                pages.append(
                    {
                        "id": page.id,
                        "type": "knowledge",
                        "title": page.full_title,
                        "shortTitle": page.short_title,
                        "subject": page.subject,
                        "chapter": page.chapter,
                        "masteryState": page.mastery_state,
                        "path": path.relative_to(store.wiki_dir).as_posix(),
                        "termId": page.term_id or LEGACY_TERM_ID,
                    }
                )
        return pages

    @router.get("/local/locations")
    def local_locations():
        targets = {
            "wiki": store.wiki_dir,
            "knowledge": store.wiki_dir / "knowledge",
            "materials": store.wiki_dir / "materials",
            "papers": store.wiki_dir / "papers",
            "flashcards": store.wiki_dir / "flashcards",
            "reports": store.wiki_dir / "reports",
        }
        return {
            key: str(path)
            for key, path in targets.items()
        }

    @router.post("/local/open")
    def open_local_wiki_target(request: OpenLocalWikiRequest):
        targets = {
            "wiki": store.wiki_dir,
            "knowledge": store.wiki_dir / "knowledge",
            "materials": store.wiki_dir / "materials",
            "papers": store.wiki_dir / "papers",
            "flashcards": store.wiki_dir / "flashcards",
            "reports": store.wiki_dir / "reports",
        }
        path = targets.get(request.target)
        if path is None:
            raise HTTPException(status_code=400, detail="Unknown local Wiki target.")
        path.mkdir(parents=True, exist_ok=True)
        try:
            open_local_path(path)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"无法打开本地目录：{exc}") from exc
        return {"status": "opened", "target": request.target, "path": str(path)}

    @router.post("/local/open-page")
    def open_local_wiki_page(request: OpenLocalWikiPageRequest):
        try:
            path = store.find_page_by_id(request.page_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Wiki page not found.") from exc
        try:
            open_local_path(path)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"无法打开本地文件：{exc}") from exc
        return {
            "status": "opened",
            "pageId": request.page_id,
            "path": str(path),
        }

    @router.get("/pages/v2/{page_id}")
    def get_page_v2(page_id: str):
        try:
            path = store.find_page_by_id(page_id)
            markdown = path.read_text(encoding="utf-8")
            meta, _ = parse_page(markdown)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Wiki page not found.") from exc
        knowledge_labels = {
            item_id: label_for_page(store, item_id)
            for item_id in markdown_ids(markdown, "wiki") + list(meta.get("knowledge_ids") or [])
        }
        evidence_labels = {
            item_id: label_for_page(store, item_id)
            for item_id in markdown_ids(markdown, "evidence") + list(meta.get("evidence_ids") or [])
        }
        display_markdown = normalize_artifact_links(markdown, knowledge_labels, evidence_labels)
        return {
            "id": page_id,
            "type": "knowledge",
            "title": meta.get("full_title") or meta.get("short_title") or page_id,
            "shortTitle": meta.get("short_title") or "",
            "subject": meta.get("subject") or "",
            "chapter": meta.get("chapter") or "",
            "masteryState": meta.get("mastery_state") or "pending_verification",
            "path": path.relative_to(store.wiki_dir).as_posix(),
            "markdown": display_markdown,
            "meta": meta,
            "termId": meta.get("term_id") or LEGACY_TERM_ID,
        }

    @router.get("/graph/v2")
    def get_graph_v2(mode: str = "weak", subject: str = "", dateRange: str = "all", term_id: str = ""):
        if mode not in {"weak", "full"}:
            raise HTTPException(status_code=400, detail="Graph mode must be weak or full.")
        return graph_service.build(mode, subject=subject, date_range=dateRange, term_id=term_id)

    @router.patch("/pages/{page_id}")
    def patch_page(page_id: str, request: WikiPagePatch):
        try:
            path = store.find_page_by_id(page_id)
            meta_data, sections = parse_page(path.read_text(encoding="utf-8"))
            meta = KnowledgePageMeta(**meta_data)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Wiki page not found.") from exc
        protected = (set(meta.locked_fields) | set(meta.manual_fields)) - set(request.unlock_fields)
        conflicts = protected.intersection(request.fields)
        if conflicts:
            raise HTTPException(
                status_code=409,
                detail=f"字段受保护，不能自动覆盖：{', '.join(sorted(conflicts))}",
            )
        for field_name in request.unlock_fields:
            meta.locked_fields.discard(field_name)
        for field_name, value in request.fields.items():
            if not hasattr(meta, field_name):
                raise HTTPException(status_code=400, detail=f"Unknown Wiki field: {field_name}")
            setattr(meta, field_name, value)
            meta.manual_fields.add(field_name)
        for section_name, content in request.sections.items():
            sections[section_name] = content
        relative = path.relative_to(store.wiki_dir).as_posix()
        new_relative = knowledge_relative(meta)
        tx = store.begin_transaction("manual-page-update")
        tx.write_page(relative, render_knowledge_page(meta, sections))
        if relative != new_relative:
            tx.move_page(relative, new_relative)
        transaction_id = tx.commit([{"tool": "update_fields", "page_id": page_id, "fields": request.fields}])
        graph_service.invalidate({page_id})
        return {"pageId": page_id, "transactionId": transaction_id, "meta": meta.model_dump(mode="json")}

    @router.delete("/pages/{page_id}")
    def delete_page(page_id: str):
        try:
            path = store.find_page_by_id(page_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Wiki page not found.") from exc
        relative = path.relative_to(store.wiki_dir).as_posix()
        tx = store.begin_transaction("trash-page")
        trash_path = tx.trash_page(relative)
        transaction_id = tx.commit([{"tool": "trash_page", "page_id": page_id, "path": relative}])
        graph_service.invalidate({page_id})
        return {"pageId": page_id, "trashPath": trash_path, "transactionId": transaction_id}

    @router.get("/inbox")
    def list_inbox():
        items = []
        inbox_dir = store.wiki_dir / "inbox"
        if not inbox_dir.exists():
            return items
        for path in sorted(inbox_dir.glob("pending_*.md"), key=lambda item: item.stat().st_mtime, reverse=True):
            meta, sections = parse_page(path.read_text(encoding="utf-8"))
            items.append({"id": meta["id"], "meta": meta, "sections": sections})
        return items

    @router.post("/inbox/{item_id}/confirm")
    def confirm_inbox(item_id: str):
        relative = f"inbox/{item_id}.md"
        path = store.resolve(relative)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Inbox item not found.")
        meta, _ = parse_page(path.read_text(encoding="utf-8"))
        try:
            event = events.get(meta["event_id"])
            decision = IngestDecision(**meta["decision"]).model_copy(update={"confidence": 1.0})
            result = ingest.ingest_event(event, decision)
        except (FileNotFoundError, KeyError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=f"待确认项无法摄取：{exc}") from exc
        tx = store.begin_transaction("confirm-inbox")
        tx.trash_page(relative)
        tx.commit([{"tool": "archive_evidence", "item_id": item_id, "page_id": result.page_id}])
        graph_service.invalidate({result.page_id})
        return result.model_dump(mode="json")

    @router.post("/inbox/{item_id}/rerun")
    def rerun_inbox(item_id: str, request: InboxRerunRequest):
        relative = f"inbox/{item_id}.md"
        path = store.resolve(relative)
        if not path.exists():
            raise HTTPException(status_code=404, detail="Inbox item not found.")
        meta, sections = parse_page(path.read_text(encoding="utf-8"))
        locked_fields = set(request.locked_fields)
        meta["locked_fields"] = sorted(locked_fields)
        previous = meta.get("decision") or {}
        updated = request.decision.model_dump()
        for field_name in locked_fields:
            if field_name in previous:
                updated[field_name] = previous[field_name]
        meta["decision"] = updated
        markdown = "\n".join(
            [
                "---json",
                __import__("json").dumps(meta, ensure_ascii=False, indent=2),
                "---",
                "",
                f"# 待确认 · {updated['short_title']}",
                "",
                *[
                    line
                    for heading, content in sections.items()
                    for line in (f"## {heading}", "", content, "")
                ],
            ]
        )
        tx = store.begin_transaction("rerun-inbox")
        tx.write_page(relative, markdown)
        transaction_id = tx.commit([{"tool": "update_fields", "item_id": item_id}])
        return {"id": item_id, "transactionId": transaction_id, "decision": updated}

    @router.delete("/inbox/{item_id}")
    def delete_inbox(item_id: str):
        relative = f"inbox/{item_id}.md"
        if not store.resolve(relative).exists():
            raise HTTPException(status_code=404, detail="Inbox item not found.")
        tx = store.begin_transaction("trash-inbox")
        trash_path = tx.trash_page(relative)
        transaction_id = tx.commit([{"tool": "trash_page", "item_id": item_id}])
        return {"itemId": item_id, "trashPath": trash_path, "transactionId": transaction_id}

    @router.post("/transactions/{transaction_id}/undo")
    def undo_transaction(transaction_id: str):
        try:
            undo_id = store.undo_transaction(transaction_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Transaction snapshot not found.") from exc
        return {"transactionId": transaction_id, "undoId": undo_id}

    @router.post("/organize/plan")
    async def organize_plan(request: OrganizePlanRequest):
        nonlocal agent
        current_agent = agent or WikiAgent(store)
        try:
            plan = await current_agent.plan(request)
            return {
                "runId": plan.run_id,
                "rounds": plan.rounds,
                "operations": [
                    {
                        "id": op.id,
                        "tool": op.tool,
                        "reason": op.reason,
                        "risk": op.risk,
                        "before": op.before,
                        "after": op.after,
                        "conflicts": op.conflicts,
                        "selected": op.selected,
                    }
                    for op in plan.operations
                ],
                "conflicts": plan.conflicts,
                "estimatedCostUsd": plan.estimated_cost_usd,
                "sourceHashes": plan.source_hashes,
                "instruction": plan.instruction,
            }
        except AgentPlanError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @router.post("/organize/execute")
    def organize_execute(request: OrganizeExecuteRequest):
        nonlocal agent
        current_agent = agent or WikiAgent(store)
        try:
            tx_id = current_agent.execute_run(request.runId, request.operationIds)
            graph_service.invalidate({"*"})
            return {
                "runId": request.runId,
                "status": "executed",
                "transactionId": tx_id
            }
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Execution failed: {exc}")

    @router.post("/organize/undo")
    def organize_undo(request: OrganizeUndoRequest):
        nonlocal agent
        current_agent = agent or WikiAgent(store)
        try:
            undo_id = current_agent.undo_run(request.runId)
            graph_service.invalidate({"*"})
            return {
                "runId": request.runId,
                "status": "undone",
                "undoId": undo_id
            }
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    @router.get("/organize/runs/{runId}")
    def get_organize_run(runId: str):
        nonlocal agent
        current_agent = agent or WikiAgent(store)
        try:
            run_data = current_agent.get_run(runId)
            return run_data
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    @router.post("/papers")
    async def create_paper(request: CreatePaperRequest):
        if not request.term_id:
            request.term_id = active_term_id(store)
        try:
            return await generate_practice_paper(store, request)
        except (ArtifactValidationError, ValidationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to generate paper: {exc}")

    @router.post("/flashcards")
    async def create_flashcards(request: CreateFlashcardsRequest):
        if not request.term_id:
            request.term_id = active_term_id(store)
        try:
            return await generate_flashcards(store, request)
        except (ArtifactValidationError, ValidationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to generate flashcards: {exc}")

    @router.post("/reports")
    async def create_report(request: CreateReportRequest):
        if not request.term_id:
            request.term_id = active_term_id(store)
        try:
            return await generate_stage_report(store, request)
        except (ArtifactValidationError, ValidationError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to generate report: {exc}")

    @router.get("/artifacts")
    def get_artifacts(term_id: str = ""):
        return list_artifacts(store, term_id=term_id)

    @router.post("/migrate-legacy")
    def migrate_legacy():
        try:
            return migrate_legacy_wiki(store)
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @router.delete("/artifacts/{page_id}")
    def delete_wiki_artifact(page_id: str):
        try:
            delete_artifact(store, page_id)
            return {"status": "deleted", "pageId": page_id}
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    @router.post("/artifacts/{page_id}/archive")
    def archive_wiki_flashcards(page_id: str, archived: bool = True):
        try:
            return archive_flashcard_deck(store, page_id, archived)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc))

    return router
