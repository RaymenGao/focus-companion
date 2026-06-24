from __future__ import annotations

import base64
import json
import os
import re
import tempfile
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def event_id() -> str:
    return f"event_{datetime.now().astimezone().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"


@dataclass
class FollowUp:
    asked_at: str
    question: str
    answer_markdown: str


@dataclass
class LearningEvent:
    id: str
    interaction_mode: str
    event_type: str
    classification_confidence: float
    subject: str
    chapter: str
    grade: str
    created_at: str
    updated_at: str
    write_status: str
    original_question: str
    question_text: str = ""
    question_image: str = ""
    question_image_missing: bool = False
    reasoning_markdown: str = ""
    final_answer_markdown: str = ""
    answer_revealed: bool = False
    answer_revealed_at: str = ""
    knowledge_suggestions: list[str] = field(default_factory=list)
    related_knowledge: list[str] = field(default_factory=list)
    mistake_reason: str = ""
    mastery_suggestion: int = 0
    follow_ups: list[FollowUp] = field(default_factory=list)
    corrections: list[dict[str, Any]] = field(default_factory=list)


def _frontmatter(event: LearningEvent) -> str:
    meta = asdict(event)
    meta.pop("follow_ups", None)
    meta.pop("reasoning_markdown", None)
    meta.pop("final_answer_markdown", None)
    meta.pop("question_text", None)
    meta.pop("original_question", None)
    meta.pop("mistake_reason", None)
    return json.dumps(meta, ensure_ascii=False, indent=2)


def render_event_markdown(event: LearningEvent) -> str:
    lines = [
        "---json",
        _frontmatter(event),
        "---",
        "",
        f"# 学习事件 {event.id}",
        "",
        "## 题干",
        "",
        event.question_text or "题干待补录",
        "",
        "## 学生原始问题",
        "",
        event.original_question or "未记录",
        "",
        "## 解题思路",
        "",
        event.reasoning_markdown or "AI 尚未完成解题思路。",
        "",
        "## 最终答案",
        "",
        event.final_answer_markdown or "最终答案待补充。",
        "",
        "## 对话记录",
        "",
    ]
    if event.follow_ups:
        for index, follow_up in enumerate(event.follow_ups, 1):
            lines.extend(
                [
                    f"### 追问 {index} · {follow_up.asked_at}",
                    "",
                    f"- 学生：{follow_up.question}",
                    f"- AI：{follow_up.answer_markdown}",
                    "",
                ]
            )
    else:
        lines.extend(["暂无追问。", ""])
    lines.extend(
        [
            "## AI 分类建议",
            "",
            f"- 类型：{event.event_type}",
            f"- 置信度：{event.classification_confidence:.2f}",
            f"- 学科：{event.subject or '待确认'}",
            f"- 章节：{event.chapter or '待确认'}",
            f"- 错因：{event.mistake_reason or '无'}",
            f"- 建议掌握度：{event.mastery_suggestion}%",
            "",
            "## 修订记录",
            "",
            json.dumps(event.corrections, ensure_ascii=False, indent=2) if event.corrections else "暂无修订。",
            "",
        ]
    )
    return "\n".join(lines)


def parse_event_markdown(markdown: str) -> LearningEvent:
    match = re.match(r"^---json\r?\n(.*?)\r?\n---\r?\n", markdown, re.S)
    if not match:
        raise ValueError("Learning event Markdown is missing JSON frontmatter.")
    meta = json.loads(match.group(1))

    def section(name: str) -> str:
        found = re.search(rf"^## {re.escape(name)}\r?\n\r?\n(.*?)(?=^## |\Z)", markdown, re.M | re.S)
        return found.group(1).strip() if found else ""

    follow_ups: list[FollowUp] = []
    conversation = section("对话记录")
    for found in re.finditer(
        r"^### 追问 \d+ · (.*?)\r?\n\r?\n- 学生：(.*?)\r?\n- AI：(.*?)(?=^### 追问|\Z)",
        conversation,
        re.M | re.S,
    ):
        follow_ups.append(FollowUp(found.group(1).strip(), found.group(2).strip(), found.group(3).strip()))
    meta["original_question"] = section("学生原始问题").replace("未记录", "", 1).strip()
    meta["question_text"] = section("题干").replace("题干待补录", "", 1).strip()
    meta["reasoning_markdown"] = section("解题思路").replace("AI 尚未完成解题思路。", "", 1).strip()
    meta["final_answer_markdown"] = section("最终答案").replace("最终答案待补充。", "", 1).strip()
    meta["follow_ups"] = follow_ups
    return LearningEvent(**meta)


