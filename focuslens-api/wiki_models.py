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
    term_id: str = "legacy"
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
    "create_page",
    "update_fields",
    "merge_pages",
    "move_page",
    "add_links",
    "remove_links",
    "archive_evidence",
    "trash_page",
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


class IngestDecision(BaseModel):
    confidence: float = Field(ge=0, le=1)
    subject: str
    chapter: str
    short_title: str = Field(min_length=1, max_length=20)
    full_title: str
    existing_page_id: str = ""
    independent_concept: bool = False
    common_reasons: list[str] = Field(default_factory=list)
    prerequisites: list[str] = Field(default_factory=list)


class IngestResult(BaseModel):
    status: Literal["ingested", "pending"]
    event_id: str
    page_id: str = ""
    inbox_id: str = ""


class WikiGraphNodeV2(BaseModel):
    id: str
    label: str
    full_title: str = ""
    type: Literal["subject", "chapter", "knowledge", "prerequisite"]
    subject: str = ""
    chapter: str = ""
    mastery_state: MasteryState = MasteryState.PENDING_VERIFICATION
    evidence_count: int = 0
    page_id: str = ""
    why: str = ""
    recent_evidence: str = ""
    review_first: str = ""
    next_action: str = ""


class WikiGraphEdgeV2(BaseModel):
    source: str
    target: str
    type: Literal["contains", "prerequisite_of", "related_to"]


class WikiGraphResponseV2(BaseModel):
    mode: Literal["weak", "full"]
    nodes: list[WikiGraphNodeV2]
    edges: list[WikiGraphEdgeV2]


class OrganizePlanRequest(BaseModel):
    mode: Literal["incremental", "full"] = "incremental"
    instruction: str = ""
    subject: str = ""
    date_range: Literal["7d", "30d", "all"] = "30d"
    ai_config: dict[str, Any] = Field(default_factory=dict, exclude=True)


class OrganizePlan(BaseModel):
    run_id: str
    rounds: int
    operations: list[WikiOperation]
    conflicts: list[str] = Field(default_factory=list)
    source_hashes: dict[str, str] = Field(default_factory=dict)
    estimated_cost_usd: float = 0.0
    instruction: str = ""


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


class CreatePaperRequest(BaseModel):
    knowledge_ids: list[str]
    evidence_ids: list[str] = Field(default_factory=list)
    difficulty: str = "medium"
    count: int = 5
    term_id: str = "legacy"
    ai_config: dict[str, Any] = Field(exclude=True)


class CreateFlashcardsRequest(BaseModel):
    knowledge_ids: list[str]
    evidence_ids: list[str] = Field(default_factory=list)
    count: int = 5
    term_id: str = "legacy"
    ai_config: dict[str, Any] = Field(exclude=True)


class CreateReportRequest(BaseModel):
    subject: str
    date_range: str = "30d"
    term_id: str = "legacy"
    ai_config: dict[str, Any] = Field(exclude=True)
