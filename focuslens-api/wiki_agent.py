import os
import json
import uuid
import hashlib
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
import httpx
from pydantic import ValidationError

from wiki_store import WikiStore, WikiTransaction
from wiki_models import KnowledgePageMeta, WikiOperation, OrganizePlanRequest, OrganizePlan, MasteryState
from wiki_markdown import parse_page, render_knowledge_page
from wiki_ingest import subject_slug, stable_slug
from event_store import EventStore


class AgentPlanError(Exception):
    pass


class AgentState(dict):
    def __init__(self, run_id: str, mode: str, instruction: str, pages: list[dict[str, Any]], inbox: list[dict[str, Any]], source_hashes: dict[str, str], estimated_cost_usd: float, validation_feedback=None):
        super().__init__(
            run_id=run_id,
            mode=mode,
            instruction=instruction,
            pages=pages,
            inbox=inbox,
            source_hashes=source_hashes,
            estimated_cost_usd=estimated_cost_usd,
            validation_feedback=validation_feedback or []
        )

    @property
    def run_id(self) -> str:
        return self["run_id"]

    @property
    def mode(self) -> str:
        return self["mode"]

    @property
    def instruction(self) -> str:
        return self["instruction"]

    @property
    def pages(self) -> list[dict[str, Any]]:
        return self["pages"]

    @property
    def inbox(self) -> list[dict[str, Any]]:
        return self["inbox"]

    @property
    def source_hashes(self) -> dict[str, str]:
        return self["source_hashes"]

    @property
    def estimated_cost_usd(self) -> float:
        return self["estimated_cost_usd"]

    @property
    def validation_feedback(self) -> list[str]:
        return self["validation_feedback"]

    def with_validation_feedback(self, validation: "PlanValidation") -> "AgentState":
        return AgentState(
            run_id=self.run_id,
            mode=self.mode,
            instruction=self.instruction,
            pages=self.pages,
            inbox=self.inbox,
            source_hashes=self.source_hashes,
            estimated_cost_usd=self.estimated_cost_usd + 0.002,
            validation_feedback=self.validation_feedback + [validation.feedback]
        )


class PlanValidation:
    def __init__(self, ok: bool, conflicts: list[str], feedback: str):
        self.ok = ok
        self.conflicts = conflicts
        self.feedback = feedback


class FakeModelAdapter:
    def __init__(self, responses=None):
        self.responses = responses or []
        self.calls = 0
        self.last_state = None

    async def propose(self, state: AgentState):
        self.calls += 1
        self.last_state = state
        ops = []
        if self.calls <= len(self.responses):
            ops = self.responses[self.calls - 1]
        
        class FakeResponse:
            def __init__(self, operations):
                self.operations = operations
        
        return FakeResponse(ops)


