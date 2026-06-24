import json
import os
import re
import uuid
import httpx
from datetime import datetime
from pathlib import Path
from typing import Any, List
from pydantic import BaseModel, Field

from wiki_models import (
    PracticeQuestion,
    FlashcardRecord,
    StageReport,
    CreatePaperRequest,
    CreateFlashcardsRequest,
    CreateReportRequest
)
from wiki_store import WikiStore
from wiki_markdown import parse_page
from wiki_terms import LEGACY_TERM_ID, term_matches

class ArtifactValidationError(Exception):
    pass


def _collect_context(
    store: WikiStore,
    knowledge_ids: list[str] | None = None,
    evidence_ids: list[str] | None = None,
    subject: str = "",
    term_id: str = "",
) -> dict[str, Any]:
    """Read the actual local Wiki evidence used to generate an artifact."""
    selected_knowledge: list[dict[str, Any]] = []
    selected_evidence: list[dict[str, Any]] = []
    resolved_evidence_ids = set(evidence_ids or [])
    requested_ids = set(knowledge_ids or [])

    knowledge_dir = store.wiki_dir / "knowledge"
    if knowledge_dir.exists():
        for path in knowledge_dir.rglob("*.md"):
            try:
                markdown = path.read_text(encoding="utf-8")
                meta, _ = parse_page(markdown)
            except (OSError, ValueError):
                continue
            if requested_ids and meta.get("id") not in requested_ids:
                continue
            if subject and meta.get("subject") != subject:
                continue
            if not term_matches(meta, term_id):
                continue
            resolved_evidence_ids.update(meta.get("evidence_ids") or [])
            selected_knowledge.append({"meta": meta, "markdown": markdown})

    evidence_candidates: list[Path] = []
    for directory_name in ("events", "evidence"):
        directory = store.wiki_dir / directory_name
        if directory.exists():
            evidence_candidates.extend(directory.rglob("*.md"))
    for path in evidence_candidates:
        try:
            markdown = path.read_text(encoding="utf-8")
            meta, _ = parse_page(markdown)
        except (OSError, ValueError):
            continue
        if meta.get("id") in resolved_evidence_ids:
            selected_evidence.append({"meta": meta, "markdown": markdown})

    return {
        "knowledge": selected_knowledge,
        "evidence": selected_evidence,
        "knowledge_ids": [item["meta"].get("id") for item in selected_knowledge if item["meta"].get("id")],
        "evidence_ids": [item["meta"].get("id") for item in selected_evidence if item["meta"].get("id")],
    }


def _require_generation_context(context: dict[str, Any], require_evidence: bool = True) -> None:
    if not context["knowledge"]:
        raise ArtifactValidationError("未找到可用于生成材料的知识页，请先在 Wiki 中确认知识点。")
    if require_evidence and not context["evidence"]:
        raise ArtifactValidationError("所选知识点没有可读取的错题证据，暂时不能生成可靠材料。")


def _context_prompt(context: dict[str, Any]) -> str:
    return json.dumps(
        {"knowledge_pages": context["knowledge"], "evidence_pages": context["evidence"]},
        ensure_ascii=False,
    )

def validate_no_thinking_process(text: str) -> None:
    if not text:
        return
    lowered = text.lower()
    for marker in ["thinking process", "analysis of request", "<thinking>", "system prompt", "user instruction"]:
        if marker in lowered:
            raise ArtifactValidationError(f"检测到模型思考过程或系统指令污染: '{marker}'")

def validate_question(q: PracticeQuestion) -> None:
    validate_no_thinking_process(q.prompt_markdown)
    validate_no_thinking_process(q.steps_markdown)
    validate_no_thinking_process(q.final_answer_markdown)
    if not q.prompt_markdown.strip():
        raise ArtifactValidationError("题目描述不能为空")
    if not q.steps_markdown.strip():
        raise ArtifactValidationError("解析步骤不能为空")
    if not q.final_answer_markdown.strip():
        raise ArtifactValidationError("最终答案不能为空")
    if not q.knowledge_ids:
        raise ArtifactValidationError("题目必须关联至少一个知识点")
    if not q.evidence_ids:
        raise ArtifactValidationError("题目必须关联至少一个错题证据")

