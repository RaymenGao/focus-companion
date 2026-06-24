from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from event_store import EventStore, LearningEvent
from wiki_markdown import parse_page, render_knowledge_page, wiki_link
from wiki_models import IngestDecision, IngestResult, KnowledgePageMeta
from wiki_store import WikiStore
from wiki_terms import active_term_id


SUBJECT_SLUGS = {
    "数学": "math",
    "英语": "english",
    "外语": "languages",
    "语文": "chinese",
    "科学": "science",
    "物理": "physics",
    "化学": "chemistry",
    "生物": "biology",
    "历史": "history",
    "地理": "geography",
}


def stable_slug(value: str, prefix: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if cleaned:
        return cleaned
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]
    return f"{prefix}-{digest}"


def subject_slug(subject: str) -> str:
    return SUBJECT_SLUGS.get(subject.strip(), stable_slug(subject, "subject"))


def knowledge_id(subject: str, full_title: str) -> str:
    digest = hashlib.sha1(f"{subject}\0{full_title}".encode("utf-8")).hexdigest()[:12]
    return f"kp_{subject_slug(subject).replace('-', '_')}_{digest}"


class WikiIngestService:
    def __init__(
        self,
        store: WikiStore,
        events: EventStore,
        auto_ingest_threshold: float = 0.85,
    ):
        self.store = store
        self.events = events
        self.auto_ingest_threshold = auto_ingest_threshold

    def ingest_event(self, event: LearningEvent, decision: IngestDecision) -> IngestResult:
        if not decision.existing_page_id:
            matched = self.find_exact_knowledge(decision.subject, decision.full_title, decision.short_title)
            if matched:
                decision = decision.model_copy(update={"existing_page_id": matched})
        if decision.confidence < self.auto_ingest_threshold:
            return self.create_inbox_item(event, decision)
        if decision.existing_page_id:
            return self.update_existing(event, decision)
        return self.create_knowledge(event, decision)

    def find_exact_knowledge(self, subject: str, full_title: str, short_title: str) -> str:
        knowledge_dir = self.store.wiki_dir / "knowledge"
        if not knowledge_dir.exists():
            return ""
        for path in knowledge_dir.rglob("*.md"):
            try:
                meta, _ = parse_page(path.read_text(encoding="utf-8"))
            except (ValueError, OSError, json.JSONDecodeError):
                continue
            if meta.get("subject") != subject:
                continue
            if meta.get("full_title") == full_title or meta.get("short_title") == short_title:
                return str(meta.get("id") or "")
        return ""

    def create_inbox_item(self, event: LearningEvent, decision: IngestDecision) -> IngestResult:
        inbox_id = f"pending_{event.id}"
        markdown = "\n".join(
            [
                "---json",
                json.dumps(
                    {
                        "id": inbox_id,
                        "event_id": event.id,
                        "locked_fields": [],
                        "decision": decision.model_dump(),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                "---",
                "",
                f"# 待确认 · {decision.short_title}",
                "",
                "## 原始问题",
                "",
                event.original_question or "未记录",
                "",
                "## AI 回答摘要",
                "",
                event.reasoning_markdown or "未记录",
                "",
            ]
        )
        self.store.write_page(f"inbox/{inbox_id}.md", markdown)
        return IngestResult(status="pending", event_id=event.id, inbox_id=inbox_id)

    def create_knowledge(self, event: LearningEvent, decision: IngestDecision) -> IngestResult:
        page_id = knowledge_id(decision.subject, decision.full_title)
        meta = KnowledgePageMeta(
            id=page_id,
            term_id=active_term_id(self.store),
            subject=decision.subject,
            chapter=decision.chapter,
            short_title=decision.short_title,
            full_title=decision.full_title,
            prerequisites=decision.prerequisites,
            evidence_ids=[event.id],
        )
        sections = self._sections_for_event(event, decision)
        relative = self._knowledge_relative(meta)
        self._ensure_subject_and_chapter(decision.subject, decision.chapter)
        self.store.write_page(relative, render_knowledge_page(meta, sections))
        self.events.archive_as_evidence(event.id, [page_id])
        return IngestResult(status="ingested", event_id=event.id, page_id=page_id)

    def update_existing(self, event: LearningEvent, decision: IngestDecision) -> IngestResult:
        path = self.store.find_page_by_id(decision.existing_page_id)
        meta_data, sections = parse_page(path.read_text(encoding="utf-8"))
        meta = KnowledgePageMeta(**meta_data)
        if not meta.term_id:
            meta.term_id = active_term_id(self.store)

        protected = set(meta.manual_fields) | set(meta.locked_fields)
        updates = {
            "subject": decision.subject,
            "chapter": decision.chapter,
            "short_title": decision.short_title,
            "full_title": decision.full_title,
            "prerequisites": sorted(set([*meta.prerequisites, *decision.prerequisites])),
            "evidence_ids": sorted(set([*meta.evidence_ids, event.id])),
        }
        for field_name, value in updates.items():
            if field_name not in protected:
                setattr(meta, field_name, value)

        evidence_line = f"- {wiki_link(event.id, event.original_question or '学习事件')}"
        existing_evidence = sections.get("学习证据", "").splitlines()
        if evidence_line not in existing_evidence:
            sections["学习证据"] = "\n".join([*existing_evidence, evidence_line]).strip()

        new_relative = self._knowledge_relative(meta)
        current_relative = path.relative_to(self.store.wiki_dir).as_posix()
        transaction = self.store.begin_transaction("ingest-update")
        transaction.write_page(current_relative, render_knowledge_page(meta, sections))
        if current_relative != new_relative:
            transaction.move_page(current_relative, new_relative)
        transaction.commit(
            [{"tool": "update_fields", "page_id": meta.id, "event_id": event.id}]
        )
        self._ensure_subject_and_chapter(meta.subject, meta.chapter)
        self.events.archive_as_evidence(event.id, [meta.id])
        return IngestResult(status="ingested", event_id=event.id, page_id=meta.id)

    def _knowledge_relative(self, meta: KnowledgePageMeta) -> str:
        subject = subject_slug(meta.subject)
        chapter = stable_slug(meta.chapter, "chapter")
        return f"knowledge/{subject}/{chapter}/{meta.id}.md"

    def _ensure_subject_and_chapter(self, subject: str, chapter: str) -> None:
        subject_id = subject_slug(subject)
        chapter_id = stable_slug(chapter, "chapter")
        subject_path = self.store.wiki_dir / "subjects" / subject_id / "index.md"
        chapter_path = self.store.wiki_dir / "subjects" / subject_id / "chapters" / f"{chapter_id}.md"
        if not subject_path.exists():
            self.store.write_page(
                f"subjects/{subject_id}/index.md",
                f"# {subject}\n\n本学科由 FocusLens Wiki 自动建立。\n",
            )
        if not chapter_path.exists():
            self.store.write_page(
                f"subjects/{subject_id}/chapters/{chapter_id}.md",
                f"# {chapter}\n\n所属学科：{subject}\n",
            )

    def _sections_for_event(
        self,
        event: LearningEvent,
        decision: IngestDecision,
    ) -> dict[str, str]:
        return {
            "核心概念": event.reasoning_markdown,
            "常见错因": "\n".join(f"- {item}" for item in decision.common_reasons)
            or (f"- {event.mistake_reason}" if event.mistake_reason else ""),
            "解题方法": event.reasoning_markdown,
            "前置知识": "\n".join(f"- {item}" for item in decision.prerequisites),
            "学习证据": f"- {wiki_link(event.id, event.original_question or '学习事件')}",
        }
