from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from wiki_ingest import knowledge_id, stable_slug, subject_slug
from wiki_markdown import KNOWLEDGE_SECTIONS, parse_page, render_knowledge_page, wiki_link
from wiki_models import KnowledgePageMeta
from wiki_store import WikiStore


LEGACY_MISTAKE_LINK = re.compile(r"\.\./mistakes/([A-Za-z0-9_-]+)\.md")
LEGACY_SECTION = re.compile(r"^## (.+?)\r?\n\r?\n(.*?)(?=^## |\Z)", re.M | re.S)


def _legacy_sections(content: str, evidence_ids: list[str]) -> dict[str, str]:
    legacy_sections = {match.group(1): match.group(2).strip() for match in LEGACY_SECTION.finditer(content)}
    intro = re.sub(r"(?m)^# .+\r?\n?", "", content.split("\n## ", 1)[0]).strip()

    def bullet_value(label: str) -> str:
        match = re.search(rf"(?m)^-\s*{re.escape(label)}[：:]\s*(.+)$", content)
        return match.group(1).strip() if match else ""

    common_reason = bullet_value("高频错因")
    prerequisites = bullet_value("可能缺口")
    return {
        "核心概念": legacy_sections.get("核心概念", "") or intro,
        "常见错因": f"- {common_reason}" if common_reason and common_reason != "暂无" else "",
        "解题方法": legacy_sections.get("复习路径", ""),
        "前置知识": (
            "\n".join(f"- {item.strip()}" for item in prerequisites.split(",") if item.strip())
            if prerequisites and prerequisites != "暂无"
            else ""
        ),
        "学习证据": "\n".join(f"- {wiki_link(item, item)}" for item in evidence_ids),
    }


def _legacy_evidence_markdown(evidence_id: str, subject: str, source: Path, content: str) -> str:
    meta = {
        "id": evidence_id,
        "type": "legacy_mistake",
        "subject": subject,
        "source_path": source.as_posix(),
    }
    return "\n".join(["---json", json.dumps(meta, ensure_ascii=False, indent=2), "---", "", content])


def migrate_legacy_wiki(store: WikiStore, create_missing: bool = True) -> dict[str, Any]:
    """Copy the old flat Wiki into the new atomic format without deleting it."""
    legacy_knowledge_dir = store.wiki_dir / "knowledge"
    if not legacy_knowledge_dir.exists():
        return {"created_pages": 0, "created_evidence": 0, "repaired_pages": 0, "skipped_pages": 0}

    tx = store.begin_transaction("migrate-legacy-wiki")
    created_pages = 0
    created_evidence = 0
    repaired_pages = 0
    skipped_pages = 0
    operations: list[dict[str, Any]] = []

    try:
        for source in sorted(legacy_knowledge_dir.glob("*.md")):
            if "__" not in source.stem:
                continue
            subject, full_title = (part.strip() for part in source.stem.split("__", 1))
            if not subject or not full_title:
                continue
            page_id = knowledge_id(subject, full_title)
            legacy_content = source.read_text(encoding="utf-8")
            evidence_ids: list[str] = []
            for mistake_stem in dict.fromkeys(LEGACY_MISTAKE_LINK.findall(legacy_content)):
                legacy_mistake = store.wiki_dir / "mistakes" / f"{mistake_stem}.md"
                if not legacy_mistake.exists():
                    continue
                evidence_id = f"legacy_{mistake_stem}"
                evidence_ids.append(evidence_id)
                evidence_relative = f"evidence/legacy/{evidence_id}.md"
                if not store.resolve(evidence_relative).exists():
                    tx.write_page(
                        evidence_relative,
                        _legacy_evidence_markdown(
                            evidence_id,
                            subject,
                            legacy_mistake.relative_to(store.wiki_dir),
                            legacy_mistake.read_text(encoding="utf-8"),
                        ),
                    )
                    created_evidence += 1
                    operations.append({"tool": "migrate_evidence", "id": evidence_id})

            legacy_sections = _legacy_sections(legacy_content, evidence_ids)
            try:
                existing_path = store.find_page_by_id(page_id)
                existing_meta_data, existing_sections = parse_page(existing_path.read_text(encoding="utf-8"))
                existing_meta = KnowledgePageMeta(**existing_meta_data)
                changed = False
                for heading in KNOWLEDGE_SECTIONS:
                    legacy_value = legacy_sections.get(heading, "").strip()
                    if legacy_value and not existing_sections.get(heading, "").strip():
                        existing_sections[heading] = legacy_value
                        changed = True
                merged_evidence = sorted(set(existing_meta.evidence_ids + evidence_ids))
                if merged_evidence != existing_meta.evidence_ids:
                    existing_meta.evidence_ids = merged_evidence
                    changed = True
                if changed:
                    relative = existing_path.relative_to(store.wiki_dir).as_posix()
                    tx.write_page(relative, render_knowledge_page(existing_meta, existing_sections))
                    repaired_pages += 1
                    operations.append({"tool": "repair_migrated_knowledge", "id": page_id, "source": source.name})
                else:
                    skipped_pages += 1
                continue
            except FileNotFoundError:
                if not create_missing:
                    skipped_pages += 1
                    continue

            short_title = full_title[:20]
            meta = KnowledgePageMeta(
                id=page_id,
                subject=subject,
                chapter="待整理",
                short_title=short_title,
                full_title=full_title,
                evidence_ids=evidence_ids,
            )
            relative = (
                f"knowledge/{subject_slug(subject)}/{stable_slug(meta.chapter, 'chapter')}/{page_id}.md"
            )
            tx.write_page(relative, render_knowledge_page(meta, legacy_sections))
            created_pages += 1
            operations.append({"tool": "migrate_knowledge", "id": page_id, "source": source.name})

        if operations:
            tx.commit(operations)
        else:
            tx.rollback()
    except Exception:
        tx.rollback()
        raise

    return {
        "created_pages": created_pages,
        "created_evidence": created_evidence,
        "repaired_pages": repaired_pages,
        "skipped_pages": skipped_pages,
    }
