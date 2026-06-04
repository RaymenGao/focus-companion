import json
import os
import re
import uuid
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, create_engine, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./focuslens.db")
AI_API_KEY = os.getenv("FOCUSLENS_AI_API_KEY", "")
WIKI_DIR = Path(os.getenv("FOCUSLENS_WIKI_DIR", "wiki"))

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


try:
    Base.metadata.create_all(bind=engine)
except OperationalError as exc:
    if "already exists" not in str(exc):
        raise


app = FastAPI(title="FocusLens API", version="0.1.0")
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
    paperFocusMode: str = "auto"
    paperFocusDistance: float = 0.8
    singleCallBudgetUsd: float = Field(default=0.05, ge=0)
    dailyBudgetUsd: float = Field(default=1.0, ge=0)
    allowImageUpload: bool = True


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
    imageDataUrl: str = ""


class TutorResponse(BaseModel):
    answerMarkdown: str
    mistake: MistakeDto
    estimatedCostUsd: float


def estimate_cost(req: TutorRequest, output_tokens: int = 800) -> float:
    text_tokens = max(200, len(req.questionAudioText) // 2 + len(req.profile.style) // 2)
    image_cost = 0.004 if req.imageDataUrl and req.config.allowImageUpload else 0
    token_cost = (text_tokens / 1_000_000) * 0.15 + (output_tokens / 1_000_000) * 0.6
    return round(image_cost + token_cost, 5)


def today_cost(db: Session) -> float:
    since = utcnow() - timedelta(hours=24)
    rows = db.scalars(select(AiCall).where(AiCall.created_at >= since, AiCall.success == True)).all()  # noqa: E712
    return sum(row.estimated_cost_usd for row in rows)


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
        "mastery": 0,
    }


def parse_json_block(text: str) -> dict[str, Any] | None:
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return None
    json_str = match.group(0)
    try:
        return json.loads(json_str)
    except json.JSONDecodeError:
        pass

    res: dict[str, Any] = {}
    keys = ["subject", "answer_markdown", "knowledge_point", "mistake_reason", "question_text", "mastery"]
    for key in keys:
        pattern = rf'"{key}"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"'
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
        async with httpx.AsyncClient(timeout=8) as client:
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
    prompt = (
        think_prefix
        + "你是一位温和的儿童 AI 老师。请用中文回答，并使用 Markdown + LaTeX 表达数学公式。"
        "你需要从图片和语音问题中自动判断学科。含英文题干、英文阅读、单词、语法、对话或选择填空题时，subject 必须是“英语”，不要归为“语文”。"
        "如果孩子语音里明确说了第几题，例如“第33题”，必须优先定位这个题号；若题号和手指位置冲突，以语音题号为准。"
        "请尽量从图片中提取题干文字，写入 question_text；看不清时写空字符串。"
        "除非配置允许直接给最终答案，否则先启发孩子说出思路，再给下一小步。"
        "mastery 必须是 0 到 100 的整数，表示孩子当前对该知识点的掌握度。"
        "如果卷面没有任何有效作答或看不清作答，mastery=0；如果只写了一点思路但未形成解法，给 10-30；"
        "如果思路基本对但计算或表达有错，给 40-70；如果基本独立完成只需小修正，给 80-95。"
        "请只返回 JSON 对象，字段包括：subject, answer_markdown, knowledge_point, "
        "mistake_reason, question_text, mastery。"
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
        "max_tokens": 6000,
    }

    try:
        async with httpx.AsyncClient(timeout=55) as client:
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
        async with httpx.AsyncClient(timeout=55) as client:
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


def save_tutor_result(db: Session, req: TutorRequest, data: dict[str, Any], estimate: float) -> TutorResponse:
    subject = normalize_subject(
        data.get("subject"),
        data.get("question_text"),
        req.questionAudioText,
        f"{data.get('answer_markdown') or ''}\n{data.get('knowledge_point') or ''}\n{data.get('mistake_reason') or ''}",
    )
    entry = Mistake(
        id=str(uuid.uuid4()),
        subject=subject,
        grade=req.profile.grade,
        knowledge_point=str(data.get("knowledge_point") or "未归类知识点"),
        mistake_reason=str(data.get("mistake_reason") or "待家长复核"),
        mastery=max(0, min(100, int(data.get("mastery") or 0))),
        question_text=str(data.get("question_text") or ""),
        student_question=req.questionAudioText,
        answer_markdown=str(data.get("answer_markdown") or ""),
        image_data_url=req.imageDataUrl or "",
    )
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
    rebuild_wiki_files(db)
    return TutorResponse(answerMarkdown=entry.answer_markdown, mistake=mistake_to_dto(entry), estimatedCostUsd=estimate)


