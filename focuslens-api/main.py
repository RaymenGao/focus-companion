import io
import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
try:
    import edge_tts
except ImportError:
    edge_tts = None
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, create_engine, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from event_store import EventStore, LearningEvent, now_iso
from parent_control import ParentControlStore, create_parent_router, default_parent_store_path
from wiki_ingest import WikiIngestService
from wiki_models import IngestDecision
from wiki_routes import create_wiki_router
from wiki_store import WikiStore


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./focuslens.db")
AI_API_KEY = os.getenv("FOCUSLENS_AI_API_KEY", "")
WIKI_DIR = Path(os.getenv("FOCUSLENS_WIKI_DIR", str(Path(__file__).parent / "wiki")))
WIKI_LOCK = threading.RLock()
EVENT_STORE = EventStore(WIKI_DIR)
WIKI_STORE = WikiStore(WIKI_DIR)
WIKI_INGEST = WikiIngestService(WIKI_STORE, EVENT_STORE)
logger = logging.getLogger("focuslens")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def utcnow() -> datetime:
    return datetime.utcnow()


class Base(DeclarativeBase):
    pass


class Mistake(Base):
    __tablename__ = "mistakes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    subject: Mapped[str] = mapped_column(String(80))
    grade: Mapped[str] = mapped_column(String(80))
    knowledge_point: Mapped[str] = mapped_column(String(160))
    mistake_reason: Mapped[str] = mapped_column(String(240))
    mastery: Mapped[int] = mapped_column(Integer, default=40)
    question_text: Mapped[str] = mapped_column(Text, default="")
    student_question: Mapped[str] = mapped_column(Text, default="")
    answer_markdown: Mapped[str] = mapped_column(Text, default="")
    correct_answer_markdown: Mapped[str] = mapped_column(Text, default="")
    chapter: Mapped[str] = mapped_column(String(160), default="")
    prerequisites_json: Mapped[str] = mapped_column(Text, default="[]")
    wiki_page_id: Mapped[str] = mapped_column(String(180), default="")
    image_data_url: Mapped[str] = mapped_column(Text, default="")


class AiCall(Base):
    __tablename__ = "ai_calls"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    model: Mapped[str] = mapped_column(String(120))
    trigger: Mapped[str] = mapped_column(String(40))
    estimated_cost_usd: Mapped[float] = mapped_column(Float, default=0)
    input_images: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    success: Mapped[bool] = mapped_column(Boolean, default=True)


class LearningEventIndex(Base):
    __tablename__ = "learning_events"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
    interaction_mode: Mapped[str] = mapped_column(String(32))
    event_type: Mapped[str] = mapped_column(String(32))
    subject: Mapped[str] = mapped_column(String(80), default="")
    chapter: Mapped[str] = mapped_column(String(160), default="")
    write_status: Mapped[str] = mapped_column(String(32), default="draft")
    question_text: Mapped[str] = mapped_column(Text, default="")
    original_question: Mapped[str] = mapped_column(Text, default="")
    file_path: Mapped[str] = mapped_column(Text)


try:
    Base.metadata.create_all(bind=engine)
except OperationalError as exc:
    if "already exists" not in str(exc):
        raise


def ensure_mistake_columns() -> None:
    columns = {
        "correct_answer_markdown": "TEXT DEFAULT ''",
        "chapter": "VARCHAR(160) DEFAULT ''",
        "prerequisites_json": "TEXT DEFAULT '[]'",
        "wiki_page_id": "VARCHAR(180) DEFAULT ''",
    }
    with engine.begin() as conn:
        if DATABASE_URL.startswith("sqlite"):
            existing = {row[1] for row in conn.execute(text("PRAGMA table_info(mistakes)")).fetchall()}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE mistakes ADD COLUMN {name} {ddl}"))


ensure_mistake_columns()


app = FastAPI(title="FocusLens API", version="0.1.0")
app.include_router(create_wiki_router(WIKI_STORE, EVENT_STORE, WIKI_INGEST))
app.include_router(create_parent_router(ParentControlStore(default_parent_store_path())))
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AiConfig(BaseModel):
    provider: str = "OpenAI-compatible"
    baseUrl: str = "http://127.0.0.1:8012"
    aiBaseUrl: str = ""
    apiKey: str = ""
    model: str = "gpt-4o-mini"
    captureMode: str = "full"
    captureRegion: dict[str, float] = Field(default_factory=lambda: {"x": 0.12, "y": 0.18, "width": 0.76, "height": 0.68})
    useStreaming: bool = True
    enableThinking: bool = False
    useBackendAsr: bool = True
    useBackendTts: bool = True
    ttsMode: str = "edge-tts"
    edgeTtsVoice: str = "zh-CN-YunxiNeural"
    asrBaseUrl: str = ""
    asrApiKey: str = ""
    asrModel: str = "whisper-1"
    ttsBaseUrl: str = ""
    ttsApiKey: str = ""
    ttsModel: str = "tts-1"
    ttsVoice: str = "alloy"
    ttsSpeed: float = 1.0
    ttsInstruct: str = ""
    ttsLanguage: str = ""
    paperFocusMode: str = "auto"
    paperFocusDistance: float = 0.8
    singleCallBudgetUsd: float = Field(default=0.05, ge=0)
    dailyBudgetUsd: float = Field(default=1.0, ge=0)
    allowImageUpload: bool = True
    allowInsecureAiTls: bool = False


class TutorProfile(BaseModel):
    grade: str = "小学四年级"
    teacherName: str = "小老师"
    style: str = "温和、启发式、先问再讲"
    socraticFirst: bool = True
    allowDirectAnswer: bool = False


class TutorRequest(BaseModel):
    questionAudioText: str
    imageDataUrl: str | None = None
    config: AiConfig
    profile: TutorProfile
    trigger: str = "manual"
    persistMistake: bool = True
    interactionMode: str = "vision"
    eventId: str = ""


class MemoRequest(BaseModel):
    imageDataUrl: str | None = None
    selectedDate: str
    config: AiConfig
    profile: TutorProfile


class MemoResponse(BaseModel):
    todos: list[str]
    note: str = ""


class AiConnectionTestRequest(BaseModel):
    config: AiConfig


class AiConnectionTestResponse(BaseModel):
    ok: bool
    status: int = 0
    latencyMs: int = 0
    message: str = ""
    resolvedUrl: str = ""


class SpeechTranscribeResponse(BaseModel):
    text: str


def discover_lan_ips() -> list[str]:
    candidates: set[str] = set()
    primary_ip = ""
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            candidates.add(ip)
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            primary_ip = probe.getsockname()[0]
            candidates.add(primary_ip)
    except OSError:
        pass

    def usable(ip: str) -> bool:
        try:
            parsed = ipaddress.ip_address(ip)
        except ValueError:
            return False
        if parsed.version != 4 or parsed.is_loopback or parsed.is_link_local:
            return False
        # 198.18.0.0/15 is for benchmarking/virtual adapters, not a household LAN entry.
        if ip.startswith("198.18.") or ip.startswith("198.19."):
            return False
        return True

    def priority(ip: str) -> tuple[int, str]:
        if ip == primary_ip:
            return (0, ip)
        if ip.startswith("192.168."):
            return (1, ip)
        if ip.startswith("10."):
            return (2, ip)
        if ip.startswith("172."):
            try:
                second = int(ip.split(".")[1])
                if 16 <= second <= 31:
                    return (3, ip)
            except (IndexError, ValueError):
                pass
        return (4, ip)

    return sorted((ip for ip in candidates if usable(ip)), key=priority)


@app.get("/api/network/lan-access")
def get_lan_access(request: Request, frontend_port: int = 5173):
    ips = discover_lan_ips()
    backend_port = request.url.port or 8012
    return {
        "ips": ips,
        "frontendUrls": [f"http://{ip}:{frontend_port}/?parent=1" for ip in ips],
        "backendUrls": [f"http://{ip}:{backend_port}" for ip in ips],
    }


class SpeechSynthesizeRequest(BaseModel):
    text: str
    config: AiConfig


class MistakeDto(BaseModel):
    id: str
    createdAt: str
    subject: str
    grade: str
    knowledgePoint: str
    mistakeReason: str
    mastery: int
    questionText: str = ""
    studentQuestion: str
    answerMarkdown: str
    correctAnswerMarkdown: str = ""
    chapter: str = ""
    prerequisites: list[str] = Field(default_factory=list)
    wikiPageId: str = ""
    imageDataUrl: str = ""


class TutorResponse(BaseModel):
    answerMarkdown: str
    finalAnswerMarkdown: str = ""
    mistake: MistakeDto
    estimatedCostUsd: float
    event: dict[str, Any] | None = None


class FollowUpRequest(BaseModel):
    question: str
    answerMarkdown: str


class LearningEventResponse(BaseModel):
    id: str
    interactionMode: str
    eventType: str
    classificationConfidence: float
    subject: str
    chapter: str
    grade: str
    createdAt: str
    updatedAt: str
    writeStatus: str
    originalQuestion: str
    questionText: str
    questionImage: str
    questionImageMissing: bool
    reasoningMarkdown: str
    finalAnswerMarkdown: str
    answerRevealed: bool
    answerRevealedAt: str
    knowledgeSuggestions: list[str]
    relatedKnowledge: list[str]
    mistakeReason: str
    masterySuggestion: int
    followUps: list[dict[str, str]]


class WikiPageSummary(BaseModel):
    id: str
    title: str
    type: str
    subject: str = ""
    chapter: str = ""
    knowledgePoint: str = ""
    status: str = ""
    path: str
    updatedAt: str


class WikiPage(WikiPageSummary):
    markdown: str


class WikiGraphNode(BaseModel):
    id: str
    label: str
    type: str
    subject: str = ""
    chapter: str = ""
    mistakeCount: int = 0
    avgMastery: float = 0
    weaknessScore: float = 0
    hot: bool = False
    lastSeenAt: str = ""
    pageId: str = ""


class WikiGraphEdge(BaseModel):
    source: str
    target: str
    type: str
    weight: int = 1
    confidence: str = "extracted"


class WikiGraphSummary(BaseModel):
    topWeakNodes: list[WikiGraphNode] = Field(default_factory=list)
    prerequisiteGaps: list[WikiGraphNode] = Field(default_factory=list)
    repeatedReasons: list[WikiGraphNode] = Field(default_factory=list)
    subjectCoverage: list[dict[str, Any]] = Field(default_factory=list)


class WikiGraphResponse(BaseModel):
    nodes: list[WikiGraphNode]
    edges: list[WikiGraphEdge]
    summary: WikiGraphSummary


class FlashcardItem(BaseModel):
    frontMarkdown: str
    backMarkdown: str
    knowledgePoint: str = ""
    sourceMistakeIds: list[str] = Field(default_factory=list)
    masteryTag: str = "review"


class WikiActionRequest(BaseModel):
    action: str = "lint"
    subject: str = ""
    knowledgePoint: str = ""
    dateRange: str = "all"
    difficulty: str = "基础"
    count: int = Field(default=5, ge=1, le=30)
    promptTemplate: str = ""
    config: AiConfig
    profile: TutorProfile


class WikiActionResponse(BaseModel):
    markdown: str
    pageId: str
    filePath: str
    estimatedCostUsd: float = 0
    flashcards: list[FlashcardItem] = Field(default_factory=list)


class CurriculumImportRequest(BaseModel):
    subject: str
    markdown: str = ""
    jsonData: dict[str, Any] | None = None


class WikiReclassifyRequest(BaseModel):
    pageId: str
    subject: str = ""
    chapter: str = ""


class PromoteEventRequest(BaseModel):
    knowledgePoint: str = ""


class KnowledgeStatusRequest(BaseModel):
    status: str


