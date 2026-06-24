from __future__ import annotations

import hashlib
from typing import Literal

from wiki_markdown import parse_page
from wiki_models import (
    KnowledgePageMeta,
    MasteryState,
    WikiGraphEdgeV2,
    WikiGraphNodeV2,
    WikiGraphResponseV2,
)
from wiki_store import WikiStore
from wiki_terms import term_matches


def _node_id(prefix: str, *parts: str) -> str:
    digest = hashlib.sha1("\0".join(parts).encode("utf-8")).hexdigest()[:12]
    return f"{prefix}:{digest}"


class WikiGraphService:
    def __init__(self, store: WikiStore):
        self.store = store
        self._cache: dict[tuple[str, str, str, str], WikiGraphResponseV2] = {}

    def invalidate(self, page_ids: set[str]) -> None:
        if page_ids:
            self._cache.clear()

    def build(
        self,
        mode: Literal["weak", "full"],
        subject: str = "",
        date_range: str = "all",
        term_id: str = "",
    ) -> WikiGraphResponseV2:
        key = (mode, subject, date_range, term_id)
        cached = self._cache.get(key)
        if cached:
            return cached.model_copy(deep=True)

        metas: dict[str, KnowledgePageMeta] = {}
        knowledge_dir = self.store.wiki_dir / "knowledge"
        if knowledge_dir.exists():
            for path in knowledge_dir.rglob("*.md"):
                try:
                    raw, _ = parse_page(path.read_text(encoding="utf-8"))
                    meta = KnowledgePageMeta(**raw)
                except (ValueError, OSError):
                    continue
                if subject and meta.subject != subject:
                    continue
                if not term_matches(raw, term_id):
                    continue
                if mode == "weak" and meta.mastery_state == MasteryState.MASTERED:
                    continue
                metas[meta.id] = meta

        nodes: dict[str, WikiGraphNodeV2] = {}
        edges: dict[tuple[str, str, str], WikiGraphEdgeV2] = {}

        def add_edge(source: str, target: str, edge_type: Literal["contains", "prerequisite_of", "related_to"]):
            edges[(source, target, edge_type)] = WikiGraphEdgeV2(
                source=source,
                target=target,
                type=edge_type,
            )

        for meta in metas.values():
            subject_id = _node_id("subject", meta.subject)
            chapter_id = _node_id("chapter", meta.subject, meta.chapter)
            nodes.setdefault(
                subject_id,
                WikiGraphNodeV2(
                    id=subject_id,
                    label=meta.subject,
                    full_title=meta.subject,
                    type="subject",
                    subject=meta.subject,
                ),
            )
            nodes.setdefault(
                chapter_id,
                WikiGraphNodeV2(
                    id=chapter_id,
                    label=meta.chapter,
                    full_title=meta.chapter,
                    type="chapter",
                    subject=meta.subject,
                    chapter=meta.chapter,
                ),
            )
            evidence_count = sum(1 for event_id in meta.evidence_ids if self._evidence_exists(event_id))
            why = self._why(meta, evidence_count)
            next_action = self._next_action(meta, evidence_count)
            nodes[meta.id] = WikiGraphNodeV2(
                id=meta.id,
                label=meta.short_title,
                full_title=meta.full_title,
                type="knowledge",
                subject=meta.subject,
                chapter=meta.chapter,
                mastery_state=meta.mastery_state,
                evidence_count=evidence_count,
                page_id=meta.id,
                why=why,
                recent_evidence=meta.evidence_ids[-1] if meta.evidence_ids else "",
                review_first=meta.prerequisites[0] if meta.prerequisites else "",
                next_action=next_action,
            )
            add_edge(subject_id, chapter_id, "contains")
            add_edge(chapter_id, meta.id, "contains")

            for prerequisite in meta.prerequisites:
                prerequisite_meta = metas.get(prerequisite)
                if prerequisite_meta:
                    prerequisite_id = prerequisite_meta.id
                else:
                    prerequisite_id = f"prerequisite:{prerequisite}"
                    nodes.setdefault(
                        prerequisite_id,
                        WikiGraphNodeV2(
                            id=prerequisite_id,
                            label=prerequisite[:20],
                            full_title=prerequisite,
                            type="prerequisite",
                            subject=meta.subject,
                        ),
                    )
                add_edge(prerequisite_id, meta.id, "prerequisite_of")

            if mode == "full":
                for related in meta.related:
                    if related in metas:
                        add_edge(meta.id, related, "related_to")

        response = WikiGraphResponseV2(mode=mode, nodes=list(nodes.values()), edges=list(edges.values()))
        self._cache[key] = response
        return response.model_copy(deep=True)

    def _evidence_exists(self, event_id: str) -> bool:
        evidence_dir = self.store.wiki_dir / "evidence"
        return evidence_dir.exists() and any(evidence_dir.rglob(f"{event_id}.md"))

    def _why(self, meta: KnowledgePageMeta, evidence_count: int) -> str:
        if evidence_count == 0:
            return "当前知识点缺少有效学习证据，需要先确认是否仍需保留。"
        if meta.mastery_state == MasteryState.WEAK:
            return f"已有 {evidence_count} 条有效证据，当前状态仍为薄弱。"
        if meta.mastery_state == MasteryState.PENDING_RETEST:
            return "已经完成学习，等待复测验证是否真正掌握。"
        return f"已有 {evidence_count} 条有效证据，需要继续观察掌握变化。"

    def _next_action(self, meta: KnowledgePageMeta, evidence_count: int) -> str:
        if evidence_count == 0:
            return "检查知识页分类，补充或关联一条有效学习证据。"
        if meta.prerequisites:
            return f"先复习前置知识：{meta.prerequisites[0]}，再完成一道同类题。"
        if meta.mastery_state == MasteryState.PENDING_RETEST:
            return "安排一次不看提示的复测。"
        return "完成一道针对性练习，并记录是否需要提示。"