class EventStore:
    def __init__(self, wiki_dir: Path):
        self.wiki_dir = wiki_dir
        self.events_dir = wiki_dir / "events"
        self.evidence_dir = wiki_dir / "evidence"
        self.assets_dir = wiki_dir / "assets" / "questions"
        self.lock = threading.RLock()

    def _event_path(self, event: LearningEvent) -> Path:
        created = datetime.fromisoformat(event.created_at)
        return self.events_dir / created.strftime("%Y") / created.strftime("%m") / f"{event.id}.md"

    def _find_path(self, event_id_value: str) -> Path:
        matches = [
            *self.events_dir.glob(f"*/*/{event_id_value}.md"),
            *self.evidence_dir.glob(f"*/*/{event_id_value}.md"),
        ]
        if not matches:
            raise FileNotFoundError(event_id_value)
        return matches[0]

    def _storage_path(self, event: LearningEvent) -> Path:
        try:
            return self._find_path(event.id)
        except FileNotFoundError:
            return self._event_path(event)

    def _atomic_write(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    def _save_image(self, event: LearningEvent, image_data_url: str | None) -> None:
        if not image_data_url:
            return
        match = re.match(r"^data:image/([a-zA-Z0-9.+-]+);base64,(.+)$", image_data_url, re.S)
        if not match:
            event.question_image_missing = True
            return
        mime = match.group(1).lower()
        extension = {"jpeg": "jpg", "svg+xml": "svg"}.get(mime, mime)
        created = datetime.fromisoformat(event.created_at)
        relative = Path("assets") / "questions" / created.strftime("%Y") / created.strftime("%m") / f"{event.id}.{extension}"
        target = self.wiki_dir / relative
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(match.group(2)))
            event.question_image = relative.as_posix()
        except (ValueError, OSError):
            event.question_image_missing = True

    def create_draft(
        self,
        *,
        interaction_mode: str,
        original_question: str,
        grade: str,
        image_data_url: str | None = None,
    ) -> LearningEvent:
        timestamp = now_iso()
        event = LearningEvent(
            id=event_id(),
            interaction_mode=interaction_mode,
            event_type="question" if interaction_mode == "voice" else "stuck",
            classification_confidence=0,
            subject="",
            chapter="",
            grade=grade,
            created_at=timestamp,
            updated_at=timestamp,
            write_status="draft",
            original_question=original_question,
        )
        with self.lock:
            self._save_image(event, image_data_url)
            self._atomic_write(self._event_path(event), render_event_markdown(event))
        return event

    def save(self, event: LearningEvent) -> LearningEvent:
        event.updated_at = now_iso()
        with self.lock:
            self._atomic_write(self._storage_path(event), render_event_markdown(event))
        return event

    def get(self, event_id_value: str) -> LearningEvent:
        with self.lock:
            return parse_event_markdown(self._find_path(event_id_value).read_text(encoding="utf-8"))

    def list(self, limit: int = 100) -> list[LearningEvent]:
        if not self.events_dir.exists() and not self.evidence_dir.exists():
            return []
        paths = sorted(
            [*self.events_dir.glob("*/*/*.md"), *self.evidence_dir.glob("*/*/*.md")],
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        return [parse_event_markdown(path.read_text(encoding="utf-8")) for path in paths[:limit]]

    def complete(self, event_id_value: str, data: dict[str, Any]) -> LearningEvent:
        event = self.get(event_id_value)
        event.write_status = "complete"
        event.event_type = str(data.get("event_type") or event.event_type)
        event.classification_confidence = float(data.get("classification_confidence") or 0)
        event.subject = str(data.get("subject") or "")
        event.chapter = str(data.get("chapter") or "")
        event.question_text = str(data.get("question_text") or "")
        event.reasoning_markdown = str(data.get("answer_markdown") or "")
        event.final_answer_markdown = str(data.get("correct_answer_markdown") or "")
        event.knowledge_suggestions = [str(item) for item in data.get("knowledge_suggestions") or [data.get("knowledge_point")] if item]
        event.mistake_reason = str(data.get("mistake_reason") or "")
        event.mastery_suggestion = max(0, min(100, int(data.get("mastery") or 0)))
        return self.save(event)

    def append_follow_up(self, event_id_value: str, question: str, answer_markdown: str) -> LearningEvent:
        event = self.get(event_id_value)
        event.follow_ups.append(FollowUp(now_iso(), question.strip(), answer_markdown.strip()))
        return self.save(event)

    def reveal_answer(self, event_id_value: str) -> LearningEvent:
        event = self.get(event_id_value)
        event.answer_revealed = True
        event.answer_revealed_at = now_iso()
        return self.save(event)

    def archive(self, event_id_value: str) -> LearningEvent:
        event = self.get(event_id_value)
        event.write_status = "archived"
        return self.save(event)

    def archive_as_evidence(self, event_id_value: str, knowledge_ids: list[str]) -> LearningEvent:
        with self.lock:
            event = self.get(event_id_value)
            event.write_status = "archived"
            event.related_knowledge = sorted(set([*event.related_knowledge, *knowledge_ids]))
            event.updated_at = now_iso()
            source = self._find_path(event.id)
            created = datetime.fromisoformat(event.created_at)
            target = self.evidence_dir / created.strftime("%Y") / created.strftime("%m") / source.name
            self._atomic_write(target, render_event_markdown(event))
            if source != target:
                source.unlink(missing_ok=True)
            return event