def estimate_cost(req: TutorRequest, output_tokens: int = 800) -> float:
    text_tokens = max(200, len(req.questionAudioText) // 2 + len(req.profile.style) // 2)
    image_cost = 0.004 if req.imageDataUrl and req.config.allowImageUpload else 0
    token_cost = (text_tokens / 1_000_000) * 0.15 + (output_tokens / 1_000_000) * 0.6
    return round(image_cost + token_cost, 5)


def today_cost(db: Session) -> float:
    since = utcnow() - timedelta(hours=24)
    rows = db.scalars(select(AiCall).where(AiCall.created_at >= since, AiCall.success == True)).all()  # noqa: E712
    return sum(row.estimated_cost_usd for row in rows)


def learning_event_to_response(event: LearningEvent) -> LearningEventResponse:
    return LearningEventResponse(
        id=event.id,
        interactionMode=event.interaction_mode,
        eventType=event.event_type,
        classificationConfidence=event.classification_confidence,
        subject=event.subject,
        chapter=event.chapter,
        grade=event.grade,
        createdAt=event.created_at,
        updatedAt=event.updated_at,
        writeStatus=event.write_status,
        originalQuestion=event.original_question,
        questionText=event.question_text,
        questionImage=event.question_image,
        questionImageMissing=event.question_image_missing,
        reasoningMarkdown=event.reasoning_markdown,
        finalAnswerMarkdown=event.final_answer_markdown,
        answerRevealed=event.answer_revealed,
        answerRevealedAt=event.answer_revealed_at,
        knowledgeSuggestions=event.knowledge_suggestions,
        relatedKnowledge=event.related_knowledge,
        mistakeReason=event.mistake_reason,
        masterySuggestion=event.mastery_suggestion,
        followUps=[
            {"askedAt": item.asked_at, "question": item.question, "answerMarkdown": item.answer_markdown}
            for item in event.follow_ups
        ],
    )


def sync_learning_event_index(db: Session, event: LearningEvent) -> None:
    row = db.get(LearningEventIndex, event.id) or LearningEventIndex(
        id=event.id,
        created_at=datetime.fromisoformat(event.created_at),
        updated_at=datetime.fromisoformat(event.updated_at),
        interaction_mode=event.interaction_mode,
        event_type=event.event_type,
        file_path=str(EVENT_STORE._storage_path(event).resolve()),
    )
    row.updated_at = datetime.fromisoformat(event.updated_at)
    row.interaction_mode = event.interaction_mode
    row.event_type = event.event_type
    row.subject = event.subject
    row.chapter = event.chapter
    row.write_status = event.write_status
    row.question_text = event.question_text
    row.original_question = event.original_question
    row.file_path = str(EVENT_STORE._storage_path(event).resolve())
    db.add(row)


def rebuild_learning_event_index(db: Session) -> int:
    db.query(LearningEventIndex).delete()
    events = EVENT_STORE.list(limit=100_000)
    for event in events:
        sync_learning_event_index(db, event)
    db.commit()
    return len(events)


def create_tutor_event(req: TutorRequest) -> LearningEvent:
    if req.interactionMode == "followup":
        if not req.eventId:
            raise HTTPException(status_code=400, detail="追问必须关联已有学习事件，不能创建新的知识点或学习事件。")
        try:
            return EVENT_STORE.get(req.eventId)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="关联的学习事件不存在，请重新选择题目或发起新问题。")
    if req.eventId:
        raise HTTPException(status_code=400, detail="只有上下文追问可以关联已有学习事件。新问题必须创建新的学习事件。")
    return EVENT_STORE.create_draft(
        interaction_mode=req.interactionMode,
        original_question=req.questionAudioText,
        grade=req.profile.grade,
        image_data_url=req.imageDataUrl if req.config.allowImageUpload else None,
    )


def tutor_prompt_question(req: TutorRequest, event: LearningEvent) -> str:
    if req.interactionMode != "followup":
        return req.questionAudioText
    history = "\n".join(
        f"学生追问：{item.question}\nAI 回答：{item.answer_markdown}"
        for item in event.follow_ups[-4:]
    )
    return (
        "【同一学习事件的上下文追问】\n"
        f"题干：{event.question_text or '题干待补录'}\n"
        f"首次问题：{event.original_question}\n"
        f"此前解题思路：{event.reasoning_markdown}\n"
        f"此前追问：{history or '暂无'}\n"
        f"孩子本次追问：{req.questionAudioText}\n"
        "只回答本次追问，不要重新完整解题。"
    )


def event_completion_data(req: TutorRequest, data: dict[str, Any], subject: str, chapter: str) -> dict[str, Any]:
    reported_confidence = data.get("classification_confidence")
    if req.interactionMode == "voice":
        event_type = "question"
        confidence = float(reported_confidence) if reported_confidence is not None else 0.95
    else:
        mastery = max(0, min(100, int(data.get("mastery") or 0)))
        event_type = "wrong" if mastery > 0 else "stuck"
        confidence = float(reported_confidence) if reported_confidence is not None else 0.82
    return {
        **data,
        "subject": subject,
        "chapter": chapter,
        "event_type": event_type,
        "classification_confidence": confidence,
        "knowledge_suggestions": normalize_text_list(data.get("knowledge_point")),
    }


def ingest_completed_tutor_event(
    db: Session,
    event: LearningEvent,
    subject: str,
    chapter: str,
    knowledge_point: str,
    data: dict[str, Any],
) -> None:
    try:
        decision = IngestDecision(
            confidence=max(0, min(1, event.classification_confidence)),
            subject=subject,
            chapter=chapter,
            short_title=knowledge_point[:20],
            full_title=knowledge_point,
            common_reasons=normalize_text_list(data.get("mistake_reason")),
            prerequisites=normalize_text_list(data.get("prerequisites")),
        )
        WIKI_INGEST.ingest_event(event, decision)
        refreshed = EVENT_STORE.get(event.id)
        sync_learning_event_index(db, refreshed)
    except Exception:
        logger.exception("Lightweight Wiki ingest failed for event %s", event.id)


def normalize_text_list(value: Any) -> list[str]:
    if isinstance(value, list):
        items = value
    elif isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        try:
            parsed = json.loads(stripped)
            items = parsed if isinstance(parsed, list) else re.split(r"[,，、\n]+", stripped)
        except json.JSONDecodeError:
            items = re.split(r"[,，、\n]+", stripped)
    else:
        return []
    result: list[str] = []
    for item in items:
        text_value = str(item).strip()
        if text_value and text_value not in result:
            result.append(text_value[:120])
    return result[:12]


def row_prerequisites(row: Mistake) -> list[str]:
    return normalize_text_list(row.prerequisites_json)


def dump_prerequisites(items: list[str]) -> str:
    return json.dumps(normalize_text_list(items), ensure_ascii=False)


def infer_chapter(subject: str, knowledge_point: str, context: str = "") -> str:
    text_value = f"{subject} {knowledge_point} {context}".lower()
    rules = [
        ("数学", ["分数", "裂项", "相消", "通分", "约分", "frac"], "数与运算"),
        ("数学", ["方程", "未知数", "x", "equation"], "方程与代数"),
        ("数学", ["几何", "面积", "角", "图形"], "图形与几何"),
        ("英语", ["phonetics", "音标", "vocabulary", "grammar", "sentence", "word"], "词汇与语法"),
        ("语文", ["阅读", "作文", "古诗", "拼音"], "阅读与表达"),
        ("科学", ["实验", "物理", "化学", "生物"], "科学探究"),
    ]
    for rule_subject, tokens, chapter in rules:
        if subject == rule_subject and any(token.lower() in text_value for token in tokens):
            return chapter
    return "未归类章节"


def mistake_to_dto(row: Mistake) -> MistakeDto:
    return MistakeDto(
        id=row.id,
        createdAt=row.created_at.isoformat(),
        subject=row.subject,
        grade=row.grade,
        knowledgePoint=row.knowledge_point,
        mistakeReason=row.mistake_reason,
        mastery=row.mastery,
        questionText=row.question_text,
        studentQuestion=row.student_question,
        answerMarkdown=row.answer_markdown,
        correctAnswerMarkdown=row.correct_answer_markdown,
        chapter=row.chapter,
        prerequisites=row_prerequisites(row),
        wikiPageId=row.wiki_page_id,
        imageDataUrl=row.image_data_url,
    )


def mistake_to_list_dto(row: Mistake) -> MistakeDto:
    dto = mistake_to_dto(row)
    dto.imageDataUrl = ""
    return dto


def safe_filename(value: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\s]+', "_", value.strip())
    return cleaned[:80] or "未归类"


def wiki_markdown(knowledge_point: str, items: list[Mistake]) -> str:
    subject = items[0].subject if items else "未分类"
    lines = [
        f"# {knowledge_point}",
        "",
        f"- 学科：{subject}",
        f"- 出现次数：{len(items)}",
        f"- 平均掌握度：{round(sum(item.mastery for item in items) / max(len(items), 1))}%",
        "",
        "## 相关错题",
    ]
    for item in items[:20]:
        lines.extend(
            [
                "",
                f"### {item.created_at.date()} · 掌握度 {item.mastery}%",
                f"- 题干：{item.question_text or '未提取'}",
                f"- 学生问题：{item.student_question or '未记录'}",
                f"- 错因：{item.mistake_reason or '待分析'}",
            ]
        )
    lines.extend(
        [
            "",
            "## 复习建议",
            "",
            "先让孩子口头复述这个知识点，再做两道相似题，最后解释每一步为什么这样做。",
        ]
    )
    return "\n".join(lines)


def rebuild_wiki_files(db: Session) -> list[dict[str, Any]]:
    rows = db.scalars(select(Mistake)).all()
    grouped: dict[tuple[str, str], list[Mistake]] = {}
    for row in rows:
        normalized_subject = normalize_subject(
            row.subject,
            row.question_text,
            row.student_question,
            f"{row.answer_markdown}\n{row.knowledge_point}\n{row.mistake_reason}",
        )
        if normalized_subject != row.subject:
            row.subject = normalized_subject
        knowledge_point = row.knowledge_point or "未归类知识点"
        grouped.setdefault((normalized_subject, knowledge_point), []).append(row)
    db.commit()

    WIKI_DIR.mkdir(parents=True, exist_ok=True)
    for old_file in WIKI_DIR.glob("*.md"):
        old_file.unlink()

    result = []
    for (subject, key), items in sorted(grouped.items(), key=lambda pair: len(pair[1]), reverse=True):
        markdown = wiki_markdown(key, items)
        file_path = WIKI_DIR / f"{safe_filename(subject)}__{safe_filename(key)}.md"
        file_path.write_text(markdown, encoding="utf-8")
        result.append(
            {
                "knowledgePoint": key,
                "subject": subject,
                "count": len(items),
                "isHot": len(items) >= 3,
                "markdown": markdown,
                "filePath": str(file_path.resolve()),
            }
        )
    return result


def wiki_rel_path(path: Path) -> str:
    return path.relative_to(WIKI_DIR).as_posix()


def wiki_page_id_from_rel(rel_path: str) -> str:
    return rel_path.removesuffix(".md").replace("/", "__")


def title_from_wiki_path(path: Path, markdown: str = "") -> str:
    first_line = markdown.splitlines()[0].strip() if markdown else ""
    if first_line.startswith("#"):
        return first_line.lstrip("#").strip()
    return path.stem.replace("_", " ")


def write_wiki_file(path: Path, markdown: str) -> None:
    with WIKI_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(markdown, encoding="utf-8")


def mistake_created_at(row: Mistake) -> datetime:
    """Return a stable timestamp even before SQLAlchemy applies insert defaults."""
    if row.created_at is None:
        row.created_at = utcnow()
    return row.created_at


def mistake_page_rel(row: Mistake) -> str:
    return f"mistakes/{mistake_created_at(row).strftime('%Y%m%d')}_{safe_filename(row.id[:8])}.md"


def knowledge_page_rel(subject: str, knowledge_point: str) -> str:
    return f"knowledge/{safe_filename(subject)}__{safe_filename(knowledge_point)}.md"


def read_knowledge_status(markdown: str) -> str:
    match = re.search(r"^- 状态：(\w+)", markdown, re.M)
    return match.group(1) if match else "weak"


def update_knowledge_status_markdown(markdown: str, status: str) -> str:
    if re.search(r"^- 状态：", markdown, re.M):
        return re.sub(r"^- 状态：.*$", f"- 状态：{status}", markdown, count=1, flags=re.M)
    lines = markdown.splitlines()
    insert_at = 2 if len(lines) >= 2 else len(lines)
    lines.insert(insert_at, f"- 状态：{status}")
    return "\n".join(lines)


def excluded_review_knowledge() -> set[str]:
    excluded: set[str] = set()
    knowledge_dir = WIKI_DIR / "knowledge"
    if not knowledge_dir.exists():
        return excluded
    for path in knowledge_dir.glob("*.md"):
        markdown = path.read_text(encoding="utf-8")
        if read_knowledge_status(markdown) in {"mastered", "ignored"}:
            pieces = path.stem.split("__", 1)
            excluded.add(pieces[1] if len(pieces) > 1 else title_from_wiki_path(path, markdown))
    return excluded