class OpenAICompatibleWikiModelAdapter:
    """Uses the browser-provided AI config for one planning request only."""

    MAX_OPERATIONS_PER_RUN = 8
    MAX_PAGE_CONTENT_CHARS = 2200
    MAX_INBOX_CONTENT_CHARS = 1200
    MAX_OUTPUT_TOKENS = 3500

    def __init__(self, config: dict[str, Any]):
        self.config = config

    @staticmethod
    def _url(base_url: str) -> str:
        base = base_url.strip().rstrip("/")
        if not base:
            raise AgentPlanError("AI 接口地址为空，请先在配置页填写第三方 OpenAI-compatible 地址。")
        if base.endswith("/chat/completions"):
            return base
        if base.endswith("/v1"):
            return f"{base}/chat/completions"
        return f"{base}/v1/chat/completions"

    @staticmethod
    def _json_object(text: str) -> dict[str, Any]:
        fenced = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)
        candidate = fenced.group(1) if fenced else ""
        if not candidate:
            start = text.find("{")
            end = text.rfind("}")
            candidate = text[start:end + 1] if start >= 0 and end > start else ""
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError as exc:
            raise AgentPlanError("AI 整理没有返回可审核的 JSON 操作计划，请重试或调整本次整理意见。") from exc
        if not isinstance(payload, dict):
            raise AgentPlanError("AI 整理返回格式错误：顶层必须是 JSON 对象。")
        return payload

    @staticmethod
    def _compact_items(items: list[dict[str, Any]], content_limit: int) -> list[dict[str, Any]]:
        compact = []
        for item in items:
            content = str(item.get("content") or "")
            compact.append(
                {
                    "id": item.get("id"),
                    "meta": item.get("meta") or {},
                    "content": content[:content_limit],
                    "content_truncated": len(content) > content_limit,
                }
            )
        return compact

    def request_body(self, state: AgentState) -> dict[str, Any]:
        model = str(self.config.get("model") or "").strip()
        system = (
            "你是 FocusLens 本地学习 Wiki 整理 Agent。只输出 JSON，不输出 Thinking Process。"
            "顶层格式必须是 {\"operations\": [...]}。"
            f"每轮最多提出 {self.MAX_OPERATIONS_PER_RUN} 个最高优先级操作；剩余问题留到下一轮整理。"
            "每个操作必须包含 id、tool、reason、risk、before、after、conflicts、selected。"
            "before/after 只放发生变化的字段，不要复制整篇 Markdown。"
            "tool 只能是 create_page、update_fields、merge_pages、move_page、add_links、remove_links、archive_evidence、trash_page。"
            "工具字段必须严格使用以下格式："
            "merge_pages: before.source_page_ids 为待合并页面 ID 数组，after.target_page_id 为保留页面 ID；"
            "update_fields/move_page/add_links/remove_links: before.page_id 为单个页面 ID；"
            "trash_page: before.page_id；archive_evidence: before.event_id 和 after.page_id。"
            "如果仍有 chapter 为“待整理”的页面，优先为这些页面逐个提出 update_fields 章节归类操作，再考虑合并或建立链接。"
            "优先合并重复知识点、修正学科章节、建立可靠双链；不得覆盖 locked_fields/manual_fields；没有可靠证据时不要修改。"
        )
        if not self.config.get("enableThinking", False):
            system = "/no_think " + system
        evidence = {
            "mode": state.mode,
            "instruction": state.instruction,
            "pages": self._compact_items(state.pages, self.MAX_PAGE_CONTENT_CHARS),
            "inbox": self._compact_items(state.inbox, self.MAX_INBOX_CONTENT_CHARS),
            "validation_feedback": state.validation_feedback,
        }
        evidence_json = json.dumps(evidence, ensure_ascii=False)
        return {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": (
                        "请分析下面 <evidence> 中的 Wiki 数据。不要复述证据。"
                        "只返回顶层格式为 {\"operations\": [...]} 的整理操作 JSON。"
                        "若无需操作，返回 {\"operations\": []}。\n"
                        f"<evidence>\n{evidence_json}\n</evidence>"
                    ),
                },
            ],
            "temperature": 0.1,
            "max_tokens": self.MAX_OUTPUT_TOKENS,
            "response_format": {"type": "json_object"},
            "stream": False,
        }

    async def propose(self, state: AgentState):
        api_key = str(self.config.get("apiKey") or "").strip()
        model = str(self.config.get("model") or "").strip()
        if not api_key:
            raise AgentPlanError("AI API Key 为空，请先在配置页填写。")
        if not model:
            raise AgentPlanError("AI 模型名称为空，请先在配置页填写。")
        system = (
            "你是 FocusLens 本地学习 Wiki 整理 Agent。只输出 JSON，不输出 Thinking Process。"
            "顶层格式必须是 {\"operations\": [...]}。每个操作必须包含 id、tool、reason、risk、before、after、conflicts、selected。"
            "tool 只能是 create_page、update_fields、merge_pages、move_page、add_links、remove_links、archive_evidence、trash_page。"
            "优先合并重复知识点、修正学科章节、建立可靠双链；不得覆盖 locked_fields/manual_fields；没有可靠证据时不要修改。"
        )
        if not self.config.get("enableThinking", False):
            system = "/no_think " + system
        evidence = {
            "mode": state.mode,
            "instruction": state.instruction,
            "pages": state.pages,
            "inbox": state.inbox,
            "validation_feedback": state.validation_feedback,
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=110, write=20, pool=5)) as client:
                response = await client.post(
                    self._url(str(self.config.get("aiBaseUrl") or "")),
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json=self.request_body(state),
                )
        except httpx.TimeoutException as exc:
            raise AgentPlanError("第三方 AI 整理请求超时，请缩小范围或换用更快的模型。") from exc
        except httpx.HTTPError as exc:
            raise AgentPlanError(f"第三方 AI 整理请求连接失败：{exc}") from exc
        if response.status_code >= 400:
            raise AgentPlanError(f"第三方 AI 整理请求失败（HTTP {response.status_code}）：{response.text[:500]}")
        try:
            body = response.json()
        except ValueError as exc:
            raise AgentPlanError("第三方 AI 整理接口没有返回可解析的 JSON 响应。") from exc
        choices = body.get("choices") if isinstance(body, dict) else None
        message = choices[0].get("message", {}) if isinstance(choices, list) and choices else {}
        parsed = self._json_object(str(message.get("content") or message.get("reasoning_content") or ""))

        class Response:
            def __init__(self, operations):
                self.operations = operations

        return Response(parsed.get("operations", []))