def sse_event(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/ai/test", response_model=AiConnectionTestResponse)
async def test_ai_connection(req: AiConnectionTestRequest):
    return await test_openai_compatible(req.config)


@app.post("/api/tutor/ask", response_model=TutorResponse)
async def ask_tutor(req: TutorRequest):
    with SessionLocal() as db:
        estimate = estimate_cost(req)
        if estimate > req.config.singleCallBudgetUsd:
            raise HTTPException(
                status_code=402,
                detail=f"Single-call estimate ${estimate:.3f} exceeds budget ${req.config.singleCallBudgetUsd:.3f}",
            )
        if today_cost(db) + estimate > req.config.dailyBudgetUsd:
            raise HTTPException(status_code=402, detail="Daily AI budget exhausted; downgraded to local reminder.")

        data = await call_openai_compatible(req)
        return save_tutor_result(db, req, data, estimate)


@app.post("/api/tutor/ask/stream")
async def ask_tutor_stream(req: TutorRequest):
    with SessionLocal() as db:
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
        is_follow_up = "上下文追问" in req.questionAudioText or not req.imageDataUrl
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
                response = save_tutor_result(db, req, data, estimate)
            yield sse_event("final", response.model_dump())
            return

        # 构建 prompt（同 call_openai_compatible）
        think_prefix = "" if req.config.enableThinking else "/no_think "
        system_prompt = (
            think_prefix
            + "你是一位温和的儿童 AI 老师。请用中文回答，并使用 Markdown + LaTeX 表达数学公式。"
            "你需要从图片和语音问题中自动判断学科。含英文题干、英文阅读、单词、语法、对话或选择填空题时，subject 必须是【英语】，不要归为【语文】。"
            "如果孩子语音里明确说了第几题，例如【第33题】，必须优先定位这个题号；若题号和手指位置冲突，以语音题号为准。"
            "请尽量从图片中提取题干文字，写入 question_text；看不清时写空字符串。"
            "除非配置允许直接给最终答案，否则先启发孩子说出思路，再给下一小步。"
            "mastery 必须是 0 到 100 的整数，表示孩子当前对该知识点的掌握度。"
            "如果卷面没有任何有效作答或看不清作答，mastery=0；如果只写了一点思路但未形成解法，给 10-30；"
            "如果思路基本对但计算或表达有错，给 40-70；如果基本独立完成只需小修正，给 80-95。"
            "请只返回 JSON 对象，字段包括：subject, answer_markdown, knowledge_point, "
            "mistake_reason, question_text, mastery。"
            f"年级：{req.profile.grade}。讲解风格：{req.profile.style}。"
            f"是否允许直接给最终答案：{req.profile.allowDirectAnswer}。"
        )
        user_content: list[dict[str, Any]] = [{"type": "text", "text": req.questionAudioText}]
        if req.imageDataUrl and req.config.allowImageUpload:
            user_content.append({"type": "image_url", "image_url": {"url": req.imageDataUrl}})

        payload: dict[str, Any] = {
            "model": req.config.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            "temperature": 0.2,
            "max_tokens": 6000,
            "stream": True,
        }

        collected_text = ""
        first_token_sent = False
        stream_url = resolve_ai_url(req.config.aiBaseUrl)
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=10.0, read=75.0, write=15.0, pool=5.0)
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
                response = save_tutor_result(db, req, data, estimate)
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
        db.commit()
        db.refresh(row)
        rebuild_wiki_files(db)
        return mistake_to_dto(row)


@app.get("/api/wiki")
def knowledge_wiki():
    with SessionLocal() as db:
        return rebuild_wiki_files(db)


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