def promote_event_to_knowledge(event: LearningEvent, knowledge_point: str = "") -> WikiPage:
    knowledge = knowledge_point.strip() or (event.knowledge_suggestions[0] if event.knowledge_suggestions else "待命名知识点")
    subject = event.subject or "未分类"
    path = WIKI_DIR / knowledge_page_rel(subject, knowledge)
    event_link = Path(os.path.relpath(EVENT_STORE._event_path(event), path.parent)).as_posix()
    if path.exists():
        markdown = path.read_text(encoding="utf-8")
        if event.id not in markdown:
            markdown += f"\n- [{event.id}]({event_link})：{event.question_text or event.original_question}\n"
    else:
        markdown = "\n".join(
            [
                f"# {knowledge}",
                "",
                "- 状态：weak",
                f"- 学科：{subject}",
                f"- 章节：{event.chapter or '未归类章节'}",
                f"- 首次发现：{event.created_at}",
                f"- 最近活动：{event.updated_at}",
                "",
                "## 核心概念",
                "",
                event.reasoning_markdown or "等待整理补全。",
                "",
                "## 常见错因",
                "",
                event.mistake_reason or "暂无",
                "",
                "## 来源事件",
                "",
                f"- [{event.id}]({event_link})：{event.question_text or event.original_question}",
                "",
            ]
        )
    write_wiki_file(path, markdown)
    event.related_knowledge = sorted(set([*event.related_knowledge, wiki_page_id_from_rel(knowledge_page_rel(subject, knowledge))]))
    EVENT_STORE.save(event)
    return find_wiki_page(wiki_page_id_from_rel(knowledge_page_rel(subject, knowledge)))


def subject_page_rel(subject: str) -> str:
    return f"subjects/{safe_filename(subject)}/index.md"


def chapter_page_rel(subject: str, chapter: str) -> str:
    return f"subjects/{safe_filename(subject)}/chapters/{safe_filename(chapter)}.md"


def mistake_markdown(row: Mistake) -> str:
    created_at = mistake_created_at(row)
    question_text = row.question_text.strip() or "题干待家长补录"
    correct_answer = row.correct_answer_markdown.strip() or row.answer_markdown.strip() or "正确解法待补充"
    prerequisites = row_prerequisites(row)
    lines = [
        f"# 错题 {created_at.strftime('%Y-%m-%d')} · {row.knowledge_point or '未归类知识点'}",
        "",
        "## 基本信息",
        "",
        f"- 学科：{row.subject or '未分类'}",
        f"- 年级：{row.grade or '未记录'}",
        f"- 章节：{row.chapter or '未归类章节'}",
        f"- 知识点：{row.knowledge_point or '未归类知识点'}",
        f"- 掌握度：{row.mastery}%",
        f"- 错因：{row.mistake_reason or '待分析'}",
        f"- 前置知识：{', '.join(prerequisites) if prerequisites else '暂无'}",
        "",
        "## 题干",
        "",
        question_text,
        "",
        "## 学生问题",
        "",
        row.student_question.strip() or "未记录",
        "",
        "## 正确解法",
        "",
        correct_answer,
        "",
        "## AI 讲解",
        "",
        row.answer_markdown.strip() or "暂无讲解",
        "",
        "## 复习建议",
        "",
        "先让孩子复述题目已知条件和目标，再用相邻例题确认是否真正掌握。",
    ]
    return "\n".join(lines)


def knowledge_markdown(subject: str, knowledge_point: str, items: list[Mistake]) -> str:
    avg_mastery = round(sum(item.mastery for item in items) / max(len(items), 1))
    reasons: dict[str, int] = {}
    prerequisites: dict[str, int] = {}
    for item in items:
        if item.mistake_reason:
            reasons[item.mistake_reason] = reasons.get(item.mistake_reason, 0) + 1
        for pre in row_prerequisites(item):
            prerequisites[pre] = prerequisites.get(pre, 0) + 1
    lines = [
        f"# {knowledge_point}",
        "",
        f"- 学科：{subject}",
        f"- 错题次数：{len(items)}",
        f"- 平均掌握度：{avg_mastery}%",
        f"- 高频错因：{', '.join(sorted(reasons, key=reasons.get, reverse=True)[:5]) or '暂无'}",
        f"- 可能缺口：{', '.join(sorted(prerequisites, key=prerequisites.get, reverse=True)[:5]) or '暂无'}",
        "",
        "## 相关错题",
    ]
    for item in sorted(items, key=lambda row: row.created_at, reverse=True)[:50]:
        rel = mistake_page_rel(item)
        lines.append(f"- [{item.created_at.date()} · 掌握度 {item.mastery}%](../{rel})：{item.question_text[:80] or '题干待家长补录'}")
    lines.extend(
        [
            "",
            "## 复习路径",
            "",
            "1. 先复述概念和适用条件。",
            "2. 再做一道同型基础题。",
            "3. 最后做一道变式题，观察是否还会出现同样错因。",
        ]
    )
    return "\n".join(lines)


def chapter_markdown(subject: str, chapter: str, items: list[Mistake]) -> str:
    knowledge_points: dict[str, list[Mistake]] = {}
    for item in items:
        knowledge_points.setdefault(item.knowledge_point or "未归类知识点", []).append(item)
    lines = [
        f"# {chapter}",
        "",
        f"- 学科：{subject}",
        f"- 覆盖知识点：{len(knowledge_points)}",
        f"- 相关错题：{len(items)}",
        "",
        "## 知识点树",
    ]
    for knowledge, rows in sorted(knowledge_points.items(), key=lambda pair: len(pair[1]), reverse=True):
        rel = knowledge_page_rel(subject, knowledge)
        avg = round(sum(row.mastery for row in rows) / max(len(rows), 1))
        lines.append(f"- [{knowledge}](../../../{rel})：{len(rows)} 次，平均掌握度 {avg}%")
    return "\n".join(lines)


def subject_markdown(subject: str, items: list[Mistake]) -> str:
    chapters: dict[str, list[Mistake]] = {}
    for item in items:
        chapters.setdefault(item.chapter or "未归类章节", []).append(item)
    avg_mastery = round(sum(item.mastery for item in items) / max(len(items), 1))
    lines = [
        f"# {subject}",
        "",
        f"- 错题总数：{len(items)}",
        f"- 平均掌握度：{avg_mastery}%",
        f"- 章节数：{len(chapters)}",
        "",
        "## 章节",
    ]
    for chapter, rows in sorted(chapters.items(), key=lambda pair: len(pair[1]), reverse=True):
        lines.append(f"- [章节：{chapter}](chapters/{safe_filename(chapter)}.md)：{len(rows)} 次")
    return "\n".join(lines)


def _rebuild_wiki_files_unlocked(db: Session) -> list[dict[str, Any]]:
    rows = db.scalars(select(Mistake)).all()
    grouped: dict[tuple[str, str], list[Mistake]] = {}
    by_subject: dict[str, list[Mistake]] = {}
    by_chapter: dict[tuple[str, str], list[Mistake]] = {}
    for row in rows:
        normalized_subject = normalize_subject(
            row.subject,
            row.question_text,
            row.student_question,
            f"{row.answer_markdown}\n{row.knowledge_point}\n{row.mistake_reason}",
        )
        row.subject = normalized_subject
        row.knowledge_point = row.knowledge_point or "未归类知识点"
        row.question_text = row.question_text.strip() or "题干待家长补录"
        row.correct_answer_markdown = row.correct_answer_markdown or row.answer_markdown or "正确解法待补充"
        row.chapter = row.chapter or infer_chapter(row.subject, row.knowledge_point, row.question_text)
        row.prerequisites_json = dump_prerequisites(row_prerequisites(row))
        row.wiki_page_id = wiki_page_id_from_rel(mistake_page_rel(row))
        grouped.setdefault((row.subject, row.knowledge_point), []).append(row)
        by_subject.setdefault(row.subject, []).append(row)
        by_chapter.setdefault((row.subject, row.chapter), []).append(row)
    db.commit()

    WIKI_DIR.mkdir(parents=True, exist_ok=True)
    for rel in ["mistakes"]:
        target = WIKI_DIR / rel
        if target.exists():
            shutil.rmtree(target)
    index_file = WIKI_DIR / "index.md"
    if index_file.exists():
        index_file.unlink()
    subjects_dir = WIKI_DIR / "subjects"
    if subjects_dir.exists():
        for subject_dir in subjects_dir.iterdir():
            if not subject_dir.is_dir():
                continue
            subject_index = subject_dir / "index.md"
            if subject_index.exists():
                subject_index.unlink()
            chapters_dir = subject_dir / "chapters"
            if chapters_dir.exists():
                shutil.rmtree(chapters_dir)

    for row in rows:
        write_wiki_file(WIKI_DIR / mistake_page_rel(row), mistake_markdown(row))

    result = []
    for (subject, key), items in sorted(grouped.items(), key=lambda pair: len(pair[1]), reverse=True):
        markdown = knowledge_markdown(subject, key, items)
        file_path = WIKI_DIR / knowledge_page_rel(subject, key)
        if not file_path.exists():
            write_wiki_file(file_path, markdown)
        else:
            markdown = file_path.read_text(encoding="utf-8")
        result.append(
            {
                "knowledgePoint": key,
                "subject": subject,
                "count": len(items),
                "isHot": len(items) >= 3,
                "markdown": markdown,
                "filePath": str(file_path.resolve()),
            }
        )

    for (subject, chapter), items in sorted(by_chapter.items()):
        write_wiki_file(WIKI_DIR / chapter_page_rel(subject, chapter), chapter_markdown(subject, chapter, items))
    for subject, items in sorted(by_subject.items()):
        write_wiki_file(WIKI_DIR / subject_page_rel(subject), subject_markdown(subject, items))

    index_lines = [
        "# FocusLens Wiki",
        "",
        "本地 Wiki 由日常 AI 解题自动沉淀，包含错题页、知识点页、章节树和薄弱图谱。",
        "",
        "## 学科总览",
    ]
    for subject, items in sorted(by_subject.items(), key=lambda pair: len(pair[1]), reverse=True):
        index_lines.append(f"- [{subject}]({subject_page_rel(subject)})：{len(items)} 道错题")
    write_wiki_file(WIKI_DIR / "index.md", "\n".join(index_lines))
    return result


def rebuild_wiki_files(db: Session) -> list[dict[str, Any]]:  # type: ignore[no-redef]
    with WIKI_LOCK:
        return _rebuild_wiki_files_unlocked(db)


def heuristic_answer(req: TutorRequest) -> dict[str, Any]:
    knowledge_point = "问题解析与关系提取"
    text = req.questionAudioText.lower()
    if "fraction" in text or "fen" in text or "分数" in text:
        knowledge_point = "分数运算"
    elif "equation" in text or "x" in text or "方程" in text:
        knowledge_point = "一元一次方程"

    answer = """## 我们先把题目慢下来

在直接找最终答案之前，先引导孩子说出三件事：

1. **已知条件**：题目中已经给出了哪些数字或信息？
2. **要求什么**：最后要算的是什么？
3. **数量关系**：这些信息之间是什么关系？

对于数学题，可以把关系翻译成一个简单等式，例如 `$a + b = c$`。

### 小提示

如果有一个不知道的数，可以先用 `$x$` 表示它，再把题目里的话变成方程。

### 练习方式

让孩子试着说：“我知道 __，需要求 __，它们的关系是 __。”然后再继续下笔。"""
    return {
        "answer_markdown": answer,
        "subject": "数学",
        "knowledge_point": knowledge_point,
        "mistake_reason": "孩子可能还没有清楚提取题目中的已知条件和未知量。",
        "question_text": "",
        "correct_answer_markdown": answer,
        "chapter": infer_chapter("数学", knowledge_point, req.questionAudioText),
        "prerequisites": ["提取已知条件", "建立数量关系"],
        "mastery": 0,
    }


