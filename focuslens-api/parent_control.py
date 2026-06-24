import json
import os
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


AiTeacherMode = Literal["enabled", "ask_parent", "disabled"]


class ParentSettings(BaseModel):
    aiTeacherMode: AiTeacherMode = "enabled"
    driftReminderEnabled: bool = True
    idleReminderEnabled: bool = True
    absentReminderEnabled: bool = True
    longIdleMinutes: int = Field(default=10, ge=1, le=120)
    aiApprovedQuestionId: str = ""
    aiApprovalAction: str = "none"


class ParentSample(BaseModel):
    ts: int
    state: str
    reason: str = ""
    motionScore: float = 0.0


class StudentStatus(BaseModel):
    learningState: str = "UNKNOWN"
    reason: str = ""
    writingActive: bool = False
    absent: bool = False
    aiBusy: bool = False
    activeTab: str = ""
    lastLearningAt: str = ""
    updatedAt: str = ""
    samples: list[ParentSample] = Field(default_factory=list)
    pendingQuestionId: str = ""
    pendingQuestionText: str = ""
    aiApprovalStatus: str = "none"


class ParentReminder(BaseModel):
    id: str
    type: Literal["focus", "idle", "absent", "custom"] = "focus"
    message: str
    createdAt: str
    delivered: bool = False


class ParentReminderRequest(BaseModel):
    type: Literal["focus", "idle", "absent", "custom"] = "focus"
    message: str = "请回到当前学习任务。"


class ParentStatusRequest(BaseModel):
    learningState: str = "UNKNOWN"
    reason: str = ""
    writingActive: bool = False
    absent: bool = False
    aiBusy: bool = False
    activeTab: str = ""
    lastLearningAt: str = ""
    samples: list[ParentSample] = Field(default_factory=list)
    pendingQuestionId: str = ""
    pendingQuestionText: str = ""
    aiApprovalStatus: str = "none"


class ParentState(BaseModel):
    settings: ParentSettings = Field(default_factory=ParentSettings)
    student: StudentStatus = Field(default_factory=StudentStatus)
    reminders: list[ParentReminder] = Field(default_factory=list)
    pairingCode: str = ""
    updatedAt: str = ""


class ParentControlStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def read(self) -> ParentState:
        with self._lock:
            return self._read_unlocked()

    def update_status(self, request: ParentStatusRequest) -> ParentState:
        with self._lock:
            state = self._read_unlocked()
            timestamp = now_iso()
            
            # Prevent background tabs or other client sessions from overwriting an active pending request
            curr = state.student
            if curr.aiApprovalStatus == "pending" and request.aiApprovalStatus == "none":
                # Check if this is an explicit cancellation request from the active student tab
                is_cancelled = (request.pendingQuestionId == curr.pendingQuestionId)
                # Or if the parent console has already approved/rejected the question
                is_processed = (state.settings.aiApprovedQuestionId == curr.pendingQuestionId)
                
                if not (is_cancelled or is_processed):
                    # Preserve the existing pending request status
                    request.pendingQuestionId = curr.pendingQuestionId
                    request.pendingQuestionText = curr.pendingQuestionText
                    request.aiApprovalStatus = curr.aiApprovalStatus
            
            print(f"DEBUG update_status: aiApprovalStatus={request.aiApprovalStatus}, pendingQuestionId={request.pendingQuestionId}, pendingQuestionText={request.pendingQuestionText}")
            state.student = StudentStatus(**request.model_dump(), updatedAt=timestamp)
            state.updatedAt = timestamp
            self._write_unlocked(state)
            return state

    def update_settings(self, settings: ParentSettings) -> ParentState:
        with self._lock:
            state = self._read_unlocked()
            state.settings = settings
            
            # Automatically clear the student's pending status if the parent approved or rejected it
            if state.student.aiApprovalStatus == "pending" and settings.aiApprovedQuestionId == state.student.pendingQuestionId:
                state.student.aiApprovalStatus = "none"
                state.student.pendingQuestionId = ""
                state.student.pendingQuestionText = ""
                
            state.updatedAt = now_iso()
            self._write_unlocked(state)
            return state

    def add_reminder(self, request: ParentReminderRequest) -> ParentState:
        with self._lock:
            state = self._read_unlocked()
            timestamp = now_iso()
            state.reminders.insert(
                0,
                ParentReminder(
                    id=f"reminder_{uuid.uuid4().hex[:10]}",
                    type=request.type,
                    message=request.message.strip() or "请回到当前学习任务。",
                    createdAt=timestamp,
                ),
            )
            state.reminders = state.reminders[:50]
            state.updatedAt = timestamp
            self._write_unlocked(state)
            return state

    def pending_reminders(self) -> list[ParentReminder]:
        with self._lock:
            state = self._read_unlocked()
            return [item for item in state.reminders if not item.delivered]

    def mark_delivered(self, reminder_id: str) -> ParentState:
        with self._lock:
            state = self._read_unlocked()
            for item in state.reminders:
                if item.id == reminder_id:
                    item.delivered = True
                    break
            state.updatedAt = now_iso()
            self._write_unlocked(state)
            return state

    def _read_unlocked(self) -> ParentState:
        if not self.path.exists():
            state = ParentState(pairingCode=self._new_pairing_code(), updatedAt=now_iso())
            self._write_unlocked(state)
            return state
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            state = ParentState(**raw)
            if not state.pairingCode:
                state.pairingCode = self._new_pairing_code()
            return state
        except Exception:
            return ParentState(pairingCode=self._new_pairing_code(), updatedAt=now_iso())

    def _write_unlocked(self, state: ParentState) -> None:
        self.path.write_text(json.dumps(state.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")

    @staticmethod
    def _new_pairing_code() -> str:
        return uuid.uuid4().hex[:6].upper()


def default_parent_store_path() -> Path:
    return Path(os.getenv("FOCUSLENS_PARENT_STATE", str(Path(__file__).parent / "parent_state.json")))


def create_parent_router(store: ParentControlStore) -> APIRouter:
    router = APIRouter(prefix="/api/parent", tags=["parent"])

    @router.get("/status", response_model=ParentState)
    def get_parent_status():
        return store.read()

    @router.post("/status", response_model=ParentState)
    def update_parent_status(request: ParentStatusRequest):
        return store.update_status(request)

    @router.post("/settings", response_model=ParentState)
    def update_parent_settings(settings: ParentSettings):
        return store.update_settings(settings)

    @router.post("/reminders", response_model=ParentState)
    def create_parent_reminder(request: ParentReminderRequest):
        return store.add_reminder(request)

    @router.get("/reminders", response_model=list[ParentReminder])
    def get_parent_reminders():
        return store.pending_reminders()

    @router.post("/reminders/{reminder_id}/delivered", response_model=ParentState)
    def mark_parent_reminder_delivered(reminder_id: str):
        return store.mark_delivered(reminder_id)

    return router