class WikiPlanValidator:
    def __init__(self, store: WikiStore):
        self.store = store

    def validate(self, operations_data: list[dict[str, Any]], state: AgentState) -> list[WikiOperation]:
        validated_ops = []
        for op_data in operations_data:
            op_data = self._normalize_operation(op_data)
            # Construct WikiOperation to invoke Pydantic's tool schema verification
            op = WikiOperation(**op_data)
            self._enrich_display_fields(op)
            validated_ops.append(op)
        return validated_ops

    def _page_title(self, page_id: str) -> str:
        try:
            path = self.store.find_page_by_id(page_id)
            meta, _ = parse_page(path.read_text(encoding="utf-8"))
            return str(meta.get("short_title") or meta.get("full_title") or page_id)
        except FileNotFoundError:
            return page_id

    def _enrich_display_fields(self, op: WikiOperation) -> None:
        if op.tool == "merge_pages":
            source_ids = op.before.get("source_page_ids") or []
            target_id = op.after.get("target_page_id")
            op.before["source_page_titles"] = [self._page_title(page_id) for page_id in source_ids]
            if isinstance(target_id, str) and target_id:
                op.after["target_page_title"] = self._page_title(target_id)

    @staticmethod
    def _normalize_operation(op_data: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(op_data)
        before = dict(op_data.get("before") or {})
        after = dict(op_data.get("after") or {})
        tool = op_data.get("tool")
        risk_aliases = {
            "低": "low",
            "低风险": "low",
            "中": "medium",
            "中风险": "medium",
            "高": "high",
            "高风险": "high",
        }
        if op_data.get("risk") is not None:
            normalized["risk"] = risk_aliases.get(str(op_data["risk"]), op_data["risk"])

        if tool == "merge_pages":
            source_ids = before.get("source_page_ids") or before.get("pages_to_merge") or before.get("page_ids")
            target_id = after.get("target_page_id") or before.get("target_page_id")
            if not target_id and isinstance(before.get("target_page"), str):
                target_id = before["target_page"]
            if source_ids:
                source_ids = source_ids if isinstance(source_ids, list) else [source_ids]
                before["source_page_ids"] = [page_id for page_id in source_ids if page_id != target_id]
            target_updates = after.get("target_page")
            if isinstance(target_updates, dict):
                after.update(target_updates)
            after.pop("target_page", None)
            if target_id:
                after["target_page_id"] = target_id

        if tool in {"update_fields", "move_page", "add_links", "remove_links"}:
            page_id = before.get("page_id") or before.get("id")
            if not page_id and isinstance(before.get("source_page"), str):
                page_id = before["source_page"]
            if page_id:
                before["page_id"] = page_id
            if tool == "add_links" and before.get("target_pages") and not after.get("related"):
                after["related"] = before["target_pages"]

        normalized["before"] = before
        normalized["after"] = after
        return normalized


class WikiAgent:
    MAX_ROUNDS = 3

    def __init__(self, store: WikiStore, model=None):
        self.store = store
        self.model = model
        self.validator = WikiPlanValidator(store)
        self.events = EventStore(store.wiki_dir)

    def scan_scope(self, request: OrganizePlanRequest) -> AgentState:
        def included(path: Path, meta: dict[str, Any]) -> bool:
            item_subject = meta.get("subject") or (meta.get("decision") or {}).get("subject")
            if request.subject and item_subject != request.subject:
                return False
            if request.date_range == "all":
                return True
            days = 7 if request.date_range == "7d" else 30
            cutoff = datetime.now(timezone.utc) - timedelta(days=days)
            return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc) >= cutoff

        # Calculate hashes of all current knowledge pages
        current_hashes = {}
        knowledge_dir = self.store.wiki_dir / "knowledge"
        if knowledge_dir.exists():
            for path in knowledge_dir.rglob("*.md"):
                if "snapshots" in path.parents or "trash" in path.parents:
                    continue
                rel_path = path.relative_to(self.store.wiki_dir).as_posix()
                current_hashes[rel_path] = hashlib.md5(path.read_bytes()).hexdigest()

        # Calculate hashes of inbox items as well
        inbox_dir = self.store.wiki_dir / "inbox"
        inbox_items = []
        if inbox_dir.exists():
            for path in inbox_dir.glob("pending_*.md"):
                rel_path = path.relative_to(self.store.wiki_dir).as_posix()
                current_hashes[rel_path] = hashlib.md5(path.read_bytes()).hexdigest()
                
                try:
                    meta, sections = parse_page(path.read_text(encoding="utf-8"))
                    if not included(path, meta):
                        continue
                    inbox_items.append({
                        "id": meta.get("id"),
                        "meta": meta,
                        "content": path.read_text(encoding="utf-8")
                    })
                except Exception:
                    continue

        if request.mode == "full":
            pages = []
            if knowledge_dir.exists():
                for path in knowledge_dir.rglob("*.md"):
                    if "snapshots" in path.parents or "trash" in path.parents:
                        continue
                    try:
                        meta, sections = parse_page(path.read_text(encoding="utf-8"))
                        if not included(path, meta):
                            continue
                        pages.append({
                            "id": meta.get("id"),
                            "meta": meta,
                            "content": path.read_text(encoding="utf-8")
                        })
                    except Exception:
                        continue
            
            return AgentState(
                run_id=f"run_{uuid.uuid4().hex[:8]}",
                mode="full",
                instruction=request.instruction,
                pages=pages,
                inbox=inbox_items,
                source_hashes=current_hashes,
                estimated_cost_usd=0.002
            )

        # Mode is incremental
        index_file = self.store.wiki_dir / ".organize_index.json"
        stored_hashes = {}
        if index_file.exists():
            try:
                index_data = json.loads(index_file.read_text(encoding="utf-8"))
                stored_hashes = index_data.get("hashes", {})
            except Exception:
                pass

        # Identify changed pages
        changed_page_ids = set()
        
        if knowledge_dir.exists():
            for path in knowledge_dir.rglob("*.md"):
                if "snapshots" in path.parents or "trash" in path.parents:
                    continue
                rel_path = path.relative_to(self.store.wiki_dir).as_posix()
                curr_hash = current_hashes.get(rel_path)
                old_hash = stored_hashes.get(rel_path)
                if curr_hash != old_hash:
                    try:
                        meta, _ = parse_page(path.read_text(encoding="utf-8"))
                        if meta.get("id") and included(path, meta):
                            changed_page_ids.add(meta["id"])
                    except Exception:
                        continue

        # Load all knowledge page metadata to find neighbors
        all_metas = {}
        if knowledge_dir.exists():
            for path in knowledge_dir.rglob("*.md"):
                if "snapshots" in path.parents or "trash" in path.parents:
                    continue
                try:
                    meta, _ = parse_page(path.read_text(encoding="utf-8"))
                    if meta.get("id") and included(path, meta):
                        all_metas[meta["id"]] = (meta, path)
                except Exception:
                    continue

        starting_points = set(changed_page_ids)
        
        # Inbox items prerequisites are also starting points/neighbors
        for item in inbox_items:
            decision = item["meta"].get("decision", {})
            prereqs = decision.get("prerequisites", []) or item["meta"].get("prerequisites", []) or []
            for p in prereqs:
                starting_points.add(p)

        neighbor_page_ids = set()
        for pid in starting_points:
            if pid in all_metas:
                meta, _ = all_metas[pid]
                for p in meta.get("prerequisites", []):
                    neighbor_page_ids.add(p)
                for r in meta.get("related", []):
                    neighbor_page_ids.add(r)
            
            for other_id, (other_meta, _) in all_metas.items():
                if pid in other_meta.get("prerequisites", []) or pid in other_meta.get("related", []):
                    neighbor_page_ids.add(other_id)

        scanned_page_ids = changed_page_ids.union(neighbor_page_ids)
        
        pages = []
        for pid in scanned_page_ids:
            if pid in all_metas:
                meta, path = all_metas[pid]
                pages.append({
                    "id": pid,
                    "meta": meta,
                    "content": path.read_text(encoding="utf-8")
                })

        return AgentState(
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            mode="incremental",
            instruction=request.instruction,
            pages=pages,
            inbox=inbox_items,
            source_hashes=current_hashes,
            estimated_cost_usd=0.002
        )

    def validate_plan(self, operations: list[WikiOperation]) -> PlanValidation:
        conflicts = []
        ok = True

        def require_page(operation: WikiOperation, page_id: Any, field_name: str) -> bool:
            nonlocal ok
            if not isinstance(page_id, str) or not page_id:
                ok = False
                conflicts.append(f"操作 {operation.id} 没有明确指定要处理的知识页（缺少 {field_name}）。")
                return False
            try:
                self.store.find_page_by_id(page_id)
            except FileNotFoundError:
                ok = False
                conflicts.append(f"操作 {operation.id} 引用了已不存在的知识页 {page_id}。")
                return False
            return True
        
        for op in operations:
            if op.tool == "update_fields":
                page_id = op.before.get("id") or op.before.get("page_id") or op.after.get("id") or op.after.get("page_id")
                if require_page(op, page_id, "page_id"):
                    try:
                        path = self.store.find_page_by_id(page_id)
                        meta_data, _ = parse_page(path.read_text(encoding="utf-8"))
                        locked_fields = set(meta_data.get("locked_fields", [])) | set(meta_data.get("manual_fields", []))
                    except FileNotFoundError:
                        locked_fields = set()
                    
                    updated_keys = {k for k in op.after.keys() if k not in ["id", "page_id"]}
                    conflicted_fields = updated_keys.intersection(locked_fields)
                    if conflicted_fields:
                        ok = False
                        op.conflicts = list(set(op.conflicts) | conflicted_fields)
                        conflicts.append(f"Operation {op.id} tries to update locked fields: {sorted(list(conflicted_fields))}")

            elif op.tool == "merge_pages":
                target_id = op.after.get("target_page_id")
                source_ids = op.before.get("source_page_ids")
                target_ok = require_page(op, target_id, "target_page_id")
                if not isinstance(source_ids, list) or not source_ids:
                    ok = False
                    conflicts.append(f"操作 {op.id} 没有指定要合并的知识页。")
                    continue
                if target_id in source_ids:
                    ok = False
                    conflicts.append(f"操作 {op.id} 不能把保留页面合并到它自身。")
                if target_ok:
                    for source_id in source_ids:
                        require_page(op, source_id, "source_page_ids")

            elif op.tool in {"move_page", "add_links", "remove_links", "trash_page"}:
                page_id = op.before.get("page_id") or op.before.get("id") or op.after.get("page_id") or op.after.get("id")
                require_page(op, page_id, "page_id")

            elif op.tool == "archive_evidence":
                if not (op.before.get("event_id") and op.after.get("page_id")):
                    ok = False
                    conflicts.append(f"操作 {op.id} 没有明确指定学习记录或目标知识页。")
        
        feedback = "; ".join(conflicts) if conflicts else "OK"
        return PlanValidation(ok=ok, conflicts=conflicts, feedback=feedback)

    async def plan(self, request: OrganizePlanRequest) -> OrganizePlan:
        model = self.model or (OpenAICompatibleWikiModelAdapter(request.ai_config) if request.ai_config else None)
        if not model:
            raise AgentPlanError("No AI model configured for organization planning.")
        state = self.scan_scope(request)
        
        for round_number in range(1, self.MAX_ROUNDS + 1):
            try:
                response = await model.propose(state)
                operations = self.validator.validate(response.operations, state)
            except ValidationError as e:
                validation = PlanValidation(ok=False, conflicts=[], feedback=f"Schema validation failed: {str(e)}")
                state = state.with_validation_feedback(validation)
                continue
            
            validation = self.validate_plan(operations)
            if validation.ok:
                plan = OrganizePlan(
                    run_id=state.run_id,
                    rounds=round_number,
                    operations=operations,
                    conflicts=validation.conflicts,
                    source_hashes=state.source_hashes,
                    estimated_cost_usd=state.estimated_cost_usd,
                    instruction=request.instruction,
                )
                self._save_run(plan.run_id, plan, "pending")
                return plan
            
            state = state.with_validation_feedback(validation)
            
        raise AgentPlanError("三轮内未生成可安全执行的整理计划。")

    def _save_run(self, run_id: str, plan: OrganizePlan, status: str = "pending", transaction_id: str | None = None, executed_operation_ids: list[str] | None = None) -> None:
        run_dir = self.store.wiki_dir / "organize_runs"
        run_dir.mkdir(parents=True, exist_ok=True)
        data = {
            "plan": plan.model_dump(mode="json"),
            "status": status,
            "transaction_id": transaction_id,
            "executed_operation_ids": executed_operation_ids or []
        }
        path = run_dir / f"{run_id}.json"
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_run(self, run_id: str) -> dict[str, Any]:
        path = self.store.wiki_dir / "organize_runs" / f"{run_id}.json"
        if not path.exists():
            raise FileNotFoundError(f"Run {run_id} not found.")
        return json.loads(path.read_text(encoding="utf-8"))

    def _knowledge_relative(self, meta: KnowledgePageMeta) -> str:
        subject = subject_slug(meta.subject)
        chapter = stable_slug(meta.chapter, "chapter")
        return f"knowledge/{subject}/{chapter}/{meta.id}.md"

    def _ensure_subject_and_chapter_tx(self, tx: WikiTransaction, subject: str, chapter: str) -> None:
        subject_id = subject_slug(subject)
        chapter_id = stable_slug(chapter, "chapter")
        subject_path = self.store.wiki_dir / "subjects" / subject_id / "index.md"
        chapter_path = self.store.wiki_dir / "subjects" / subject_id / "chapters" / f"{chapter_id}.md"
        if not subject_path.exists():
            tx.write_page(
                f"subjects/{subject_id}/index.md",
                f"# {subject}\n\n本学科由 FocusLens Wiki 自动建立。\n",
            )
        if not chapter_path.exists():
            tx.write_page(
                f"subjects/{subject_id}/chapters/{chapter_id}.md",
                f"# {chapter}\n\n所属学科：{subject}\n",
            )

    def execute_plan(self, plan: OrganizePlan, selected_op_ids: list[str]) -> str:
        # Revalidate selected operations immediately before execution
        for rel_path, expected_hash in plan.source_hashes.items():
            path = self.store.wiki_dir / rel_path
            if not path.exists():
                raise ValueError(f"Plan is stale: path {rel_path} no longer exists.")
            curr_hash = hashlib.md5(path.read_bytes()).hexdigest()
            if curr_hash != expected_hash:
                raise ValueError(f"Plan is stale: content of {rel_path} has changed.")

        tx = self.store.begin_transaction("organize")
        try:
            executed_ops = []
            for op in plan.operations:
                if op.id not in selected_op_ids:
                    continue
                self._execute_operation(tx, op)
                executed_ops.append(op.model_dump(mode="json"))
            tx_id = tx.commit(executed_ops)
            return tx_id
        except Exception as e:
            tx.rollback()
            raise e

    def _write_organize_index(self, transaction_id: str) -> None:
        hashes = {}
        for folder in ("knowledge", "inbox"):
            root = self.store.wiki_dir / folder
            if not root.exists():
                continue
            for path in root.rglob("*.md"):
                if "snapshots" in path.parts or "trash" in path.parts:
                    continue
                relative = path.relative_to(self.store.wiki_dir).as_posix()
                hashes[relative] = hashlib.md5(path.read_bytes()).hexdigest()
        index_path = self.store.wiki_dir / ".organize_index.json"
        temp_path = index_path.with_suffix(".tmp")
        temp_path.write_text(
            json.dumps(
                {"last_transaction_id": transaction_id, "hashes": hashes},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        temp_path.replace(index_path)

    def execute_run(self, run_id: str, selected_op_ids: list[str]) -> str:
        run_data = self.get_run(run_id)
        if run_data["status"] != "pending":
            raise ValueError(f"Run {run_id} is not in pending status.")
        plan = OrganizePlan(**run_data["plan"])
        plan.operations = self.validator.validate(
            [operation.model_dump(mode="json") for operation in plan.operations],
            None,
        )
        validation = self.validate_plan(plan.operations)
        if not validation.ok:
            raise ValueError(f"整理计划已失效，请重新生成：{validation.feedback}")
        if not selected_op_ids:
            raise ValueError("请至少选择一个整理操作后再执行。")
        known_ids = {operation.id for operation in plan.operations}
        unknown_ids = set(selected_op_ids) - known_ids
        if unknown_ids:
            raise ValueError(f"整理计划中不存在这些操作：{', '.join(sorted(unknown_ids))}")
        tx_id = self.execute_plan(plan, selected_op_ids)
        self._write_organize_index(tx_id)
        self._save_run(run_id, plan, "executed", tx_id, selected_op_ids)
        return tx_id

    def undo_run(self, run_id: str) -> str:
        run_data = self.get_run(run_id)
        if run_data["status"] != "executed":
            raise ValueError(f"Run {run_id} is not in executed status.")
        tx_id = run_data["transaction_id"]
        if not tx_id:
            raise ValueError(f"No transaction ID associated with run {run_id}.")
        undo_id = self.store.undo_transaction(tx_id)
        plan = OrganizePlan(**run_data["plan"])
        self._save_run(run_id, plan, "undone", tx_id, run_data["executed_operation_ids"])
        return undo_id

    def _execute_operation(self, tx: WikiTransaction, op: WikiOperation) -> None:
        if op.tool == "create_page":
            meta = KnowledgePageMeta(
                id=op.after["id"],
                subject=op.after["subject"],
                chapter=op.after["chapter"],
                short_title=op.after["short_title"],
                full_title=op.after["full_title"],
                prerequisites=op.after.get("prerequisites", []),
                related=op.after.get("related", []),
                evidence_ids=op.after.get("evidence_ids", []),
            )
            sections = op.after.get("sections") or {}
            relative = self._knowledge_relative(meta)
            self._ensure_subject_and_chapter_tx(tx, meta.subject, meta.chapter)
            tx.write_page(relative, render_knowledge_page(meta, sections))

        elif op.tool == "update_fields":
            page_id = op.before.get("id") or op.before.get("page_id") or op.after.get("id") or op.after.get("page_id")
            if not page_id:
                raise ValueError(f"Missing page_id for update_fields operation {op.id}")
            path = self.store.find_page_by_id(page_id)
            meta_data, sections = parse_page(path.read_text(encoding="utf-8"))
            meta = KnowledgePageMeta(**meta_data)
            protected = set(meta.manual_fields) | set(meta.locked_fields)
            for k, v in op.after.items():
                if k in ["id", "page_id"]:
                    continue
                if k not in protected:
                    if hasattr(meta, k):
                        setattr(meta, k, v)
                    elif k == "sections" and isinstance(v, dict):
                        for sec_k, sec_v in v.items():
                            sections[sec_k] = sec_v
            new_relative = self._knowledge_relative(meta)
            current_relative = path.relative_to(self.store.wiki_dir).as_posix()
            tx.write_page(current_relative, render_knowledge_page(meta, sections))
            if current_relative != new_relative:
                tx.move_page(current_relative, new_relative)

        elif op.tool == "merge_pages":
            target_id = op.after.get("target_page_id") or op.after.get("page_id") or op.before.get("target_page_id")
            source_ids = op.before.get("source_page_ids") or op.before.get("page_ids") or op.before.get("source_id") or []
            if isinstance(source_ids, str):
                source_ids = [source_ids]
            if not target_id:
                raise ValueError(f"Missing target_page_id for merge_pages operation {op.id}")
            
            target_path = self.store.find_page_by_id(target_id)
            target_meta_data, target_sections = parse_page(target_path.read_text(encoding="utf-8"))
            target_meta = KnowledgePageMeta(**target_meta_data)
            protected = set(target_meta.manual_fields) | set(target_meta.locked_fields)
            for field_name in ("short_title", "full_title", "subject", "chapter"):
                if field_name in op.after and field_name not in protected:
                    setattr(target_meta, field_name, op.after[field_name])
            
            for s_id in source_ids:
                try:
                    s_path = self.store.find_page_by_id(s_id)
                except FileNotFoundError:
                    continue
                s_meta_data, s_sections = parse_page(s_path.read_text(encoding="utf-8"))
                s_meta = KnowledgePageMeta(**s_meta_data)
                
                target_meta.evidence_ids = sorted(set(target_meta.evidence_ids + s_meta.evidence_ids))
                target_meta.prerequisites = sorted(set(target_meta.prerequisites + s_meta.prerequisites))
                target_meta.prerequisites = [p for p in target_meta.prerequisites if p != target_id and p not in source_ids]
                target_meta.related = sorted(set(target_meta.related + s_meta.related))
                target_meta.related = [r for r in target_meta.related if r != target_id and r not in source_ids]
                
                for heading, content in s_sections.items():
                    if content.strip():
                        curr = target_sections.get(heading, "").strip()
                        if curr:
                            target_sections[heading] = f"{curr}\n\n{content}"
                        else:
                            target_sections[heading] = content
                
                s_relative = s_path.relative_to(self.store.wiki_dir).as_posix()
                tx.trash_page(s_relative)
            
            target_relative = target_path.relative_to(self.store.wiki_dir).as_posix()
            new_relative = self._knowledge_relative(target_meta)
            tx.write_page(target_relative, render_knowledge_page(target_meta, target_sections))
            if target_relative != new_relative:
                self._ensure_subject_and_chapter_tx(tx, target_meta.subject, target_meta.chapter)
                tx.move_page(target_relative, new_relative)

        elif op.tool == "move_page":
            page_id = op.before.get("page_id") or op.before.get("id") or op.after.get("page_id") or op.after.get("id")
            if not page_id:
                raise ValueError(f"Missing page_id for move_page operation {op.id}")
            path = self.store.find_page_by_id(page_id)
            meta_data, sections = parse_page(path.read_text(encoding="utf-8"))
            meta = KnowledgePageMeta(**meta_data)
            protected = set(meta.manual_fields) | set(meta.locked_fields)
            if "subject" in op.after and "subject" not in protected:
                meta.subject = op.after["subject"]
            if "chapter" in op.after and "chapter" not in protected:
                meta.chapter = op.after["chapter"]
            self._ensure_subject_and_chapter_tx(tx, meta.subject, meta.chapter)
            new_relative = self._knowledge_relative(meta)
            current_relative = path.relative_to(self.store.wiki_dir).as_posix()
            tx.write_page(current_relative, render_knowledge_page(meta, sections))
            if current_relative != new_relative:
                tx.move_page(current_relative, new_relative)

        elif op.tool == "add_links":
            page_id = op.after.get("page_id") or op.after.get("id") or op.before.get("page_id") or op.before.get("id")
            if not page_id:
                raise ValueError(f"Missing page_id for add_links operation {op.id}")
            path = self.store.find_page_by_id(page_id)
            meta_data, sections = parse_page(path.read_text(encoding="utf-8"))
            meta = KnowledgePageMeta(**meta_data)
            protected = set(meta.manual_fields) | set(meta.locked_fields)
            if "prerequisites" in op.after and "prerequisites" not in protected:
                meta.prerequisites = sorted(set(meta.prerequisites + op.after["prerequisites"]))
            if "related" in op.after and "related" not in protected:
                meta.related = sorted(set(meta.related + op.after["related"]))
            tx.write_page(path.relative_to(self.store.wiki_dir).as_posix(), render_knowledge_page(meta, sections))

        elif op.tool == "remove_links":
            page_id = op.before.get("page_id") or op.before.get("id") or op.after.get("page_id") or op.after.get("id")
            if not page_id:
                raise ValueError(f"Missing page_id for remove_links operation {op.id}")
            path = self.store.find_page_by_id(page_id)
            meta_data, sections = parse_page(path.read_text(encoding="utf-8"))
            meta = KnowledgePageMeta(**meta_data)
            protected = set(meta.manual_fields) | set(meta.locked_fields)
            if "prerequisites" in op.after and "prerequisites" not in protected:
                meta.prerequisites = [p for p in meta.prerequisites if p not in op.after["prerequisites"]]
            if "related" in op.after and "related" not in protected:
                meta.related = [r for r in meta.related if r not in op.after["related"]]
            tx.write_page(path.relative_to(self.store.wiki_dir).as_posix(), render_knowledge_page(meta, sections))

        elif op.tool == "archive_evidence":
            event_id = op.before.get("event_id") or op.after.get("event_id")
            page_id = op.after.get("page_id") or op.after.get("id")
            if event_id and page_id:
                try:
                    source_path = self.events._find_path(event_id)
                    tx._snapshot(source_path)
                    event = self.events.get(event_id)
                    created = datetime.fromisoformat(event.created_at)
                    target_path = self.events.evidence_dir / created.strftime("%Y") / created.strftime("%m") / source_path.name
                    tx._snapshot(target_path)
                    self.events.archive_as_evidence(event_id, [page_id])
                except FileNotFoundError:
                    pass

        elif op.tool == "trash_page":
            page_id = op.before.get("page_id") or op.before.get("id")
            if not page_id:
                raise ValueError(f"Missing page_id for trash_page operation {op.id}")
            path = self.store.find_page_by_id(page_id)
            relative = path.relative_to(self.store.wiki_dir).as_posix()
            tx.trash_page(relative)