def parse_json_block(text: str) -> dict[str, Any] | None:
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return None
    json_str = match.group(0)
    try:
        parsed = json.loads(json_str)
        if isinstance(parsed, str):
            parsed = json.loads(parsed)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    res: dict[str, Any] = {}
    keys = [
        "subject",
        "answer_markdown",
        "correct_answer_markdown",
        "knowledge_point",
        "mistake_reason",
        "question_text",
        "chapter",
        "mastery",
    ]
    for key in keys:
        next_keys = "|".join(re.escape(name) for name in keys if name != key)
        item = re.search(rf'"{key}"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:{next_keys})"\s*:', json_str)
        pattern = rf'"{key}"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"'
        if not item:
            item = re.search(pattern, json_str)
        if item:
            value = item.group(1)
            try:
                res[key] = json.loads(f'"{value}"')
            except json.JSONDecodeError:
                res[key] = value.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
        elif key == "mastery":
            m_int = re.search(r'"mastery"\s*:\s*(\d+)', json_str)
            if m_int:
                res[key] = int(m_int.group(1))

    if "answer_markdown" in res:
        res.setdefault("subject", "数学")
        res.setdefault("knowledge_point", "未归类知识点")
        res.setdefault("mistake_reason", "待分析")
        res.setdefault("question_text", "")
        res.setdefault("correct_answer_markdown", res.get("answer_markdown", ""))
        res.setdefault("chapter", "")
        res.setdefault("prerequisites", [])
        res.setdefault("mastery", 0)
        return res

    return None


def normalize_subject(value: Any, question_text: Any = "", student_question: Any = "", extra_context: Any = "") -> str:
    raw = str(value or "").strip()
    text = f"{raw}\n{question_text or ''}\n{student_question or ''}\n{extra_context or ''}".lower()

    math_terms = [
        "数学", "math", "方程", "计算", "应用题", "几何", "分数", "小数",
        "裂项", "相消", "通分", "约分", "因式", "代数", "函数", "比例",
        "frac", "equation", "calculate", "solve for"
    ]
    if any(token in text for token in math_terms):
        return "数学"

    english_terms = [
        "english", "read and", "choose", "complete", "sentence", "sentences",
        "dialogue", "grammar", "vocabulary", "word", "words", "write the",
        "listen", "match", "fill in", "true or false"
    ]
    latin_words = re.findall(r"\b[a-zA-Z]{2,}\b", text)
    if "英语" in text or any(term in text for term in english_terms) or len(latin_words) >= 3:
        return "英语"

    if any(token in text for token in ["数学", "math", "方程", "计算", "应用题", "几何", "分数", "小数"]):
        return "数学"
    if any(token in text for token in ["语文", "chinese", "阅读理解", "作文", "拼音", "古诗", "文言文", "标点"]):
        return "语文"
    if any(token in text for token in ["科学", "science", "物理", "化学", "生物", "实验"]):
        return "科学"

    if "英" in raw:
        return "英语"
    if "数" in raw:
        return "数学"
    if "语" in raw or "文" in raw:
        return "语文"
    if "科" in raw:
        return "科学"
    return raw or "其他"


def resolve_ai_url(ai_base_url: str) -> str:
    base = ai_base_url.strip().rstrip("/")
    if not base:
        return "https://api.openai.com/v1/chat/completions"
    if "/v1/chat/completions" in base:
        return base
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def resolve_openai_endpoint(base_url: str, endpoint: str) -> str:
    base = base_url.strip().rstrip("/")
    endpoint = endpoint.strip("/")
    if not base:
        base = "https://api.openai.com/v1"
    if base.endswith(f"/{endpoint}"):
        return base
    if base.endswith("/v1"):
        return f"{base}/{endpoint}"
    return f"{base}/v1/{endpoint}"


def upstream_error_message(text: str) -> str:
    if not text:
        return "Upstream AI returned an empty error response."
    try:
        data = json.loads(text)
        error = data.get("error") if isinstance(data, dict) else None
        if isinstance(error, dict):
            message = error.get("message") or error.get("code") or text
            code = error.get("code")
            error_type = error.get("type")
            suffix = " ".join(str(item) for item in [error_type, code] if item)
            return f"{message}{f' ({suffix})' if suffix else ''}"
        detail = data.get("detail") if isinstance(data, dict) else None
        if detail:
            return str(detail)
    except json.JSONDecodeError:
        pass
    return text[:800]


def extract_openai_message_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    message = first.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        if parts:
            return "".join(parts).strip()
    parts = message.get("parts")
    if isinstance(parts, list):
        text_value = "".join(
            item.get("text", "")
            for item in parts
            if isinstance(item, dict) and isinstance(item.get("text"), str)
        ).strip()
        if text_value:
            return text_value
    reasoning = message.get("reasoning_content")
    return reasoning.strip() if isinstance(reasoning, str) else ""


async def test_openai_compatible(config: AiConfig) -> AiConnectionTestResponse:
    api_key = config.apiKey.strip() if config.apiKey else AI_API_KEY
    resolved_url = resolve_ai_url(config.aiBaseUrl)
    if not api_key:
        return AiConnectionTestResponse(
            ok=False,
            status=0,
            latencyMs=0,
            resolvedUrl=resolved_url,
            message="API Key is empty. Fill the third-party API Key before testing.",
        )

    payload = {
        "model": config.model,
        "messages": [{"role": "user", "content": "ping"}],
        "temperature": 0,
        "max_tokens": 8,
        "stream": False,
    }
    started = datetime.utcnow()
    try:
        async with httpx.AsyncClient(timeout=8, verify=not config.allowInsecureAiTls) as client:
            res = await client.post(
                resolved_url,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.TimeoutException:
        latency = int((datetime.utcnow() - started).total_seconds() * 1000)
        return AiConnectionTestResponse(
            ok=False,
            status=504,
            latencyMs=latency,
            resolvedUrl=resolved_url,
            message="Third-party AI test timed out after 8 seconds.",
        )
    except httpx.HTTPError as exc:
        latency = int((datetime.utcnow() - started).total_seconds() * 1000)
        return AiConnectionTestResponse(
            ok=False,
            status=502,
            latencyMs=latency,
            resolvedUrl=resolved_url,
            message=f"Third-party AI connection failed: {exc}",
        )

    latency = int((datetime.utcnow() - started).total_seconds() * 1000)
    if res.status_code >= 400:
        return AiConnectionTestResponse(
            ok=False,
            status=res.status_code,
            latencyMs=latency,
            resolvedUrl=resolved_url,
            message=upstream_error_message(res.text),
        )
    return AiConnectionTestResponse(
        ok=True,
        status=res.status_code,
        latencyMs=latency,
        resolvedUrl=resolved_url,
        message="Third-party AI text request succeeded.",
    )


async def call_openai_compatible(req: TutorRequest) -> dict[str, Any]:
    api_key = req.config.apiKey.strip() if req.config.apiKey else AI_API_KEY
    if not api_key:
        return heuristic_answer(req)

    # 思考模式：关闭时加 /no_think，让 Qwen3 跳过推理链直接输出，大幅提速
    think_prefix = "" if req.config.enableThinking else "/no_think "
    mode_instruction = {
        "voice": "这是简单语音知识问答。请直接、简短回答孩子的问题，不要假设存在题目图片。",
        "followup": "这是同一题目的追问。只解释孩子本次卡住的小点，不要从头重复完整解题。",
    }.get(req.interactionMode, "这是拍题求助。先提供可执行的启发式解题思路；完整解法与结论单独写入 correct_answer_markdown。")
    prompt = (
        think_prefix
        + "你是一位温和的儿童 AI 老师。请用中文回答，并使用 Markdown + LaTeX 表达数学公式。"
        + mode_instruction
        +
        "你需要从图片和语音问题中自动判断学科。含英文题干、英文阅读、单词、语法、对话或选择填空题时，subject 必须是“英语”，不要归为“语文”。"
        "如果孩子语音里明确说了第几题，例如“第33题”，必须优先定位这个题号；若题号和手指位置冲突，以语音题号为准。"
        "请尽量从图片中提取题干文字，写入 question_text；看不清时写空字符串。"
        "除非配置允许直接给最终答案，否则先启发孩子说出思路，再给下一小步。"
        "mastery 必须是 0 到 100 的整数，表示孩子当前对该知识点的掌握度。"
        "如果卷面没有任何有效作答或看不清作答，mastery=0；如果只写了一点思路但未形成解法，给 10-30；"
        "如果思路基本对但计算或表达有错，给 40-70；如果基本独立完成只需小修正，给 80-95。"
        "请只返回 JSON 对象，字段包括：subject, answer_markdown, knowledge_point, "
        "mistake_reason, question_text, correct_answer_markdown, chapter, prerequisites, mastery。"
        "answer_markdown 请控制在 500 个中文字符内，使用 3 到 5 个清晰步骤；不要在 JSON 外输出推理过程或额外文字。"
        "correct_answer_markdown 不是只写最终结果；必须展示已知条件、完整推导或计算步骤、必要检查，并把最终结论放在末尾。"
        "如果这是 followup 上下文追问，只回答本次追问，correct_answer_markdown 返回空字符串；系统会保留原学习事件中的完整解法。"
        f"年级：{req.profile.grade}。讲解风格：{req.profile.style}。"
        f"是否允许直接给最终答案：{req.profile.allowDirectAnswer}。"
        f"孩子语音问题：{req.questionAudioText}"
    )
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    if req.imageDataUrl and req.config.allowImageUpload:
        content.append({"type": "image_url", "image_url": {"url": req.imageDataUrl}})

    payload: dict[str, Any] = {
        "model": req.config.model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.2,
        "max_tokens": 1800,
    }

    try:
        async with httpx.AsyncClient(timeout=55, verify=not req.config.allowInsecureAiTls) as client:
            res = await client.post(
                resolve_ai_url(req.config.aiBaseUrl),
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="第三方 AI 接口超时。可以先改用只截卷面框，或换用响应更快的多模态模型。") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"第三方 AI 接口连接失败：{exc}") from exc
    if res.status_code >= 400:
        raise HTTPException(status_code=502, detail=res.text)

    resp_json = res.json()
    message = resp_json.get("choices", [{}])[0].get("message", {})
    # 思考模型（如 Qwen3.5-Thinking）推理阶段 content=null，从 reasoning_content 兜底
    text: str | None = message.get("content")
    if not text:
        parts = message.get("parts") or []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
    if not text:
        text = message.get("reasoning_content") or ""
    if not text:
        # AI 返回内容为空，降级到启发式回答
        return heuristic_answer(req)

    parsed = parse_json_block(text)
    if parsed:
        return parsed
    data = heuristic_answer(req)
    data["answer_markdown"] = text
    return data


async def recognize_memo_todos(req: MemoRequest) -> MemoResponse:
    api_key = req.config.apiKey.strip() if req.config.apiKey else AI_API_KEY
    if not api_key:
        return MemoResponse(todos=[], note="未配置 API Key，无法识别手写备忘录。")
    if not req.imageDataUrl:
        return MemoResponse(todos=[], note="没有可识别的备忘录图片。")

    think_prefix = "" if req.config.enableThinking else "/no_think "
    prompt = (
        think_prefix
        + "请从图片中的学生手写备忘录、作业清单或家长记录中提取作业条目。"
        "只提取需要写入学习日历 To do 的任务，不要提取无关涂鸦。"
        "请把同一项作业合并成一条，保留学科、页码、题号、背诵/朗读/订正等关键信息。"
        "如果图片里写了日期，优先使用图片日期；否则使用 selected_date。"
        "只返回 JSON 对象，格式为 {\"todos\":[\"任务1\",\"任务2\"],\"note\":\"简短说明\"}。"
        f"selected_date: {req.selectedDate}。年级：{req.profile.grade}。"
    )
    payload: dict[str, Any] = {
        "model": req.config.model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": req.imageDataUrl}},
                ],
            }
        ],
        "temperature": 0.1,
        "max_tokens": 6000,
    }
    try:
        async with httpx.AsyncClient(timeout=55, verify=not req.config.allowInsecureAiTls) as client:
            res = await client.post(
                resolve_ai_url(req.config.aiBaseUrl),
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="手写备忘录识别超时，请靠近拍摄或只截备忘录区域。") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"手写备忘录识别接口连接失败：{exc}") from exc
    if res.status_code >= 400:
        raise HTTPException(status_code=502, detail=res.text)

    memo_json = res.json()
    memo_message = memo_json.get("choices", [{}])[0].get("message", {})
    text: str | None = memo_message.get("content")
    if not text:
        parts = memo_message.get("parts") or []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
    if not text:
        text = memo_message.get("reasoning_content") or ""
    if not text:
        return MemoResponse(todos=[], note="AI 未返回有效内容，请重试。")

    parsed = parse_json_block(text) or {}
    raw_todos = parsed.get("todos") if isinstance(parsed, dict) else []
    todos = [str(item).strip() for item in raw_todos if str(item).strip()] if isinstance(raw_todos, list) else []
    return MemoResponse(todos=todos[:20], note=str(parsed.get("note") or ""))


