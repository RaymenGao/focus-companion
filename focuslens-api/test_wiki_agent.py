import unittest
import tempfile
import hashlib
import json
import os
import time
from pathlib import Path
from pydantic import ValidationError

from wiki_store import WikiStore
from wiki_models import KnowledgePageMeta, WikiOperation, OrganizePlanRequest, OrganizePlan, MasteryState
from wiki_markdown import render_knowledge_page, parse_page

from wiki_agent import WikiAgent, FakeModelAdapter, AgentPlanError, OpenAICompatibleWikiModelAdapter, WikiPlanValidator


class WikiAgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.wiki_dir = Path(self.temp.name) / "wiki"
        self.store = WikiStore(self.wiki_dir)
        
        # Create some initial pages
        self.meta1 = KnowledgePageMeta(
            id="kp_math_1",
            subject="数学",
            chapter="数与代数",
            short_title="分数裂项",
            full_title="分数裂项相消",
            locked_fields={"full_title"},
            prerequisites=["kp_math_2"]
        )
        self.store.write_page(
            "knowledge/math/kp_math_1.md",
            render_knowledge_page(self.meta1, {"核心概念": "裂项相消"})
        )

        self.meta2 = KnowledgePageMeta(
            id="kp_math_2",
            subject="数学",
            chapter="数与代数",
            short_title="分数基础",
            full_title="分数基本性质",
        )
        self.store.write_page(
            "knowledge/math/kp_math_2.md",
            render_knowledge_page(self.meta2, {"核心概念": "分子分母同时乘除"})
        )

        # Create an unrelated page
        self.meta3 = KnowledgePageMeta(
            id="kp_english_1",
            subject="英语",
            chapter="语法",
            short_title="时态",
            full_title="一般现在时",
        )
        self.store.write_page(
            "knowledge/english/kp_english_1.md",
            render_knowledge_page(self.meta3, {"核心概念": "时态用法"})
        )

    def tearDown(self):
        self.temp.cleanup()

    def get_dir_hashes(self):
        hashes = {}
        for p in self.wiki_dir.rglob("*.md"):
            if "snapshots" in p.parts or "trash" in p.parts:
                continue
            hashes[p.relative_to(self.wiki_dir).as_posix()] = hashlib.md5(p.read_bytes()).hexdigest()
        return hashes

    async def test_fake_model_invalid_plan_called_exactly_three_times(self):
        # A model that always returns an invalid plan (e.g. updating a locked field)
        invalid_op = {
            "id": "op-1",
            "tool": "update_fields",
            "reason": "Update locked field",
            "before": {"id": "kp_math_1", "full_title": "分数裂项相消"},
            "after": {"id": "kp_math_1", "full_title": "新分数裂项"},
        }
        # Model proposes the same invalid operation in all rounds
        fake_model = FakeModelAdapter(responses=[[invalid_op], [invalid_op], [invalid_op], [invalid_op]])
        agent = WikiAgent(self.store, model=fake_model)
        
        request = OrganizePlanRequest(mode="incremental", instruction="Test instruction")
        
        with self.assertRaises(AgentPlanError):
            await agent.plan(request)
            
        self.assertEqual(fake_model.calls, 3)

    def test_unknown_tool_fails_schema_validation(self):
        # Verification that unknown tools fail schema validation
        with self.assertRaises(ValidationError):
            WikiOperation(
                id="op-bad",
                tool="invalid_tool_name",
                reason="Should fail",
                before={},
                after={}
            )

    def test_merge_pages_aliases_are_normalized_and_executable(self):
        operation_data = {
            "id": "op-merge-alias",
            "tool": "merge_pages",
            "reason": "Merge duplicate pages",
            "risk": "低",
            "before": {
                "pages_to_merge": ["kp_math_1", "kp_math_2"],
                "target_page": "kp_math_2",
            },
            "after": {
                "target_page": {
                    "short_title": "fraction merged",
                    "full_title": "Fraction merged knowledge",
                }
            },
        }
        operation = WikiPlanValidator(self.store).validate([operation_data], None)[0]

        self.assertEqual(operation.before["source_page_ids"], ["kp_math_1"])
        self.assertEqual(operation.after["target_page_id"], "kp_math_2")
        self.assertEqual(operation.after["short_title"], "fraction merged")
        self.assertEqual(operation.risk, "low")

        plan = OrganizePlan(
            run_id="run_merge_alias",
            rounds=1,
            operations=[operation],
            source_hashes=self.get_dir_hashes(),
        )
        WikiAgent(self.store).execute_plan(plan, [operation.id])

        target_path = self.store.find_page_by_id("kp_math_2")
        target_meta, _ = parse_page(target_path.read_text(encoding="utf-8"))
        self.assertEqual(target_meta["short_title"], "fraction merged")
        with self.assertRaises(FileNotFoundError):
            self.store.find_page_by_id("kp_math_1")

    def test_legacy_batch_update_failure_is_parent_readable(self):
        operation = WikiPlanValidator(self.store).validate(
            [
                {
                    "id": "op-legacy-batch-update",
                    "tool": "update_fields",
                    "reason": "Move several pages into one chapter",
                    "before": {"pages": ["kp_math_1", "kp_math_2"]},
                    "after": {"chapter": "Algebra"},
                }
            ],
            None,
        )[0]

        validation = WikiAgent(self.store).validate_plan([operation])

        self.assertFalse(validation.ok)
        self.assertIn("没有明确指定要处理的知识页", validation.feedback)
        self.assertNotIn("is missing page_id", validation.feedback)

    async def test_invalid_merge_plan_is_retried_instead_of_reaching_execution(self):
        invalid_merge = {
            "id": "op-invalid-merge",
            "tool": "merge_pages",
            "reason": "Missing a target page",
            "before": {"pages_to_merge": ["kp_math_1"]},
            "after": {},
        }
        fake_model = FakeModelAdapter(responses=[[invalid_merge], [invalid_merge], [invalid_merge]])

        with self.assertRaises(AgentPlanError):
            await WikiAgent(self.store, model=fake_model).plan(OrganizePlanRequest(mode="full"))

        self.assertEqual(fake_model.calls, 3)

    async def test_locked_field_update_becomes_conflict_and_not_executable(self):
        # Test that updating a locked field creates a conflict in the operation,
        # which fails validation and is returned as a conflict.
        # Round 1: proposes update to locked field 'full_title' on kp_math_1 -> validation fails
        # Round 2: proposes a valid update to 'short_title' (which is not locked) -> validation succeeds
        invalid_op = {
            "id": "op-1",
            "tool": "update_fields",
            "reason": "Try to update locked field",
            "before": {"id": "kp_math_1", "full_title": "分数裂项相消"},
            "after": {"id": "kp_math_1", "full_title": "新裂项"},
        }
        valid_op = {
            "id": "op-2",
            "tool": "update_fields",
            "reason": "Update unlocked field",
            "before": {"id": "kp_math_1", "short_title": "分数裂项"},
            "after": {"id": "kp_math_1", "short_title": "裂项"},
        }
        
        fake_model = FakeModelAdapter(responses=[[invalid_op], [valid_op]])
        agent = WikiAgent(self.store, model=fake_model)
        
        request = OrganizePlanRequest(mode="incremental", instruction="Repair plan")
        plan = await agent.plan(request)
        
        self.assertEqual(fake_model.calls, 2)
        self.assertEqual(plan.rounds, 2)
        self.assertEqual(len(plan.operations), 1)
        self.assertEqual(plan.operations[0].id, "op-2")
        self.assertEqual(plan.operations[0].tool, "update_fields")

    async def test_manual_field_update_becomes_conflict(self):
        self.meta2.manual_fields = {"chapter"}
        self.store.write_page(
            "knowledge/math/kp_math_2.md",
            render_knowledge_page(self.meta2, {"核心概念": "分子分母同时乘除"}),
        )
        invalid_op = {
            "id": "op-manual",
            "tool": "update_fields",
            "reason": "Try to overwrite a parent-confirmed chapter",
            "before": {"id": "kp_math_2"},
            "after": {"id": "kp_math_2", "chapter": "错误章节"},
        }
        fake_model = FakeModelAdapter(responses=[[invalid_op], [invalid_op], [invalid_op]])

        with self.assertRaises(AgentPlanError):
            await WikiAgent(self.store, model=fake_model).plan(
                OrganizePlanRequest(mode="incremental", instruction="Protect manual fields")
            )

    async def test_incremental_mode_reads_only_changed_pages_and_neighbors(self):
        # We write an index file indicating hashes of kp_math_1, kp_math_2, kp_english_1.
        # Then we modify kp_math_1 only.
        # Incremental scan should only scan:
        # - changed pages (kp_math_1)
        # - neighbors of changed pages (kp_math_2, because kp_math_1 has prerequisite kp_math_2)
        # It should NOT scan kp_english_1 (since it is unrelated and unchanged).
        
        initial_hashes = self.get_dir_hashes()
        # Create/write the organize state/index with these initial hashes
        state_file = self.wiki_dir / ".organize_index.json"
        state_file.write_text(json.dumps({
            "last_transaction_id": "tx_init",
            "hashes": initial_hashes
        }, ensure_ascii=False))
        
        # Modify kp_math_1 content to change its hash
        self.meta1.full_title = "分数裂项相消(已修改)"
        self.store.write_page(
            "knowledge/math/kp_math_1.md",
            render_knowledge_page(self.meta1, {"核心概念": "裂项相消"})
        )
        
        # Instantiate agent
        fake_model = FakeModelAdapter(responses=[[]])
        agent = WikiAgent(self.store, model=fake_model)
        
        request = OrganizePlanRequest(mode="incremental", instruction="Incremental run")
        await agent.plan(request)
        
        # Inspect state scanned by model
        scanned_state = fake_model.last_state
        self.assertIsNotNone(scanned_state)
        
        # Scanned pages should contain kp_math_1 and kp_math_2, but NOT kp_english_1
        scanned_page_ids = {page["id"] for page in scanned_state.get("pages", [])}
        self.assertIn("kp_math_1", scanned_page_ids)
        self.assertIn("kp_math_2", scanned_page_ids)
        self.assertNotIn("kp_english_1", scanned_page_ids)

    async def test_full_mode_rejected_unless_explicitly_contains_mode_full(self):
        # If the mode is "full", the agent is allowed to do a full scan.
        # But if the request has mode set to anything else (or defaults), it's incremental.
        # If we try to call a full plan but the request has mode="incremental", it shouldn't scan all.
        fake_model = FakeModelAdapter(responses=[[]])
        agent = WikiAgent(self.store, model=fake_model)
        
        # Requesting full mode explicitly
        request_full = OrganizePlanRequest(mode="full", instruction="Full run")
        await agent.plan(request_full)
        self.assertEqual(len(fake_model.last_state.get("pages", [])), 3) # all pages scanned

        # Requesting incremental (or default)
        request_inc = OrganizePlanRequest(mode="incremental", instruction="Inc run")
        await agent.plan(request_inc)
        # In incremental with no index file, all are treated as changed/new, but let's test rejected case:
        # If mode is not "full", any attempt to execute a full scan is rejected.
        # If they request with an invalid mode, it raises HTTP 400 or ValueError.
        with self.assertRaises(ValidationError):
            # ValidationError is raised for invalid mode due to Literal constraint
            OrganizePlanRequest(mode="invalid_mode")

    async def test_subject_and_date_filters_limit_pages_sent_to_model(self):
        old_timestamp = time.time() - (45 * 24 * 60 * 60)
        english_path = self.store.find_page_by_id("kp_english_1")
        os.utime(english_path, (old_timestamp, old_timestamp))
        fake_model = FakeModelAdapter(responses=[[]])
        agent = WikiAgent(self.store, model=fake_model)

        await agent.plan(OrganizePlanRequest(mode="full", subject="数学", date_range="7d"))

        scanned_page_ids = {page["id"] for page in fake_model.last_state.pages}
        self.assertEqual(scanned_page_ids, {"kp_math_1", "kp_math_2"})

    def test_ai_config_is_excluded_from_serialized_request(self):
        request = OrganizePlanRequest(
            ai_config={"apiKey": "secret", "aiBaseUrl": "http://example/v1", "model": "model"}
        )

        self.assertNotIn("ai_config", request.model_dump())

    def test_real_model_request_is_bounded_and_uses_compact_evidence(self):
        adapter = OpenAICompatibleWikiModelAdapter(
            {"apiKey": "secret", "aiBaseUrl": "http://example/v1", "model": "model"}
        )
        state = agent_state = WikiAgent(self.store).scan_scope(
            OrganizePlanRequest(mode="full", instruction="Review everything")
        )
        state.pages[0]["content"] = "x" * 10_000

        body = adapter.request_body(agent_state)
        user_message = body["messages"][1]["content"]
        evidence = json.loads(user_message.split("<evidence>\n", 1)[1].rsplit("\n</evidence>", 1)[0])

        self.assertLessEqual(body["max_tokens"], 4_000)
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertIn("不要复述证据", user_message)
        self.assertLessEqual(len(evidence["pages"][0]["content"]), adapter.MAX_PAGE_CONTENT_CHARS)
        self.assertIn("最多", body["messages"][0]["content"])
        self.assertIn(str(adapter.MAX_OPERATIONS_PER_RUN), body["messages"][0]["content"])

    async def test_executed_run_updates_incremental_index(self):
        operation = {
            "id": "op-index",
            "tool": "update_fields",
            "reason": "Shorten title",
            "before": {"id": "kp_math_2", "short_title": self.meta2.short_title},
            "after": {"id": "kp_math_2", "short_title": "fraction"},
        }
        agent = WikiAgent(self.store, model=FakeModelAdapter(responses=[[operation]]))
        plan = await agent.plan(OrganizePlanRequest(mode="full"))

        agent.execute_run(plan.run_id, [operation["id"]])

        index_path = self.wiki_dir / ".organize_index.json"
        self.assertTrue(index_path.exists())
        index = json.loads(index_path.read_text(encoding="utf-8"))
        self.assertTrue(index["hashes"])
        next_state = agent.scan_scope(OrganizePlanRequest(mode="incremental"))
        self.assertEqual(next_state.pages, [])

    async def test_current_run_instruction_appears_in_run_log_but_not_in_knowledge_pages(self):
        fake_model = FakeModelAdapter(responses=[[]])
        agent = WikiAgent(self.store, model=fake_model)
        
        instruction = "Make everything clean and neat!"
        request = OrganizePlanRequest(mode="incremental", instruction=instruction)
        plan = await agent.plan(request)
        
        # The instruction should be present in the plan result (run log/request metadata)
        self.assertEqual(plan.instruction, instruction)
        
        # No files in knowledge should contain this instruction
        for p in (self.wiki_dir / "knowledge").rglob("*.md"):
            self.assertNotIn(instruction, p.read_text(encoding="utf-8"))

    async def test_planning_leaves_all_wiki_file_hashes_unchanged(self):
        initial_hashes = self.get_dir_hashes()
        
        fake_model = FakeModelAdapter(responses=[[]])
        agent = WikiAgent(self.store, model=fake_model)
        
        request = OrganizePlanRequest(mode="incremental", instruction="Planning run")
        await agent.plan(request)
        
        final_hashes = self.get_dir_hashes()
        self.assertEqual(initial_hashes, final_hashes)

    async def test_execute_only_selected_operations(self):
        agent = WikiAgent(self.store, model=FakeModelAdapter(responses=[[]]))
        
        # Create a mock OrganizePlan with two operations
        op1 = WikiOperation(
            id="op-1",
            tool="update_fields",
            reason="Update short title of kp_math_1",
            before={"id": "kp_math_1", "short_title": "分数裂项"},
            after={"id": "kp_math_1", "short_title": "裂项新"}
        )
        op2 = WikiOperation(
            id="op-2",
            tool="update_fields",
            reason="Update short title of kp_math_2",
            before={"id": "kp_math_2", "short_title": "分数基础"},
            after={"id": "kp_math_2", "short_title": "基础新"}
        )
        
        plan = OrganizePlan(
            run_id="run_select_test",
            rounds=1,
            operations=[op1, op2],
            source_hashes=self.get_dir_hashes(),
            instruction="Select test"
        )
        
        agent._save_run(plan.run_id, plan, "pending")
        
        # Execute only op-1
        tx_id = agent.execute_run(plan.run_id, ["op-1"])
        
        # Check that kp_math_1 was updated, but kp_math_2 was not
        path1 = self.store.find_page_by_id("kp_math_1")
        meta1, _ = parse_page(path1.read_text(encoding="utf-8"))
        self.assertEqual(meta1["short_title"], "裂项新")
        
        path2 = self.store.find_page_by_id("kp_math_2")
        meta2, _ = parse_page(path2.read_text(encoding="utf-8"))
        self.assertEqual(meta2["short_title"], "分数基础") # unchanged
        
        # Check persisted run state
        run_data = agent.get_run(plan.run_id)
        self.assertEqual(run_data["status"], "executed")
        self.assertEqual(run_data["transaction_id"], tx_id)
        self.assertEqual(run_data["executed_operation_ids"], ["op-1"])

    async def test_execute_rejects_empty_or_unknown_selection(self):
        agent = WikiAgent(self.store, model=FakeModelAdapter(responses=[[]]))
        operation = WikiOperation(
            id="op-known",
            tool="update_fields",
            reason="Update short title",
            before={"id": "kp_math_1"},
            after={"id": "kp_math_1", "short_title": "裂项"},
        )
        plan = OrganizePlan(
            run_id="run_selection_validation",
            rounds=1,
            operations=[operation],
            source_hashes=self.get_dir_hashes(),
        )
        agent._save_run(plan.run_id, plan, "pending")

        with self.assertRaisesRegex(ValueError, "至少选择"):
            agent.execute_run(plan.run_id, [])
        with self.assertRaisesRegex(ValueError, "不存在"):
            agent.execute_run(plan.run_id, ["op-unknown"])

    async def test_reject_stale_plans_if_source_hashes_changed(self):
        agent = WikiAgent(self.store, model=FakeModelAdapter(responses=[[]]))
        
        initial_hashes = self.get_dir_hashes()
        
        op1 = WikiOperation(
            id="op-1",
            tool="update_fields",
            reason="Update short title",
            before={"id": "kp_math_1", "short_title": "分数裂项"},
            after={"id": "kp_math_1", "short_title": "裂项新"}
        )
        
        plan = OrganizePlan(
            run_id="run_stale_test",
            rounds=1,
            operations=[op1],
            source_hashes=initial_hashes,
            instruction="Stale test"
        )
        agent._save_run(plan.run_id, plan, "pending")
        
        # Modify a file to change its hash
        self.meta2.short_title = "已修改分数基础"
        self.store.write_page(
            "knowledge/math/kp_math_2.md",
            render_knowledge_page(self.meta2, {"核心概念": "分子分母同时乘除"})
        )
        
        # Attempting execution should raise ValueError
        with self.assertRaises(ValueError) as ctx:
            agent.execute_run(plan.run_id, ["op-1"])
        self.assertIn("Plan is stale", str(ctx.exception))

    async def test_protected_fields_remain_unchanged(self):
        agent = WikiAgent(self.store, model=FakeModelAdapter(responses=[[]]))
        
        op1 = WikiOperation(
            id="op-1",
            tool="update_fields",
            reason="Attempt to change locked full_title and unlocked short_title",
            before={"id": "kp_math_1", "full_title": "分数裂项相消", "short_title": "分数裂项"},
            after={"id": "kp_math_1", "full_title": "这是锁定的新标题", "short_title": "新短标题"}
        )
        
        plan = OrganizePlan(
            run_id="run_protect_test",
            rounds=1,
            operations=[op1],
            source_hashes=self.get_dir_hashes(),
            instruction="Protect test"
        )
        agent._save_run(plan.run_id, plan, "pending")
        
        with self.assertRaises(ValueError):
            agent.execute_run(plan.run_id, ["op-1"])
        
        # Check kp_math_1 values
        path = self.store.find_page_by_id("kp_math_1")
        meta, _ = parse_page(path.read_text(encoding="utf-8"))
        self.assertEqual(meta["full_title"], "分数裂项相消") # unchanged because locked
        self.assertEqual(meta["short_title"], "分数裂项") # entire invalid operation is rejected

    async def test_commit_writes_snapshot_and_changelog(self):
        agent = WikiAgent(self.store, model=FakeModelAdapter(responses=[[]]))
        
        op1 = WikiOperation(
            id="op-1",
            tool="update_fields",
            reason="Update short title",
            before={"id": "kp_math_1", "short_title": "分数裂项"},
            after={"id": "kp_math_1", "short_title": "裂项新"}
        )
        
        plan = OrganizePlan(
            run_id="run_commit_test",
            rounds=1,
            operations=[op1],
            source_hashes=self.get_dir_hashes(),
            instruction="Commit test"
        )
        agent._save_run(plan.run_id, plan, "pending")
        
        tx_id = agent.execute_run(plan.run_id, ["op-1"])
        
        # Verify snapshot exists
        snapshot_manifest = self.wiki_dir / "snapshots" / tx_id / ".manifest.json"
        self.assertTrue(snapshot_manifest.exists())
        
        # Verify changelog file exists
        changelog_file = self.wiki_dir / "changelog" / f"{tx_id}.md"
        self.assertTrue(changelog_file.exists())

    async def test_failed_operation_rolls_back_entire_transaction(self):
        agent = WikiAgent(self.store, model=FakeModelAdapter(responses=[[]]))
        
        # op-1 is valid, op-2 attempts to modify a non-existent page which raises FileNotFoundError
        op1 = WikiOperation(
            id="op-1",
            tool="update_fields",
            reason="Update short title of kp_math_1",
            before={"id": "kp_math_1", "short_title": "分数裂项"},
            after={"id": "kp_math_1", "short_title": "裂项新"}
        )
        op2 = WikiOperation(
            id="op-2",
            tool="update_fields",
            reason="Attempt non-existent update",
            before={"id": "kp_non_existent", "short_title": "不存在"},
            after={"id": "kp_non_existent", "short_title": "错误"}
        )
        
        plan = OrganizePlan(
            run_id="run_rollback_test",
            rounds=1,
            operations=[op1, op2],
            source_hashes=self.get_dir_hashes(),
            instruction="Rollback test"
        )
        agent._save_run(plan.run_id, plan, "pending")
        
        with self.assertRaises(ValueError):
            agent.execute_run(plan.run_id, ["op-1", "op-2"])
            
        # Check that kp_math_1 was NOT updated (rolled back)
        path = self.store.find_page_by_id("kp_math_1")
        meta, _ = parse_page(path.read_text(encoding="utf-8"))
        self.assertEqual(meta["short_title"], "分数裂项")

    async def test_undo_restores_prior_wiki(self):
        agent = WikiAgent(self.store, model=FakeModelAdapter(responses=[[]]))
        
        op1 = WikiOperation(
            id="op-1",
            tool="update_fields",
            reason="Update short title of kp_math_1",
            before={"id": "kp_math_1", "short_title": "分数裂项"},
            after={"id": "kp_math_1", "short_title": "裂项新"}
        )
        
        plan = OrganizePlan(
            run_id="run_undo_test",
            rounds=1,
            operations=[op1],
            source_hashes=self.get_dir_hashes(),
            instruction="Undo test"
        )
        agent._save_run(plan.run_id, plan, "pending")
        
        agent.execute_run(plan.run_id, ["op-1"])
        
        # Verify it was updated
        path = self.store.find_page_by_id("kp_math_1")
        meta, _ = parse_page(path.read_text(encoding="utf-8"))
        self.assertEqual(meta["short_title"], "裂项新")
        
        # Undo
        agent.undo_run(plan.run_id)
        
        # Verify it is restored
        path = self.store.find_page_by_id("kp_math_1")
        meta, _ = parse_page(path.read_text(encoding="utf-8"))
        self.assertEqual(meta["short_title"], "分数裂项")
        
        # Check run status
        run_data = agent.get_run(plan.run_id)
        self.assertEqual(run_data["status"], "undone")


if __name__ == "__main__":
    unittest.main()