def validate_flashcard(card: FlashcardRecord) -> None:
    validate_no_thinking_process(card.front_markdown)
    validate_no_thinking_process(card.back_markdown)
    if len(card.front_markdown.strip()) < 8:
        raise ArtifactValidationError("闪卡正面长度不足 8 字符")
    if len(card.back_markdown.strip()) < 8:
        raise ArtifactValidationError("闪卡背面长度不足 8 字符")
    if not card.knowledge_ids:
        raise ArtifactValidationError("闪卡必须关联至少一个知识点")
    back_stripped = card.back_markdown.replace(" ", "").replace("\n", "").replace("\r", "")
    generic_only = back_stripped.rstrip("。！!，,；;")
    generic_phrases = ("回顾相关错因", "回顾错因")
    if generic_only == "回顾相关错因先说概念再做一道同型题" or (
        generic_only.startswith(generic_phrases) and len(generic_only) < 30
    ):
        raise ArtifactValidationError("闪卡背面不能只写'回顾相关错因'，必须有准确答案或关键步骤")

def validate_report(report: StageReport) -> None:
    validate_no_thinking_process(report.overview)
    for s in report.evidence_summary:
        validate_no_thinking_process(s)
    for c in report.state_changes:
        validate_no_thinking_process(c)
    for r in report.repeated_reasons:
        validate_no_thinking_process(r)
    for o in report.review_order:
        validate_no_thinking_process(o)
    for a in report.next_actions:
        validate_no_thinking_process(a)
        
    if not report.overview.strip():
        raise ArtifactValidationError("报告概述不能为空")
    if not report.evidence_summary:
        raise ArtifactValidationError("报告必须含证据摘要")
    if not report.next_actions:
        raise ArtifactValidationError("报告必须含下一步行动")

def resolve_ai_url(ai_base_url: str) -> str:
    base = ai_base_url.strip().rstrip("/")
    if not base:
        return "https://api.openai.com/v1/chat/completions"
    if "/v1/chat/completions" in base:
        return base
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def extract_json_candidate(content: str) -> str:
    fenced = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", content)
    candidate = fenced.group(1) if fenced else content.strip()
    if not candidate.startswith("{"):
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start >= 0 and end > start:
            candidate = candidate[start:end + 1]
    return candidate


def escape_unclosed_quotes_in_json_strings(candidate: str) -> str:
    """Repair common LLM JSON where English examples use raw quotes inside string values."""
    repaired: list[str] = []
    in_string = False
    escaped = False
    length = len(candidate)

    for index, char in enumerate(candidate):
        if not in_string:
            repaired.append(char)
            if char == '"':
                in_string = True
            continue

        if escaped:
            repaired.append(char)
            escaped = False
            continue

        if char == "\\":
            repaired.append(char)
            escaped = True
            continue

        if char == '"':
            cursor = index + 1
            while cursor < length and candidate[cursor].isspace():
                cursor += 1
            next_char = candidate[cursor] if cursor < length else ""
            if next_char in {":", ",", "}", "]"} or not next_char:
                repaired.append(char)
                in_string = False
            else:
                repaired.append('\\"')
            continue

        repaired.append(char)

    return "".join(repaired)


def parse_ai_json_content(content: str) -> Any:
    candidate = extract_json_candidate(content)
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        repaired = escape_unclosed_quotes_in_json_strings(candidate)
        try:
            return json.loads(repaired)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"AI 返回的不是合法的 JSON 格式: {content}") from exc