def save_tutor_result(db: Session, req: TutorRequest, data: dict[str, Any], estimate: float, event: LearningEvent | None = None) -> TutorResponse:
    subject = normalize_subject(
        data.get("subject"),
        data.get("question_text"),
        req.questionAudioText,
        f"{data.get('answer_markdown') or ''}\n{data.get('knowledge_point') or ''}\n{data.get('mistake_reason') or ''}",
    )
    knowledge_point = str(data.get("knowledge_point") or "未归类知识点")
    question_text = str(data.get("question_text") or "").strip() or "题干待家长补录"
    answer_markdown = str(data.get("answer_markdown") or "")
    correct_answer = str(data.get("correct_answer_markdown") or "").strip() or answer_markdown or "正确解法待补充"
    chapter = str(data.get("chapter") or "").strip() or infer_chapter(subject, knowledge_point, question_text)
    prerequisites = normalize_text_list(data.get("prerequisites"))
    if event:
        if req.interactionMode == "followup":
            event = EVENT_STORE.append_follow_up(event.id, req.questionAudioText, answer_markdown)
            correct_answer = event.final_answer_markdown
        else:
            event = EVENT_STORE.complete(event.id, event_completion_data(req, data, subject, chapter))
        sync_learning_event_index(db, event)
        if req.interactionMode != "followup":
            ingest_completed_tutor_event(db, event, subject, chapter, knowledge_point, data)
    if req.interactionMode == "followup" or not req.persistMistake:
        call = AiCall(
            id=str(uuid.uuid4()),
            model=req.config.model,
            trigger=f"{req.trigger}_followup",
            estimated_cost_usd=estimate,
            input_images=0,
            output_tokens=520,
            success=True,
        )
        db.add(call)
        db.commit()
        pseudo = MistakeDto(
            id="",
            createdAt=utcnow().isoformat(),
            subject=subject,
            grade=req.profile.grade,
            knowledgePoint=knowledge_point,
            mistakeReason=str(data.get("mistake_reason") or "上下文追问"),
            mastery=max(0, min(100, int(data.get("mastery") or 0))),
            questionText=question_text,
            studentQuestion=req.questionAudioText,
            answerMarkdown=answer_markdown,
            correctAnswerMarkdown=correct_answer,
            chapter=chapter,
            prerequisites=prerequisites,
            wikiPageId="",
            imageDataUrl="",
        )
        return TutorResponse(
            answerMarkdown=answer_markdown,
            finalAnswerMarkdown=correct_answer,
            mistake=pseudo,
            estimatedCostUsd=estimate,
            event=learning_event_to_response(event).model_dump() if event else None,
        )
    entry = Mistake(
        id=str(uuid.uuid4()),
        created_at=utcnow(),
        subject=subject,
        grade=req.profile.grade,
        knowledge_point=knowledge_point,
        mistake_reason=str(data.get("mistake_reason") or "待家长复核"),
        mastery=max(0, min(100, int(data.get("mastery") or 0))),
        question_text=question_text,
        student_question=req.questionAudioText,
        answer_markdown=answer_markdown,
        correct_answer_markdown=correct_answer,
        chapter=chapter,
        prerequisites_json=dump_prerequisites(prerequisites),
        image_data_url=req.imageDataUrl or "",
    )
    entry.wiki_page_id = wiki_page_id_from_rel(mistake_page_rel(entry))
    call = AiCall(
        id=str(uuid.uuid4()),
        model=req.config.model,
        trigger=req.trigger,
        estimated_cost_usd=estimate,
        input_images=1 if req.imageDataUrl and req.config.allowImageUpload else 0,
        output_tokens=520,
        success=True,
    )
    db.add(entry)
    db.add(call)
    db.commit()
    db.refresh(entry)
    return TutorResponse(
        answerMarkdown=entry.answer_markdown,
        finalAnswerMarkdown=entry.correct_answer_markdown,
        mistake=mistake_to_dto(entry),
        estimatedCostUsd=estimate,
        event=learning_event_to_response(event).model_dump() if event else None,
    )


def sse_event(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def wiki_page_type(rel_path: str) -> str:
    if rel_path == "index.md":
        return "index"
    if rel_path.startswith("subjects/") and rel_path.endswith("/index.md"):
        return "subject"
    if rel_path.startswith("subjects/") and "/chapters/" in rel_path:
        return "chapter"
    if rel_path.startswith("knowledge/"):
        return "knowledge"
    if rel_path.startswith("mistakes/"):
        return "mistake"
    if rel_path.startswith("runs/lint_"):
        return "lint"
    if rel_path.startswith("runs/query_"):
        return "query"
    if rel_path.startswith("runs/flashcards_"):
        return "flashcards"
    if rel_path.startswith("runs/report_"):
        return "report"
    if rel_path.startswith("papers/"):
        return "query"
    if rel_path.startswith("flashcards/") or rel_path.startswith("archive/flashcards/"):
        return "flashcards"
    if rel_path.startswith("reports/"):
        return "report"
    if rel_path.startswith("events/"):
        return "event"
    return "page"


def wiki_metadata_value(markdown: str, label: str) -> str:
    match = re.search(rf"(?m)^\s*-\s*{re.escape(label)}[：:]\s*(.+?)\s*$", markdown)
    return match.group(1).strip() if match else ""


def _build_wiki_pages_unlocked() -> list[WikiPageSummary]:
    if not WIKI_DIR.exists():
        WIKI_DIR.mkdir(parents=True, exist_ok=True)
        write_wiki_file(WIKI_DIR / "index.md", "# FocusLens Wiki\n\n暂无错题记录。")
    pages: list[WikiPageSummary] = []
    for path in sorted(WIKI_DIR.rglob("*.md")):
        rel = wiki_rel_path(path)
        markdown = path.read_text(encoding="utf-8")
        page_type = wiki_page_type(rel)
        subject = ""
        chapter = ""
        knowledge = ""
        if rel.startswith("subjects/"):
            parts = rel.split("/")
            subject = parts[1] if len(parts) > 1 else ""
            if "/chapters/" in rel:
                chapter = path.stem
        if rel.startswith("knowledge/"):
            name = path.stem
            pieces = name.split("__", 1)
            subject = pieces[0] if pieces else ""
            knowledge = pieces[1] if len(pieces) > 1 else title_from_wiki_path(path, markdown)
            chapter = wiki_metadata_value(markdown, "章节")
        if page_type == "mistake":
            subject = wiki_metadata_value(markdown, "学科")
            chapter = wiki_metadata_value(markdown, "章节")
            knowledge = wiki_metadata_value(markdown, "知识点")
        title = title_from_wiki_path(path, markdown)
        if page_type == "mistake":
            date_label = path.stem.split("_", 1)[0]
            title = f"错题 · {knowledge or date_label or '待归类'}"
        pages.append(
            WikiPageSummary(
                id=wiki_page_id_from_rel(rel),
                title=title,
                type=page_type,
                subject=subject,
                chapter=chapter,
                knowledgePoint=knowledge,
                status=read_knowledge_status(markdown) if page_type == "knowledge" else "",
                path=str(path.resolve()),
                updatedAt=datetime.fromtimestamp(path.stat().st_mtime).isoformat(),
            )
        )
    return pages


def build_wiki_pages() -> list[WikiPageSummary]:
    with WIKI_LOCK:
        return _build_wiki_pages_unlocked()


def find_wiki_page(page_id: str) -> WikiPage:
    with WIKI_LOCK:
        for summary in _build_wiki_pages_unlocked():
            if summary.id == page_id:
                path = Path(summary.path)
                return WikiPage(**summary.model_dump(), markdown=path.read_text(encoding="utf-8"))
    raise HTTPException(status_code=404, detail="Wiki page not found")


def weakness_score(count: int, avg_mastery: float, last_seen: datetime | None) -> float:
    recency = 0
    if last_seen:
        days = max(0, (utcnow() - last_seen).days)
        recency = max(0, 20 - days)
    return round(min(100, count * 18 + (100 - avg_mastery) * 0.65 + recency), 1)


def add_or_update_node(nodes: dict[str, WikiGraphNode], node: WikiGraphNode) -> None:
    existing = nodes.get(node.id)
    if not existing:
        nodes[node.id] = node
        return
    existing.mistakeCount += node.mistakeCount
    existing.hot = existing.hot or node.hot
    existing.weaknessScore = max(existing.weaknessScore, node.weaknessScore)
    if node.lastSeenAt and (not existing.lastSeenAt or node.lastSeenAt > existing.lastSeenAt):
        existing.lastSeenAt = node.lastSeenAt


def add_edge(edges: dict[tuple[str, str, str], WikiGraphEdge], source: str, target: str, edge_type: str, confidence: str = "extracted") -> None:
    key = (source, target, edge_type)
    if key in edges:
        edges[key].weight += 1
    else:
        edges[key] = WikiGraphEdge(source=source, target=target, type=edge_type, weight=1, confidence=confidence)


def build_wiki_graph(db: Session) -> WikiGraphResponse:
    rows = db.scalars(select(Mistake)).all()
    nodes: dict[str, WikiGraphNode] = {}
    edges: dict[tuple[str, str, str], WikiGraphEdge] = {}
    by_subject: dict[str, list[Mistake]] = {}
    by_chapter: dict[tuple[str, str], list[Mistake]] = {}
    by_knowledge: dict[tuple[str, str], list[Mistake]] = {}
    reason_counts: dict[tuple[str, str], list[Mistake]] = {}
    prerequisite_counts: dict[tuple[str, str], list[Mistake]] = {}

    for row in rows:
        subject = row.subject or "未分类"
        chapter = row.chapter or infer_chapter(subject, row.knowledge_point, row.question_text)
        knowledge = row.knowledge_point or "未归类知识点"
        by_subject.setdefault(subject, []).append(row)
        by_chapter.setdefault((subject, chapter), []).append(row)
        by_knowledge.setdefault((subject, knowledge), []).append(row)
        if row.mistake_reason:
            reason_counts.setdefault((subject, row.mistake_reason), []).append(row)
        for pre in row_prerequisites(row):
            prerequisite_counts.setdefault((subject, pre), []).append(row)

        subject_id = f"subject:{subject}"
        chapter_id = f"chapter:{subject}:{chapter}"
        knowledge_id = f"knowledge:{subject}:{knowledge}"
        mistake_id = f"mistake:{row.id}"
        reason_id = f"reason:{subject}:{row.mistake_reason or '待分析'}"

        add_edge(edges, subject_id, chapter_id, "contains")
        add_edge(edges, chapter_id, knowledge_id, "contains")
        add_edge(edges, knowledge_id, mistake_id, "related_to")
        add_edge(edges, mistake_id, reason_id, "caused_by", "inferred" if not row.mistake_reason else "extracted")
        for pre in row_prerequisites(row):
            pre_id = f"prerequisite:{subject}:{pre}"
            add_edge(edges, pre_id, knowledge_id, "prerequisite_of", "inferred")
            add_edge(edges, pre_id, reason_id, "repeated_with", "inferred")

    for subject, items in by_subject.items():
        avg = sum(item.mastery for item in items) / max(len(items), 1)
        last = max((item.created_at for item in items), default=None)
        add_or_update_node(nodes, WikiGraphNode(id=f"subject:{subject}", label=subject, type="subject", subject=subject, mistakeCount=len(items), avgMastery=round(avg, 1), weaknessScore=weakness_score(len(items), avg, last), hot=len(items) >= 3, lastSeenAt=last.isoformat() if last else "", pageId=wiki_page_id_from_rel(subject_page_rel(subject))))
    for (subject, chapter), items in by_chapter.items():
        avg = sum(item.mastery for item in items) / max(len(items), 1)
        last = max((item.created_at for item in items), default=None)
        add_or_update_node(nodes, WikiGraphNode(id=f"chapter:{subject}:{chapter}", label=chapter, type="chapter", subject=subject, chapter=chapter, mistakeCount=len(items), avgMastery=round(avg, 1), weaknessScore=weakness_score(len(items), avg, last), hot=len(items) >= 3, lastSeenAt=last.isoformat() if last else "", pageId=wiki_page_id_from_rel(chapter_page_rel(subject, chapter))))
    for (subject, knowledge), items in by_knowledge.items():
        avg = sum(item.mastery for item in items) / max(len(items), 1)
        last = max((item.created_at for item in items), default=None)
        chapter = items[0].chapter if items else ""
        add_or_update_node(nodes, WikiGraphNode(id=f"knowledge:{subject}:{knowledge}", label=knowledge, type="knowledge", subject=subject, chapter=chapter, mistakeCount=len(items), avgMastery=round(avg, 1), weaknessScore=weakness_score(len(items), avg, last), hot=len(items) >= 2 or avg < 60, lastSeenAt=last.isoformat() if last else "", pageId=wiki_page_id_from_rel(knowledge_page_rel(subject, knowledge))))
    for row in rows:
        created_label = mistake_created_at(row).strftime("%m-%d")
        mistake_label = f"错题 · {row.knowledge_point or created_label or '待归类'}"
        add_or_update_node(nodes, WikiGraphNode(id=f"mistake:{row.id}", label=mistake_label, type="mistake", subject=row.subject, chapter=row.chapter, mistakeCount=1, avgMastery=row.mastery, weaknessScore=100 - row.mastery, hot=row.mastery < 50, lastSeenAt=mistake_created_at(row).isoformat(), pageId=row.wiki_page_id or wiki_page_id_from_rel(mistake_page_rel(row))))
    for (subject, reason), items in reason_counts.items():
        avg = sum(item.mastery for item in items) / max(len(items), 1)
        last = max((item.created_at for item in items), default=None)
        add_or_update_node(nodes, WikiGraphNode(id=f"reason:{subject}:{reason}", label=reason[:34], type="reason", subject=subject, mistakeCount=len(items), avgMastery=round(avg, 1), weaknessScore=weakness_score(len(items), avg, last), hot=len(items) >= 2, lastSeenAt=last.isoformat() if last else ""))
    for (subject, pre), items in prerequisite_counts.items():
        avg = sum(item.mastery for item in items) / max(len(items), 1)
        last = max((item.created_at for item in items), default=None)
        add_or_update_node(nodes, WikiGraphNode(id=f"prerequisite:{subject}:{pre}", label=pre, type="prerequisite", subject=subject, mistakeCount=len(items), avgMastery=round(avg, 1), weaknessScore=weakness_score(len(items), avg, last), hot=len(items) >= 2, lastSeenAt=last.isoformat() if last else ""))

    node_list = list(nodes.values())
    top_weak = sorted([node for node in node_list if node.type in {"knowledge", "chapter", "subject"}], key=lambda node: node.weaknessScore, reverse=True)[:64]
    gaps = sorted([node for node in node_list if node.type == "prerequisite"], key=lambda node: node.weaknessScore, reverse=True)[:64]
    reasons = sorted([node for node in node_list if node.type == "reason"], key=lambda node: node.mistakeCount, reverse=True)[:64]
    coverage = [
        {
            "subject": subject,
            "mistakeCount": len(items),
            "avgMastery": round(sum(item.mastery for item in items) / max(len(items), 1), 1),
            "chapters": len({item.chapter for item in items}),
        }
        for subject, items in sorted(by_subject.items(), key=lambda pair: len(pair[1]), reverse=True)
    ]
    return WikiGraphResponse(nodes=node_list, edges=list(edges.values()), summary=WikiGraphSummary(topWeakNodes=top_weak, prerequisiteGaps=gaps, repeatedReasons=reasons, subjectCoverage=coverage))


def wiki_context(db: Session, subject: str = "", knowledge_point: str = "", limit: int = 25) -> str:
    event_lines: list[str] = []
    excluded = excluded_review_knowledge() if not knowledge_point else set()
    for event in EVENT_STORE.list(limit=200):
        if event.write_status != "complete":
            continue
        if subject and normalize_subject(event.subject) != normalize_subject(subject):
            continue
        suggestions = "、".join(event.knowledge_suggestions)
        if excluded and any(item in excluded for item in event.knowledge_suggestions):
            continue
        if knowledge_point and knowledge_point not in suggestions and knowledge_point not in event.question_text:
            continue
        event_lines.append(
            f"- 事件 {event.id} | {event.created_at[:10]} | {event.event_type} | "
            f"{event.subject}/{event.chapter}/{suggestions or '待整理'} | "
            f"问题：{event.question_text or event.original_question} | 错因：{event.mistake_reason or '无'}"
        )
        if len(event_lines) >= limit:
            break
    rows = db.scalars(select(Mistake).order_by(Mistake.created_at.desc()).limit(200)).all()
    filtered = []
    for row in rows:
        if subject and normalize_subject(row.subject) != normalize_subject(subject):
            continue
        if excluded and row.knowledge_point in excluded:
            continue
        if knowledge_point and knowledge_point not in row.knowledge_point:
            continue
        filtered.append(row)
        if len(filtered) >= limit:
            break
    lines = ["# 学习事件证据", *event_lines, "", "# 旧版错题证据"]
    for row in filtered:
        lines.append(
            f"- {mistake_created_at(row).date()} | {row.subject}/{row.chapter}/{row.knowledge_point} | 掌握度 {row.mastery}% | 错因：{row.mistake_reason} | 题干：{row.question_text[:180]}"
        )
    return "\n".join(lines) if event_lines or filtered else "暂无匹配学习事件或错题。"


def wiki_action_default_prompt(action: str) -> str:
    prompts = {
        "lint": """你是 FocusLens 的本地学习 Wiki 整理助手。请读取错题证据和图谱摘要，做知识库维护：1. 合并重复或近义知识点；2. 补全缺失章节；3. 建立知识点、错题、错因、前置知识之间的双链；4. 标出不确定归类，等待家长确认；5. 输出可执行的 Markdown 整理建议。不要只写泛泛的学习建议。""",
        "query": """你是 FocusLens 的薄弱点出题助手。请读取 Wiki 错题证据，为指定薄弱知识点生成练习题。每道题必须包含：题目、考查点、答案、分步解析、与原错题的关系。数学公式使用 LaTeX。不要生成通用空题。""",
        "flashcards": """你是 FocusLens 的闪卡复习助手。请读取 Wiki 错题证据，为薄弱知识点生成正反面闪卡。正面必须是一个可回忆的问题或小题，背面必须是准确答案、关键步骤、常见错因和一个微练习。不要把掌握度、统计数字当作背面内容。""",
        "report": """你是 FocusLens 的家长报告助手。请读取 Wiki 图谱和错题证据，生成阶段报告：学习概况、薄弱知识图谱摘要、重复错因、前置知识缺口、建议复习顺序、近期错题证据。语言清晰，不夸张。""",
    }
    return prompts.get(action, prompts["lint"])


def local_wiki_action_markdown(req: WikiActionRequest, context: str, graph: WikiGraphResponse) -> tuple[str, list[FlashcardItem]]:
    subject = req.subject or "全部学科"
    top_nodes = graph.summary.topWeakNodes[: max(1, req.count)]
    knowledge = req.knowledgePoint or (top_nodes[0].label if top_nodes else "薄弱知识点")
    top = "\n".join(f"- {node.label}: {node.mistakeCount} 次，平均掌握度 {node.avgMastery}%" for node in graph.summary.topWeakNodes[:8]) or "- 暂无薄弱点"
    evidence = context or "暂无可用错题证据。"
    if req.action == "flashcards":
        cards: list[FlashcardItem] = []
        for node in top_nodes[: req.count]:
            front = f"请回忆：{node.label} 的核心方法是什么？请说出适用条件，并写一个最小例子。"
            back = (
                f"**知识点**：{node.label}\n\n"
                "**回答要点**：先说定义或公式，再说明什么时候使用，最后用一道同型小题验证。\n\n"
                "**常见错因**：没有把题目条件和对应方法建立联系，或跳过关键步骤。\n\n"
                f"**微练习**：围绕 `{node.label}` 自拟一道一步题，并写出理由。"
            )
            cards.append(FlashcardItem(frontMarkdown=front, backMarkdown=back, knowledgePoint=node.label, sourceMistakeIds=[], masteryTag="review"))
        if not cards:
            cards.append(FlashcardItem(frontMarkdown=f"{knowledge} 的关键方法是什么？", backMarkdown="先复述概念，再写适用条件，最后做一道同型题。", knowledgePoint=knowledge, sourceMistakeIds=[], masteryTag="review"))
        markdown = "# 闪卡复习\n\n" + "\n\n".join(f"## 卡片 {index + 1}\n\n**正面**\n\n{card.frontMarkdown}\n\n**背面**\n\n{card.backMarkdown}" for index, card in enumerate(cards))
        return markdown, cards
    if req.action == "query":
        exercises = []
        for index in range(req.count):
            exercises.append(
                f"### ?? {index + 1}\n\n"
                f"围绕 **{knowledge}** 设计一道{req.difficulty}题，要求学生写出每一步理由。\n\n"
                "**答案解析**：根据 Wiki 证据，先确认已知条件，再选择对应方法，最后验算。\n\n"
                f"**关联证据**：\n\n{evidence[:600]}"
            )
        return f"# 一键出题\n\n- 学科：{subject}\n- 知识点：{knowledge}\n- 难度：{req.difficulty}\n\n" + "\n\n".join(exercises), []
    if req.action == "report":
        return f"# 阶段学习报告\n\n## 薄弱摘要\n\n{top}\n\n## 近期错题证据\n\n{evidence}\n\n## 建议复习顺序\n\n1. 先处理重复错因。\n2. 再补前置知识缺口。\n3. 用同型题确认迁移。", []
    return f"# Wiki 整理建议\n\n## 目标\n\n合并重复知识点、补全章节、建立双链，并标出需要家长确认的无法归类内容。\n\n## 范围\n\n- 学科：{subject}\n- 知识点：{knowledge}\n- 时间：{req.dateRange}\n\n## 薄弱排行\n\n{top}\n\n## 错题证据\n\n{evidence}\n\n## 建议动作\n\n- 合并命名接近但含义重复的知识点。\n- 将“未归类章节”逐条分配到具体章节，无法判断的保持待确认。\n- 为每个知识点补充相关错题、错因和前置知识链接。", []


async def run_wiki_ai_action(req: WikiActionRequest, action: str) -> WikiActionResponse:
    with SessionLocal() as db:
        rebuild_wiki_files(db)
        graph = build_wiki_graph(db)
        context = wiki_context(db, req.subject, req.knowledgePoint)
        estimate = round(0.002 + req.count * 0.0004, 5)
        if estimate > req.config.singleCallBudgetUsd:
            raise HTTPException(status_code=402, detail="Wiki AI 单次预算不足。")
        if today_cost(db) + estimate > req.config.dailyBudgetUsd:
            raise HTTPException(status_code=402, detail="今日 AI 预算不足，已停止 Wiki 操作。")

    req.action = action
    api_key = req.config.apiKey.strip() if req.config.apiKey else AI_API_KEY
    markdown = ""
    flashcards: list[FlashcardItem] = []
    graph_summary = json.dumps(graph.model_dump(), ensure_ascii=False)[:2800]
    prompt_template = (req.promptTemplate or wiki_action_default_prompt(action)).strip()
    if api_key:
        prompt = (
            f"/no_think\n{prompt_template}\n\n"
            "请只返回 Markdown。若生成闪卡，请使用如下格式：\n"
            "## ?? 1\n**??** ...\n**??** ...\n\n"
            f"学科：{req.subject or '全部'}\n"
            f"知识点：{req.knowledgePoint or '自动选择'}\n"
            f"难度：{req.difficulty}\n"
            f"题量/卡片数：{req.count}\n\n"
            f"图谱摘要 JSON：\n{graph_summary}\n\n"
            f"错题与 Wiki 证据：\n{context[:7000]}"
        )
        payload = {
            "model": req.config.model,
            "messages": [
                {"role": "system", "content": "你是 FocusLens 的本地学习 Wiki 维护助手，必须基于证据工作。"},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.25,
            "max_tokens": 1400,
            "stream": False,
        }
        res = None
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=90.0, write=20.0, pool=5.0), verify=not req.config.allowInsecureAiTls) as client:
                res = await client.post(
                    resolve_ai_url(req.config.aiBaseUrl),
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json=payload,
                )
        except httpx.TimeoutException:
            markdown, flashcards = local_wiki_action_markdown(req, context, graph)
            markdown = (
                "> 第三方模型本次响应超过 90 秒，已自动保留一份基于本地 Wiki 证据生成的整理建议。"
                "可缩小学科或知识点范围后再次运行 AI 整理。\n\n"
                + markdown
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Wiki AI 第三方接口连接失败：{exc}") from exc
        if res is not None and res.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail=f"Wiki AI 上游返回 HTTP {res.status_code}：{upstream_error_message(res.text)}",
            )
        if res is not None:
            try:
                response_payload = res.json()
            except json.JSONDecodeError as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"Wiki AI 上游返回的不是有效 JSON：{res.text[:500]}",
                ) from exc
            markdown = extract_openai_message_text(response_payload)
            if not markdown:
                shape = list(response_payload.keys()) if isinstance(response_payload, dict) else type(response_payload).__name__
                raise HTTPException(
                    status_code=502,
                    detail=f"Wiki AI 上游请求成功，但响应中没有可用文字。响应结构：{shape}",
                )
    if not markdown:
        markdown, flashcards = local_wiki_action_markdown(req, context, graph)
    elif action == "flashcards":
        blocks = re.split(r"\n##\s*??\s*\d+", markdown)
        for block in blocks:
            front_match = re.search(r"\*\*??\*\*\s*([\s\S]*?)(?=\*\*??\*\*|$)", block)
            back_match = re.search(r"\*\*??\*\*\s*([\s\S]*)", block)
            if front_match and back_match:
                flashcards.append(FlashcardItem(frontMarkdown=front_match.group(1).strip(), backMarkdown=back_match.group(1).strip(), knowledgePoint=req.knowledgePoint or "Wiki ??", sourceMistakeIds=[], masteryTag="review"))
        if not flashcards:
            _, flashcards = local_wiki_action_markdown(req, context, graph)

    timestamp = utcnow().strftime("%Y%m%d_%H%M%S")
    if action == "query":
        rel = f"papers/paper_{timestamp}.md"
    elif action == "flashcards":
        rel = f"flashcards/flashcards_{timestamp}.md"
    elif action == "report":
        report_kind = req.dateRange if req.dateRange in {"weekly", "monthly", "semester"} else "custom"
        rel = f"reports/{report_kind}/report_{timestamp}.md"
    else:
        rel = f"runs/lint_{timestamp}.md"
    write_wiki_file(WIKI_DIR / rel, markdown)
    if action == "lint":
        changes = {
            "id": f"changes_{timestamp}",
            "createdAt": now_iso(),
            "status": "pending_review",
            "scope": {"subject": req.subject, "knowledgePoint": req.knowledgePoint, "dateRange": req.dateRange},
            "lowRiskApplied": ["更新统计建议", "补充来源事件建议", "检查双向链接建议"],
            "highRiskProposals": ["合并、拆分、重命名、章节调整和核心结论修改必须由用户确认"],
            "lintPage": rel,
        }
        write_wiki_file(WIKI_DIR / "changes" / f"{timestamp}.json", json.dumps(changes, ensure_ascii=False, indent=2))
    with SessionLocal() as db:
        db.add(AiCall(id=str(uuid.uuid4()), model=req.config.model, trigger=f"wiki_{action}", estimated_cost_usd=estimate, input_images=0, output_tokens=max(200, len(markdown) // 2), success=True))
        db.commit()
    return WikiActionResponse(markdown=markdown, pageId=wiki_page_id_from_rel(rel), filePath=str((WIKI_DIR / rel).resolve()), estimatedCostUsd=estimate, flashcards=flashcards)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/ai/test", response_model=AiConnectionTestResponse)
async def test_ai_connection(req: AiConnectionTestRequest):
    return await test_openai_compatible(req.config)


@app.post("/api/speech/transcribe", response_model=SpeechTranscribeResponse)
async def transcribe_speech(config: str = Form(...), audio: UploadFile = File(...)):
    try:
        parsed_config = AiConfig.model_validate_json(config)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid speech config.") from exc
    api_key = (parsed_config.asrApiKey or parsed_config.apiKey).strip() or AI_API_KEY
    if not api_key:
        raise HTTPException(status_code=400, detail="ASR API Key is empty.")
    if not parsed_config.asrBaseUrl.strip():
        raise HTTPException(
            status_code=400,
            detail="ASR_NOT_CONFIGURED: 请配置支持 /audio/transcriptions 的专用 ASR 地址；文本 AI 地址不会自动作为语音识别地址。",
        )
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio file is empty.")
    url = resolve_openai_endpoint(parsed_config.asrBaseUrl, "audio/transcriptions")
    files = {
        "file": (audio.filename or "question.webm", audio_bytes, audio.content_type or "audio/webm"),
    }
    data = {"model": parsed_config.asrModel or "whisper-1"}
    try:
        async with httpx.AsyncClient(timeout=35, verify=not parsed_config.allowInsecureAiTls) as client:
            res = await client.post(url, headers={"Authorization": f"Bearer {api_key}"}, data=data, files=files)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"ASR service failed: {exc}") from exc
    if res.status_code >= 400:
        raise HTTPException(status_code=502, detail=upstream_error_message(res.text))
    payload = res.json()
    return SpeechTranscribeResponse(text=str(payload.get("text") or "").strip())


@app.post("/api/speech/synthesize")
async def synthesize_speech(req: SpeechSynthesizeRequest):
    api_key = (req.config.ttsApiKey or req.config.apiKey).strip() or AI_API_KEY
    if not api_key:
        raise HTTPException(status_code=400, detail="TTS API Key is empty.")
    text_value = re.sub(r"[\x00-\x1f]+", " ", req.text).strip()
    if not text_value:
        raise HTTPException(status_code=400, detail="TTS text is empty.")
    url = resolve_openai_endpoint(req.config.ttsBaseUrl or req.config.aiBaseUrl, "audio/speech")
    payload = {
        "model": req.config.ttsModel or "tts-1",
        "voice": req.config.ttsVoice or "alloy",
        "input": text_value[:1800],
        "response_format": "mp3",
    }
    if req.config.ttsSpeed > 0:
        payload["speed"] = req.config.ttsSpeed
    if req.config.ttsInstruct.strip():
        payload["instruct"] = req.config.ttsInstruct.strip()
    if req.config.ttsLanguage.strip():
        payload["language"] = req.config.ttsLanguage.strip()
    try:
        async with httpx.AsyncClient(timeout=45, verify=not req.config.allowInsecureAiTls) as client:
            res = await client.post(url, headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, json=payload)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"TTS service failed: {exc}") from exc
    if res.status_code >= 400:
        raise HTTPException(status_code=502, detail=upstream_error_message(res.text))
    return Response(content=res.content, media_type=res.headers.get("content-type", "audio/mpeg"))


@app.post("/api/speech/synthesize/edge")
async def synthesize_speech_edge(req: SpeechSynthesizeRequest):
    if edge_tts is None:
        raise HTTPException(status_code=503, detail="Edge TTS is not installed. Run pip install -r requirements.txt.")
    text_value = re.sub(r"[\x00-\x1f]+", " ", req.text).strip()
    if not text_value:
        raise HTTPException(status_code=400, detail="TTS text is empty.")
    audio = io.BytesIO()
    try:
        communicate = edge_tts.Communicate(
            text_value[:1800],
            req.config.edgeTtsVoice or "zh-CN-YunxiNeural",
            connect_timeout=8,
            receive_timeout=20,
        )
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio.write(chunk["data"])
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Edge TTS service failed: {exc}") from exc
    if audio.tell() == 0:
        raise HTTPException(status_code=502, detail="Edge TTS returned no audio.")
    return Response(content=audio.getvalue(), media_type="audio/mpeg")


@app.post("/api/tutor/ask", response_model=TutorResponse)
async def ask_tutor(req: TutorRequest):
    event = create_tutor_event(req)
    ai_req = req.model_copy(update={"questionAudioText": tutor_prompt_question(req, event)})
    with SessionLocal() as db:
        sync_learning_event_index(db, event)
        db.commit()
        estimate = estimate_cost(req)
        if estimate > req.config.singleCallBudgetUsd:
            raise HTTPException(
                status_code=402,
                detail=f"Single-call estimate ${estimate:.3f} exceeds budget ${req.config.singleCallBudgetUsd:.3f}",
            )
        if today_cost(db) + estimate > req.config.dailyBudgetUsd:
            raise HTTPException(status_code=402, detail="Daily AI budget exhausted; downgraded to local reminder.")

        data = await call_openai_compatible(ai_req)
        return save_tutor_result(db, req, data, estimate, event)


@app.post("/api/tutor/ask/stream")
async def ask_tutor_stream(req: TutorRequest):
    event = create_tutor_event(req)
    ai_question = tutor_prompt_question(req, event)
    with SessionLocal() as db:
        sync_learning_event_index(db, event)
        db.commit()
        estimate = estimate_cost(req)
        if estimate > req.config.singleCallBudgetUsd:
            raise HTTPException(
                status_code=402,
                detail=f"Single-call estimate ${estimate:.3f} exceeds budget ${req.config.singleCallBudgetUsd:.3f}",
            )
        if today_cost(db) + estimate > req.config.dailyBudgetUsd:
            raise HTTPException(status_code=402, detail="Daily AI budget exhausted; downgraded to local reminder.")

    api_key = req.config.apiKey.strip() if req.config.apiKey else AI_API_KEY

    async def event_stream():
        is_follow_up = req.interactionMode == "followup"
        quick = (
            "我听到你的追问了。这次不用重新拍题，我们就接着刚才卡住的那一步慢慢说。"
            if is_follow_up
            else "我正在看这道题。你先找一下题目问的是什么，圈出已知条件，我马上继续讲下一步。"
        )
        yield sse_event("status", {"message": "AI 已接入，正在听追问。" if is_follow_up else "AI 已接入，正在读取题目。"})

        # 没有 API Key 时降级到本地启发式回答
        if not api_key:
            data = heuristic_answer(req)
            with SessionLocal() as db:
                response = save_tutor_result(db, req, data, estimate, event)
            yield sse_event("final", response.model_dump())
            return

        # 构建 prompt（同 call_openai_compatible）
        think_prefix = "" if req.config.enableThinking else "/no_think "
        system_prompt = (
            think_prefix
            + "你是一位温和的儿童 AI 老师。请用中文回答，并使用 Markdown + LaTeX 表达数学公式。"
            + {
                "voice": "这是简单语音知识问答。请直接、简短回答孩子的问题，不要假设存在题目图片。",
                "followup": "这是同一题目的追问。只解释孩子本次卡住的小点，不要从头重复完整解题。",
            }.get(req.interactionMode, "这是拍题求助。先提供可执行的启发式解题思路；完整解法与结论单独写入 correct_answer_markdown。")
            +
            "你需要从图片和语音问题中自动判断学科。含英文题干、英文阅读、单词、语法、对话或选择填空题时，subject 必须是【英语】，不要归为【语文】。"
            "如果孩子语音里明确说了第几题，例如【第33题】，必须优先定位这个题号；若题号和手指位置冲突，以语音题号为准。"
            "请尽量从图片中提取题干文字，写入 question_text；看不清时写空字符串。"
            "除非配置允许直接给最终答案，否则先启发孩子说出思路，再给下一小步。"
            "mastery 必须是 0 到 100 的整数，表示孩子当前对该知识点的掌握度。"
            "如果卷面没有任何有效作答或看不清作答，mastery=0；如果只写了一点思路但未形成解法，给 10-30；"
            "如果思路基本对但计算或表达有错，给 40-70；如果基本独立完成只需小修正，给 80-95。"
            "请只返回 JSON 对象，字段包括：subject, answer_markdown, knowledge_point, "
            "mistake_reason, question_text, correct_answer_markdown, chapter, prerequisites, mastery。"
            "answer_markdown 请控制在 500 个中文字符内，使用 3 到 5 个清晰步骤；不要在 JSON 外输出推理过程或额外文字。"
            "correct_answer_markdown 不是只写最终结果；必须展示已知条件、完整推导或计算步骤、必要检查，并把最终结论放在末尾。"
            "如果这是 followup 上下文追问，只回答本次追问，correct_answer_markdown 返回空字符串；系统会保留原学习事件中的完整解法。"
            f"年级：{req.profile.grade}。讲解风格：{req.profile.style}。"
            f"是否允许直接给最终答案：{req.profile.allowDirectAnswer}。"
        )
        user_content: list[dict[str, Any]] = [{"type": "text", "text": ai_question}]
        if req.imageDataUrl and req.config.allowImageUpload:
            user_content.append({"type": "image_url", "image_url": {"url": req.imageDataUrl}})

        payload: dict[str, Any] = {
            "model": req.config.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            "temperature": 0.2,
            "max_tokens": 1800,
            "stream": True,
        }

        collected_text = ""
        first_token_sent = False
        stream_url = resolve_ai_url(req.config.aiBaseUrl)
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=10.0, read=75.0, write=15.0, pool=5.0),
                verify=not req.config.allowInsecureAiTls,
            ) as client:
                async with client.stream(
                    "POST",
                    stream_url,
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json=payload,
                ) as upstream:
                    if upstream.status_code >= 400:
                        error_body = await upstream.aread()
                        yield sse_event("error", {"message": upstream_error_message(error_body.decode())})
                        return
                    async for line in upstream.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        if raw == "[DONE]":
                            break
                        try:
                            chunk = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        token = delta.get("content") or ""
                        if token:
                            # 修复：部分 API 的 streaming JSON 中 LaTeX 反斜杠未正确转义
                            # json.loads 会把 JSON \f → 换页符(0x0C)，\b → 退格符(0x08)
                            # 这里还原为 LaTeX 应有的反斜杠形式
                            token = (token
                                     .replace("\f", "\\f")   # \frac, \forall 等
                                     .replace("\b", "\\b")   # \begin, \beta, \bar 等
                                     .replace("\v", "\\v")   # \vdots, \vec 等
                                     )
                            collected_text += token
                            if not first_token_sent:
                                first_token_sent = True
                            # 实时推送 token 给前端
                            yield sse_event("token", {"text": token})
        except httpx.TimeoutException:
            yield sse_event("error", {"message": "第三方 AI 接口超时（75s）。请检查网络或换用响应更快的模型。"})
            return
        except httpx.HTTPError as exc:
            detail = str(exc) or repr(exc.__cause__) or type(exc).__name__
            yield sse_event("error", {"message": f"第三方 AI 接口连接失败（{stream_url}）：{detail}"})
            return
        except Exception as exc:  # noqa: BLE001
            yield sse_event("error", {"message": f"AI 流式请求异常：{type(exc).__name__}: {exc}"})
            return

        if not collected_text:
            yield sse_event("error", {"message": "AI 未返回有效内容，请重试。"})
            return

        # 流结束后解析 JSON 并保存
        parsed = parse_json_block(collected_text)
        if parsed:
            data = parsed
        else:
            data = heuristic_answer(req)
            data["answer_markdown"] = collected_text
        try:
            with SessionLocal() as db:
                response = save_tutor_result(db, req, data, estimate, event)
            yield sse_event("final", response.model_dump())
        except Exception as exc:  # noqa: BLE001
            yield sse_event("error", {"message": str(exc)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/events", response_model=list[LearningEventResponse])
def learning_events(limit: int = 100):
    return [learning_event_to_response(event) for event in EVENT_STORE.list(limit=max(1, min(limit, 500)))]


@app.get("/api/events/{event_id}", response_model=LearningEventResponse)
def learning_event(event_id: str):
    try:
        return learning_event_to_response(EVENT_STORE.get(event_id))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="学习事件不存在。") from exc


@app.post("/api/events/{event_id}/follow-ups", response_model=LearningEventResponse)
def append_learning_event_follow_up(event_id: str, req: FollowUpRequest):
    try:
        event = EVENT_STORE.append_follow_up(event_id, req.question, req.answerMarkdown)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="学习事件不存在。") from exc
    with SessionLocal() as db:
        sync_learning_event_index(db, event)
        db.commit()
    return learning_event_to_response(event)