async def call_ai_json(config: dict[str, Any], prompt: str, system_prompt: str) -> Any:
    api_key = str(config.get("apiKey") or "").strip()
    model = str(config.get("model") or "").strip()
    base_url = str(config.get("aiBaseUrl") or "").strip()
    
    if not api_key:
        raise ValueError("AI API Key 为空，请先在配置页填写。")
    if not model:
        raise ValueError("AI 模型名称为空，请先在配置页填写。")
        
    resolved_url = resolve_ai_url(base_url)
    
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.2,
        "stream": False
    }
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    async with httpx.AsyncClient(timeout=90.0) as client:
        res = await client.post(resolved_url, headers=headers, json=payload)
        if res.status_code >= 400:
            raise RuntimeError(f"AI 接口请求失败 ({res.status_code}): {res.text}")
        try:
            data = res.json()
            content = data["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise RuntimeError("AI 返回格式无法解析，请确认该模型支持 OpenAI-compatible chat/completions。") from exc
        
    return parse_ai_json_content(content)

def render_markdown_links(knowledge_ids: list[str], evidence_ids: list[str]) -> str:
    return render_markdown_links_with_labels(knowledge_ids, evidence_ids, {}, {})


def render_markdown_links_with_labels(
    knowledge_ids: list[str],
    evidence_ids: list[str],
    knowledge_labels: dict[str, str],
    evidence_labels: dict[str, str],
) -> str:
    parts = []
    if knowledge_ids:
        k_links = [f"[[wiki://{k_id}|{knowledge_labels.get(k_id) or k_id}]]" for k_id in knowledge_ids]
        parts.append(f"相关知识点: {', '.join(k_links)}")
    if evidence_ids:
        e_links = [f"[[evidence://{e_id}|证据：{evidence_labels.get(e_id) or e_id}]]" for e_id in evidence_ids]
        parts.append(f"关联证据: {', '.join(e_links)}")
    return " | ".join(parts)


def _first_heading(markdown: str) -> str:
    match = re.search(r"(?m)^#\s+(.+)$", markdown)
    return match.group(1).strip() if match else ""


def _evidence_label(meta: dict[str, Any], markdown: str) -> str:
    heading = _first_heading(markdown)
    if heading and heading != "错题证据":
        return heading
    for key in ("knowledge_point", "short_title", "title", "source_path"):
        value = str(meta.get(key) or "").strip()
        if value:
            return Path(value).stem if key == "source_path" else value
    return str(meta.get("id") or "").strip()


def artifact_link_labels(context: dict[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    knowledge_labels = {
        item["meta"]["id"]: item["meta"].get("short_title")
        or item["meta"].get("full_title")
        or item["meta"]["id"]
        for item in context["knowledge"]
        if item["meta"].get("id")
    }
    evidence_labels = {
        item["meta"]["id"]: _evidence_label(item["meta"], item["markdown"])
        for item in context["evidence"]
        if item["meta"].get("id")
    }
    return knowledge_labels, evidence_labels


def normalize_artifact_links(markdown: str, knowledge_labels: dict[str, str], evidence_labels: dict[str, str]) -> str:
    def replace_wiki(match: re.Match[str]) -> str:
        page_id = match.group(1)
        return f"[[wiki://{page_id}|{knowledge_labels.get(page_id) or match.group(2)}]]"

    def replace_evidence(match: re.Match[str]) -> str:
        evidence_id = match.group(1)
        return f"[[evidence://{evidence_id}|证据：{evidence_labels.get(evidence_id) or match.group(2)}]]"

    return re.sub(
        r"\[\[evidence://([^|\]]+)\|([^\]]+)\]\]",
        replace_evidence,
        re.sub(r"\[\[wiki://([^|\]]+)\|([^\]]+)\]\]", replace_wiki, markdown),
    )

async def generate_practice_paper(store: WikiStore, req: CreatePaperRequest) -> dict[str, Any]:
    paper_id = f"paper_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
    context = _collect_context(store, req.knowledge_ids, req.evidence_ids, term_id=req.term_id)
    _require_generation_context(context)
    knowledge_labels, evidence_labels = artifact_link_labels(context)
    
    system_prompt = (
        "你是一个 FocusLens 学习助手，专门负责为学生生成针对薄弱环节的定制练习试卷。\n"
        "你必须输出符合 JSON 格式的题目列表，严格遵守以下 JSON 结构：\n"
        "{\n"
        "  \"questions\": [\n"
        "    {\n"
        "      \"prompt_markdown\": \"题目描述，必须包含稳定知识点和证据链接，如：根据 [[wiki://kp_xxx|某知识点]] ...\",\n"
        "      \"knowledge_ids\": [\"kp_xxx\"],\n"
        "      \"evidence_ids\": [\"event_xxx\"],\n"
        "      \"steps_markdown\": \"详细步骤解析，必须有针对性的点拨\",\n"
        "      \"final_answer_markdown\": \"最终准确答案\"\n"
        "    }\n"
        "  ]\n"
        "}\n"
        "要求：\n"
        "1. 必须根据提供的知识点和错题证据生成真正的练习题。禁止任何占位符。\n"
        "2. 严禁包含 Thinking Process/Analysis of request 等模型思考过程的任何字眼。\n"
        "3. 题目和步骤中要带上类似 [[wiki://kp_xxx|知识点]] 的稳定链接。\n"
    )
    
    prompt = (
        f"请为以下关联知识点与错题证据生成 {req.count} 道难度为 {req.difficulty} 的练习题。\n"
        f"知识点 IDs: {context['knowledge_ids']}\n"
        f"错题证据 IDs: {context['evidence_ids']}\n"
        f"以下是必须读取的本地 Wiki 正文与错题证据：\n{_context_prompt(context)}\n"
    )
    
    raw_json = await call_ai_json(req.ai_config, prompt, system_prompt)
    if "questions" not in raw_json:
        raise ArtifactValidationError("AI 返回的 JSON 缺少 'questions' 字段")
        
    questions: List[PracticeQuestion] = []
    for q_data in raw_json["questions"]:
        # Ensure knowledge_ids and evidence_ids inherit from request if LLM forgot them
        if not q_data.get("knowledge_ids"):
            q_data["knowledge_ids"] = context["knowledge_ids"]
        if not q_data.get("evidence_ids"):
            q_data["evidence_ids"] = context["evidence_ids"]
            
        q = PracticeQuestion(**q_data)
        validate_question(q)
        q.prompt_markdown = normalize_artifact_links(q.prompt_markdown, knowledge_labels, evidence_labels)
        q.steps_markdown = normalize_artifact_links(q.steps_markdown, knowledge_labels, evidence_labels)
        q.final_answer_markdown = normalize_artifact_links(q.final_answer_markdown, knowledge_labels, evidence_labels)
        questions.append(q)
        
    # Render paper file and answers file
    paper_rel = f"papers/{paper_id}_paper.md"
    answers_rel = f"papers/{paper_id}_answers.md"
    
    paper_meta = {
        "id": paper_id,
        "type": "paper",
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "term_id": req.term_id or LEGACY_TERM_ID,
        "knowledge_ids": context["knowledge_ids"],
        "evidence_ids": context["evidence_ids"],
        "difficulty": req.difficulty
    }
    
    answers_meta = {
        "id": f"{paper_id}_answers",
        "paper_id": paper_id,
        "type": "answers",
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds")
        ,"term_id": req.term_id or LEGACY_TERM_ID
    }
    
    # Formulate question markdown
    p_body = [
        "---json",
        json.dumps(paper_meta, ensure_ascii=False, indent=2),
        "---",
        "",
        f"# FocusLens 定制练习试卷 - {paper_id}",
        "",
        "## 题目列表",
        ""
    ]
    
    a_body = [
        "---json",
        json.dumps(answers_meta, ensure_ascii=False, indent=2),
        "---",
        "",
        f"# FocusLens 定制练习试卷答案解析 - {paper_id}",
        "",
        "## 题目与详细解析",
        ""
    ]
    
    for i, q in enumerate(questions, 1):
        # Questions file
        p_body.extend([
            f"### 第 {i} 题",
            q.prompt_markdown.strip(),
            "",
            f"*{render_markdown_links_with_labels(q.knowledge_ids, q.evidence_ids, knowledge_labels, evidence_labels)}*",
            "",
            "---",
            ""
        ])
        
        # Answers file
        a_body.extend([
            f"### 第 {i} 题",
            q.prompt_markdown.strip(),
            "",
            "#### 最终答案",
            q.final_answer_markdown.strip(),
            "",
            "#### 详细解析步骤",
            q.steps_markdown.strip(),
            "",
            f"*{render_markdown_links_with_labels(q.knowledge_ids, q.evidence_ids, knowledge_labels, evidence_labels)}*",
            "",
            "---",
            ""
        ])
        
    paper_content = "\n".join(p_body)
    answers_content = "\n".join(a_body)
    
    tx = store.begin_transaction("create-practice-paper")
    try:
        tx.write_page(paper_rel, paper_content)
        tx.write_page(answers_rel, answers_content)
        tx.commit([{"tool": "create_paper", "paper_id": paper_id}])
    except Exception:
        tx.rollback()
        raise
        
    return {
        "id": paper_id,
        "paper_path": paper_rel,
        "answers_path": answers_rel,
        "questions": [q.model_dump() for q in questions]
    }

async def generate_flashcards(store: WikiStore, req: CreateFlashcardsRequest) -> dict[str, Any]:
    deck_id = f"flashcards_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
    context = _collect_context(store, req.knowledge_ids, req.evidence_ids, term_id=req.term_id)
    _require_generation_context(context)
    
    system_prompt = (
        "你是一个 FocusLens 学习助手，负责为学生生成记忆闪卡。\n"
        "你必须输出符合 JSON 格式的闪卡列表，严格遵守以下 JSON 结构：\n"
        "{\n"
        "  \"flashcards\": [\n"
        "    {\n"
        "      \"front_markdown\": \"正面问题，必须是真正的问题或概念提问（长度至少 8 字符）\",\n"
        "      \"back_markdown\": \"背面答案与记忆提示（长度至少 8 字符，必须有真正的解法、步骤或关键点，绝对不能只写'回顾相关错因'）\",\n"
        "      \"knowledge_ids\": [\"kp_xxx\"]\n"
        "    }\n"
        "  ]\n"
        "}\n"
        "要求：\n"
        "1. 严禁包含 Thinking Process/Analysis of request 等模型思考过程。\n"
        "2. 所有问题和答案必须带稳定知识点链接或证据链接。\n"
    )
    
    prompt = (
        f"请为以下关联知识点与错题证据生成 {req.count} 张记忆闪卡。\n"
        f"知识点 IDs: {context['knowledge_ids']}\n"
        f"错题证据 IDs: {context['evidence_ids']}\n"
        f"以下是必须读取的本地 Wiki 正文与错题证据：\n{_context_prompt(context)}\n"
    )
    
    raw_json = await call_ai_json(req.ai_config, prompt, system_prompt)
    if "flashcards" not in raw_json:
        raise ArtifactValidationError("AI 返回的 JSON 缺少 'flashcards' 字段")
        
    cards: List[FlashcardRecord] = []
    for c_data in raw_json["flashcards"]:
        if not c_data.get("knowledge_ids"):
            c_data["knowledge_ids"] = context["knowledge_ids"]
        card = FlashcardRecord(**c_data)
        validate_flashcard(card)
        cards.append(card)
        
    deck_rel = f"flashcards/{deck_id}.md"
    
    deck_meta = {
        "id": deck_id,
        "type": "flashcards",
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "term_id": req.term_id or LEGACY_TERM_ID,
        "knowledge_ids": context["knowledge_ids"],
        "evidence_ids": context["evidence_ids"],
        "archived": False,
        "cards": [c.model_dump() for c in cards]
    }
    
    body = [
        "---json",
        json.dumps(deck_meta, ensure_ascii=False, indent=2),
        "---",
        "",
        f"# FocusLens 记忆闪卡卡组 - {deck_id}",
        "",
        "## 卡片列表",
        ""
    ]
    
    for i, c in enumerate(cards, 1):
        body.extend([
            f"### 卡片 {i}",
            "#### 正面",
            c.front_markdown.strip(),
            "",
            "#### 背面",
            c.back_markdown.strip(),
            "",
            f"*{render_markdown_links(c.knowledge_ids, context['evidence_ids'])}*",
            "",
            "---",
            ""
        ])
        
    deck_content = "\n".join(body)
    
    tx = store.begin_transaction("create-flashcards")
    try:
        tx.write_page(deck_rel, deck_content)
        tx.commit([{"tool": "create_flashcards", "deck_id": deck_id}])
    except Exception:
        tx.rollback()
        raise
        
    return {
        "id": deck_id,
        "path": deck_rel,
        "cards": [c.model_dump() for c in cards]
    }

async def generate_stage_report(store: WikiStore, req: CreateReportRequest) -> dict[str, Any]:
    report_id = f"report_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
    context = _collect_context(store, subject=req.subject, term_id=req.term_id)
    _require_generation_context(context)
    
    system_prompt = (
        "你是一个 FocusLens 学习分析助手，负责生成学生阶段性学习分析报告。\n"
        "你必须输出符合 JSON 格式的阶段报告，严格遵守以下 JSON 结构：\n"
        "{\n"
        "  \"overview\": \"整体学习情况概览（不少于50字）\",\n"
        "  \"evidence_summary\": [\"证据摘要 1\", \"证据摘要 2\"],\n"
        "  \"state_changes\": [\"掌握度变化 1\", \"掌握度变化 2\"],\n"
        "  \"repeated_reasons\": [\"重复犯错的根源原因分析\"],\n"
        "  \"review_order\": [\"建议先复习哪些概念，顺序是什么\"],\n"
        "  \"next_actions\": [\"下一步具体行动行动1\", \"下一步具体行动行动2\"]\n"
        "}\n"
        "要求：\n"
        "1. 报告必须包含真实的证据摘要和具体的下一步行动（包含稳定知识点与证据链接）。\n"
        "2. 严禁包含 Thinking Process/Analysis of request 等任何模型思考痕迹。\n"
    )
    
    prompt = (
        f"请为学科 {req.subject} （范围 {req.date_range}）生成一份系统学习报告。\n"
        f"以下是必须读取的本地 Wiki 正文与错题证据：\n{_context_prompt(context)}\n"
    )
    
    raw_json = await call_ai_json(req.ai_config, prompt, system_prompt)
    report = StageReport(**raw_json)
    validate_report(report)
    
    report_rel = f"reports/{report_id}.md"
    
    report_meta = {
        "id": report_id,
        "type": "report",
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "term_id": req.term_id or LEGACY_TERM_ID,
        "subject": req.subject,
        "date_range": req.date_range,
        "knowledge_ids": context["knowledge_ids"],
        "evidence_ids": context["evidence_ids"],
        "report_data": report.model_dump()
    }
    
    body = [
        "---json",
        json.dumps(report_meta, ensure_ascii=False, indent=2),
        "---",
        "",
        f"# FocusLens 学习阶段报告 ({req.subject}) - {report_id}",
        "",
        "## 整体情况概览",
        report.overview.strip(),
        "",
        "## 学习证据与错题摘要",
    ]
    for s in report.evidence_summary:
        body.append(f"- {s.strip()}")
        
    body.extend(["", "## 概念掌握度变化"])
    for sc in report.state_changes:
        body.append(f"- {sc.strip()}")
        
    body.extend(["", "## 重复性犯错根因"])
    for r in report.repeated_reasons:
        body.append(f"- {r.strip()}")
        
    body.extend(["", "## 推荐复习顺序"])
    for ro in report.review_order:
        body.append(f"- {ro.strip()}")
        
    body.extend(["", "## 下一步行动计划"])
    for a in report.next_actions:
        body.append(f"- {a.strip()}")
    body.extend(["", "## 关联知识与证据", render_markdown_links(context["knowledge_ids"], context["evidence_ids"])])
        
    report_content = "\n".join(body)
    
    tx = store.begin_transaction("create-stage-report")
    try:
        tx.write_page(report_rel, report_content)
        tx.commit([{"tool": "create_report", "report_id": report_id}])
    except Exception:
        tx.rollback()
        raise
        
    return {
        "id": report_id,
        "path": report_rel,
        "report_data": report.model_dump()
    }

def list_artifacts(store: WikiStore, term_id: str = "") -> list[dict[str, Any]]:
    artifacts = []
    
    # Scan papers, flashcards, reports directories
    for sub in ["papers", "flashcards", "reports"]:
        sub_dir = store.wiki_dir / sub
        if not sub_dir.exists():
            continue
        for p in sub_dir.rglob("*.md"):
            try:
                meta, _ = parse_page(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not term_matches(meta, term_id):
                continue
            artifacts.append({
                "id": meta.get("id") or p.stem,
                "type": meta.get("type") or sub,
                "created_at": meta.get("created_at") or "",
                "meta": meta,
                "path": p.relative_to(store.wiki_dir).as_posix()
            })
            
    return sorted(artifacts, key=lambda x: x["created_at"], reverse=True)

def delete_artifact(store: WikiStore, page_id: str) -> None:
    # Look for the file in papers, flashcards, reports
    found = False
    for sub in ["papers", "flashcards", "reports"]:
        sub_dir = store.wiki_dir / sub
        if not sub_dir.exists():
            continue
        for p in sub_dir.rglob("*.md"):
            try:
                meta, _ = parse_page(p.read_text(encoding="utf-8"))
                fid = meta.get("id") or p.stem
                if fid == page_id:
                    p.unlink()
                    # Also delete companion answers file if this is a paper
                    if sub == "papers" and page_id.endswith("_paper") or not page_id.endswith("_answers"):
                        # If deleting paper_xxx, also delete paper_xxx_answers
                        comp = p.parent / p.name.replace("_paper.md", "_answers.md")
                        if comp.exists():
                            comp.unlink()
                    found = True
                    break
            except Exception:
                continue
        if found:
            break
            
    if not found:
        raise FileNotFoundError(f"Artifact {page_id} not found.")

def archive_flashcard_deck(store: WikiStore, deck_id: str, archived: bool = True) -> dict[str, Any]:
    deck_rel = f"flashcards/{deck_id}.md"
    path = store.resolve(deck_rel)
    if not path.exists():
        raise FileNotFoundError(f"Flashcard deck {deck_id} not found.")
        
    meta, sections = parse_page(path.read_text(encoding="utf-8"))
    meta["archived"] = archived
    
    # Re-render deck
    body = [
        "---json",
        json.dumps(meta, ensure_ascii=False, indent=2),
        "---",
        "",
        f"# FocusLens 记忆闪卡卡组 - {deck_id}",
        "",
        "## 卡片列表",
        ""
    ]
    
    cards = meta.get("cards") or []
    for i, c in enumerate(cards, 1):
        body.extend([
            f"### 卡片 {i}",
            "#### 正面",
            c.get("front_markdown", "").strip(),
            "",
            "#### 背面",
            c.get("back_markdown", "").strip(),
            "",
            f"*{render_markdown_links(c.get('knowledge_ids', []), [])}*",
            "",
            "---",
            ""
        ])
        
    deck_content = "\n".join(body)
    store.write_page(deck_rel, deck_content)
    return meta