@app.post("/api/events/{event_id}/reveal", response_model=LearningEventResponse)
def reveal_learning_event_answer(event_id: str):
    try:
        event = EVENT_STORE.reveal_answer(event_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="学习事件不存在。") from exc
    with SessionLocal() as db:
        sync_learning_event_index(db, event)
        db.commit()
    return learning_event_to_response(event)


@app.post("/api/events/{event_id}/archive", response_model=LearningEventResponse)
def archive_learning_event(event_id: str):
    try:
        event = EVENT_STORE.archive(event_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="学习事件不存在。") from exc
    with SessionLocal() as db:
        sync_learning_event_index(db, event)
        db.commit()
    return learning_event_to_response(event)


@app.post("/api/events/{event_id}/promote", response_model=WikiPage)
def promote_learning_event(event_id: str, req: PromoteEventRequest):
    try:
        event = EVENT_STORE.get(event_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="学习事件不存在。") from exc
    return promote_event_to_knowledge(event, req.knowledgePoint)


@app.post("/api/events/rebuild-index")
def rebuild_event_index():
    with SessionLocal() as db:
        count = rebuild_learning_event_index(db)
    return {"ok": True, "count": count}


@app.post("/api/calendar/recognize-memo", response_model=MemoResponse)
async def recognize_calendar_memo(req: MemoRequest):
    if not req.config.allowImageUpload:
        raise HTTPException(status_code=400, detail="当前配置关闭了图片上传，无法识别手写备忘录。")
    return await recognize_memo_todos(req)


@app.get("/api/mistakes", response_model=list[MistakeDto])
def list_mistakes():
    with SessionLocal() as db:
        rows = db.scalars(select(Mistake).order_by(Mistake.created_at.desc()).limit(100)).all()
        return [mistake_to_list_dto(row) for row in rows]


@app.delete("/api/mistakes/{mistake_id}")
def delete_mistake(mistake_id: str):
    with SessionLocal() as db:
        row = db.get(Mistake, mistake_id)
        if not row:
            raise HTTPException(status_code=404, detail="Mistake not found")
        db.delete(row)
        db.commit()
        rebuild_wiki_files(db)
        return {"ok": True}


@app.put("/api/mistakes/{mistake_id}", response_model=MistakeDto)
def update_mistake(mistake_id: str, entry: MistakeDto):
    with SessionLocal() as db:
        row = db.get(Mistake, mistake_id)
        if not row:
            raise HTTPException(status_code=404, detail="Mistake not found")
        row.subject = entry.subject
        row.grade = entry.grade
        row.knowledge_point = entry.knowledgePoint
        row.mistake_reason = entry.mistakeReason
        row.mastery = entry.mastery
        row.question_text = entry.questionText
        row.student_question = entry.studentQuestion
        row.answer_markdown = entry.answerMarkdown
        row.correct_answer_markdown = entry.correctAnswerMarkdown
        row.chapter = entry.chapter
        row.prerequisites_json = dump_prerequisites(entry.prerequisites)
        row.wiki_page_id = entry.wikiPageId
        db.commit()
        db.refresh(row)
        rebuild_wiki_files(db)
        return mistake_to_dto(row)


@app.get("/api/wiki")
def knowledge_wiki():
    with SessionLocal() as db:
        return rebuild_wiki_files(db)


@app.get("/api/wiki/pages", response_model=list[WikiPageSummary])
def wiki_pages():
    with SessionLocal() as db:
        rebuild_wiki_files(db)
    return build_wiki_pages()


@app.get("/api/wiki/pages/{page_id}", response_model=WikiPage)
def wiki_page(page_id: str):
    return find_wiki_page(page_id)


@app.put("/api/wiki/pages/{page_id}/status", response_model=WikiPage)
def update_wiki_knowledge_status(page_id: str, req: KnowledgeStatusRequest):
    if req.status not in {"weak", "learning", "mastered", "ignored"}:
        raise HTTPException(status_code=400, detail="知识状态必须是 weak、learning、mastered 或 ignored。")
    page = find_wiki_page(page_id)
    if page.type != "knowledge":
        raise HTTPException(status_code=400, detail="只有知识页面可以修改掌握状态。")
    path = Path(page.path)
    write_wiki_file(path, update_knowledge_status_markdown(page.markdown, req.status))
    return find_wiki_page(page_id)


@app.post("/api/wiki/pages/{page_id}/archive", response_model=WikiPage)
def archive_wiki_page(page_id: str):
    page = find_wiki_page(page_id)
    if page.type != "flashcards":
        raise HTTPException(status_code=400, detail="当前只支持归档闪卡页面。")
    source = Path(page.path)
    target = WIKI_DIR / "archive" / "flashcards" / source.name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
    return find_wiki_page(wiki_page_id_from_rel(wiki_rel_path(target)))


@app.post("/api/wiki/pages/{page_id}/restore", response_model=WikiPage)
def restore_wiki_page(page_id: str):
    page = find_wiki_page(page_id)
    source = Path(page.path)
    if "archive/flashcards/" not in wiki_rel_path(source):
        raise HTTPException(status_code=400, detail="当前页面不在闪卡归档中。")
    target = WIKI_DIR / "flashcards" / source.name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
    return find_wiki_page(wiki_page_id_from_rel(wiki_rel_path(target)))


@app.get("/api/wiki/graph", response_model=WikiGraphResponse)
def wiki_graph():
    with SessionLocal() as db:
        rebuild_wiki_files(db)
        return build_wiki_graph(db)


@app.post("/api/wiki/rebuild", response_model=list[WikiPageSummary])
def wiki_rebuild():
    with SessionLocal() as db:
        rebuild_wiki_files(db)
    return build_wiki_pages()


@app.post("/api/wiki/reclassify", response_model=WikiPage)
def wiki_reclassify(req: WikiReclassifyRequest):
    mistake_prefix = req.pageId.split("_")[-1]
    with SessionLocal() as db:
        row = db.scalar(select(Mistake).where(Mistake.id.like(f"{mistake_prefix}%")))
        if row is None:
            raise HTTPException(status_code=404, detail="Only mistake Wiki pages can be manually reclassified.")
        if req.subject.strip():
            row.subject = normalize_subject(req.subject)
        if req.chapter.strip():
            row.chapter = req.chapter.strip()
        db.commit()
        db.refresh(row)
        rebuild_wiki_files(db)
        return find_wiki_page(row.wiki_page_id or wiki_page_id_from_rel(mistake_page_rel(row)))


@app.post("/api/wiki/lint", response_model=WikiActionResponse)
async def wiki_lint(req: WikiActionRequest):
    return await run_wiki_ai_action(req, "lint")


@app.post("/api/wiki/query", response_model=WikiActionResponse)
async def wiki_query(req: WikiActionRequest):
    return await run_wiki_ai_action(req, "query")


@app.post("/api/wiki/flashcards", response_model=WikiActionResponse)
async def wiki_flashcards(req: WikiActionRequest):
    return await run_wiki_ai_action(req, "flashcards")


@app.post("/api/wiki/report", response_model=WikiActionResponse)
async def wiki_report(req: WikiActionRequest):
    return await run_wiki_ai_action(req, "report")


@app.post("/api/wiki/curriculum/import", response_model=WikiPage)
def wiki_curriculum_import(req: CurriculumImportRequest):
    subject = normalize_subject(req.subject)
    markdown = req.markdown.strip()
    if req.jsonData:
        markdown += "\n\n```json\n" + json.dumps(req.jsonData, ensure_ascii=False, indent=2) + "\n```"
    if not markdown:
        markdown = "# 教纲\n\n暂无内容。"
    rel = f"subjects/{safe_filename(subject)}/curriculum_import.md"
    write_wiki_file(WIKI_DIR / rel, f"# {subject} 教纲导入\n\n{markdown}")
    return find_wiki_page(wiki_page_id_from_rel(rel))


@app.get("/api/costs/summary")
def cost_summary():
    now = utcnow()
    day = now - timedelta(hours=24)
    week = now - timedelta(days=7)
    with SessionLocal() as db:
        rows = db.scalars(select(AiCall).where(AiCall.success == True)).all()  # noqa: E712
        today_rows = [row for row in rows if row.created_at >= day]
        week_rows = [row for row in rows if row.created_at >= week]
        return {
            "todayCalls": len(today_rows),
            "todayEstimatedUsd": round(sum(row.estimated_cost_usd for row in today_rows), 5),
            "weekEstimatedUsd": round(sum(row.estimated_cost_usd for row in week_rows), 5),
            "activeAiCalls": len([row for row in today_rows if row.trigger == "care_offer"]),
        }
