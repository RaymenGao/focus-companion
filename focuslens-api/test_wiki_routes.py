import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from event_store import EventStore
from wiki_ingest import WikiIngestService
from wiki_markdown import parse_page, render_knowledge_page
from wiki_models import IngestDecision, KnowledgePageMeta
from wiki_routes import create_wiki_router
from wiki_store import WikiStore
from wiki_agent import WikiAgent, FakeModelAdapter



class WikiRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.wiki_dir = Path(self.temp.name) / "wiki"
        self.store = WikiStore(self.wiki_dir)
        self.events = EventStore(self.wiki_dir)
        self.ingest = WikiIngestService(self.store, self.events)
        app = FastAPI()
        app.include_router(create_wiki_router(self.store, self.events, self.ingest))
        self.client = TestClient(app)

    def tearDown(self):
        self.temp.cleanup()

    def create_knowledge(self, locked_fields=None):
        meta = KnowledgePageMeta(
            id="kp_math_1",
            subject="数学",
            chapter="数与代数",
            short_title="分数裂项",
            full_title="分数裂项相消",
            locked_fields=set(locked_fields or []),
        )
        self.store.write_page(
            "knowledge/math/a/kp_math_1.md",
            render_knowledge_page(meta, {"核心概念": "原内容"}),
        )
        return meta

    def test_page_patch_respects_locked_fields(self):
        self.create_knowledge(["full_title"])

        response = self.client.patch(
            "/api/wiki/pages/kp_math_1",
            json={"fields": {"full_title": "AI 新标题"}},
        )

        self.assertEqual(response.status_code, 409)
        meta, _ = parse_page(self.store.find_page_by_id("kp_math_1").read_text(encoding="utf-8"))
        self.assertEqual(meta["full_title"], "分数裂项相消")

    def test_page_patch_moves_file_when_subject_or_chapter_changes(self):
        self.create_knowledge()

        response = self.client.patch(
            "/api/wiki/pages/kp_math_1",
            json={"fields": {"chapter": "图形与几何"}},
        )

        self.assertEqual(response.status_code, 200)
        old_path = self.wiki_dir / "knowledge" / "math" / "a" / "kp_math_1.md"
        new_path = self.store.find_page_by_id("kp_math_1")
        self.assertFalse(old_path.exists())
        self.assertEqual(new_path.relative_to(self.wiki_dir).as_posix(), "knowledge/math/chapter-3fccd54ebc/kp_math_1.md")
        meta, _ = parse_page(new_path.read_text(encoding="utf-8"))
        self.assertEqual(meta["chapter"], "图形与几何")

    @patch("wiki_routes.open_local_path")
    def test_open_local_wiki_target_is_limited_to_known_directories(self, opener):
        response = self.client.post("/api/wiki/local/open", json={"target": "knowledge"})

        self.assertEqual(response.status_code, 200)
        self.assertTrue((self.wiki_dir / "knowledge").exists())
        opener.assert_called_once()

        rejected = self.client.post("/api/wiki/local/open", json={"target": "../../"})
        self.assertEqual(rejected.status_code, 400)

    @patch("wiki_routes.open_local_path")
    def test_open_local_wiki_page_opens_resolved_markdown_file(self, opener):
        self.create_knowledge()

        response = self.client.post("/api/wiki/local/open-page", json={"page_id": "kp_math_1"})

        self.assertEqual(response.status_code, 200)
        opened_path = opener.call_args.args[0]
        self.assertEqual(opened_path.name, "kp_math_1.md")
        self.assertTrue(str(opened_path).startswith(str(self.wiki_dir)))

        missing = self.client.post("/api/wiki/local/open-page", json={"page_id": "missing_page"})
        self.assertEqual(missing.status_code, 404)

    def test_delete_moves_page_to_trash_and_undo_restores_it(self):
        self.create_knowledge()

        deleted = self.client.delete("/api/wiki/pages/kp_math_1")
        self.assertEqual(deleted.status_code, 200)
        transaction_id = deleted.json()["transactionId"]
        self.assertFalse(any((self.wiki_dir / "knowledge").rglob("*.md")))
        self.assertTrue(any((self.wiki_dir / "trash").rglob("*.md")))

        undone = self.client.post(f"/api/wiki/transactions/{transaction_id}/undo")
        self.assertEqual(undone.status_code, 200)
        self.assertTrue(any((self.wiki_dir / "knowledge").rglob("*.md")))

    def test_inbox_confirm_ingests_item(self):
        draft = self.events.create_draft(
            interaction_mode="vision",
            original_question="这题怎么做",
            grade="四年级",
        )
        event = self.events.complete(draft.id, {"subject": "数学", "answer_markdown": "步骤"})
        pending = self.ingest.ingest_event(
            event,
            IngestDecision(
                confidence=0.5,
                subject="数学",
                chapter="数与代数",
                short_title="分数裂项",
                full_title="分数裂项相消",
            ),
        )

        response = self.client.post(f"/api/wiki/inbox/{pending.inbox_id}/confirm")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ingested")
        self.assertFalse((self.wiki_dir / "inbox" / f"{pending.inbox_id}.md").exists())
        self.assertEqual(len(list((self.wiki_dir / "knowledge").rglob("*.md"))), 1)

    def test_inbox_rerun_persists_locked_fields(self):
        draft = self.events.create_draft(
            interaction_mode="voice",
            original_question="什么是分数裂项？",
            grade="四年级",
        )
        event = self.events.complete(draft.id, {"subject": "数学", "answer_markdown": "步骤"})
        pending = self.ingest.ingest_event(
            event,
            IngestDecision(
                confidence=0.5,
                subject="数学",
                chapter="数与代数",
                short_title="分数裂项",
                full_title="分数裂项相消",
            ),
        )

        response = self.client.post(
            f"/api/wiki/inbox/{pending.inbox_id}/rerun",
            json={
                "decision": {
                    "confidence": 0.8,
                    "subject": "数学",
                    "chapter": "数与代数",
                    "short_title": "分数裂项",
                    "full_title": "分数裂项相消",
                },
                "locked_fields": ["subject", "chapter"],
            },
        )

        self.assertEqual(response.status_code, 200)
        meta, _ = parse_page(
            (self.wiki_dir / "inbox" / f"{pending.inbox_id}.md").read_text(encoding="utf-8")
        )
        self.assertEqual(meta["locked_fields"], ["chapter", "subject"])


class WikiOrganizeRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.wiki_dir = Path(self.temp.name) / "wiki"
        self.store = WikiStore(self.wiki_dir)
        self.events = EventStore(self.wiki_dir)
        self.ingest = WikiIngestService(self.store, self.events)

        # Create one knowledge page
        self.meta1 = KnowledgePageMeta(
            id="kp_math_1",
            subject="数学",
            chapter="数与代数",
            short_title="分数裂项",
            full_title="分数裂项相消",
            locked_fields={"full_title"},
        )
        self.store.write_page(
            "knowledge/math/kp_math_1.md",
            render_knowledge_page(self.meta1, {"核心概念": "原内容"}),
        )

        self.fake_model = FakeModelAdapter(responses=[[]])
        self.agent = WikiAgent(self.store, model=self.fake_model)
        
        app = FastAPI()
        app.include_router(create_wiki_router(self.store, self.events, self.ingest, agent=self.agent))
        self.client = TestClient(app)

    def tearDown(self):
        self.temp.cleanup()

    def test_plan_route_returns_structured_plan(self):
        valid_op = {
            "id": "op-1",
            "tool": "update_fields",
            "reason": "Update unlocked short_title",
            "before": {"id": "kp_math_1", "short_title": "分数裂项"},
            "after": {"id": "kp_math_1", "short_title": "新裂项"},
        }
        self.fake_model.responses = [[valid_op]]
        self.fake_model.calls = 0

        response = self.client.post(
            "/api/wiki/organize/plan",
            json={"mode": "incremental", "instruction": "Clean up titles"}
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("runId", data)
        self.assertEqual(data["rounds"], 1)
        self.assertEqual(len(data["operations"]), 1)
        self.assertEqual(data["operations"][0]["id"], "op-1")
        self.assertEqual(data["operations"][0]["tool"], "update_fields")
        self.assertEqual(data["estimatedCostUsd"], 0.002)
        self.assertIn("knowledge/math/kp_math_1.md", data["sourceHashes"])
        self.assertEqual(data["instruction"], "Clean up titles")

    def test_plan_route_with_invalid_mode_returns_validation_error(self):
        response = self.client.post(
            "/api/wiki/organize/plan",
            json={"mode": "invalid_mode", "instruction": "Clean up"}
        )
        self.assertEqual(response.status_code, 422)

    def test_execute_route_succeeds_and_modifies_page(self):
        valid_op = {
            "id": "op-1",
            "tool": "update_fields",
            "reason": "Update unlocked short_title",
            "before": {"id": "kp_math_1", "short_title": "分数裂项"},
            "after": {"id": "kp_math_1", "short_title": "新裂项"},
        }
        self.fake_model.responses = [[valid_op]]
        self.fake_model.calls = 0

        # 1. Create the plan
        response = self.client.post(
            "/api/wiki/organize/plan",
            json={"mode": "incremental", "instruction": "Clean up titles"}
        )
        self.assertEqual(response.status_code, 200)
        run_id = response.json()["runId"]

        # 2. Execute the plan
        exec_response = self.client.post(
            "/api/wiki/organize/execute",
            json={"runId": run_id, "operationIds": ["op-1"]}
        )
        self.assertEqual(exec_response.status_code, 200)
        self.assertEqual(exec_response.json()["runId"], run_id)
        self.assertEqual(exec_response.json()["status"], "executed")

        # Verify page was modified
        path = self.store.find_page_by_id("kp_math_1")
        meta, _ = parse_page(path.read_text(encoding="utf-8"))
        self.assertEqual(meta["short_title"], "新裂项")

    def test_undo_route_restores_original_state(self):
        valid_op = {
            "id": "op-1",
            "tool": "update_fields",
            "reason": "Update unlocked short_title",
            "before": {"id": "kp_math_1", "short_title": "分数裂项"},
            "after": {"id": "kp_math_1", "short_title": "新裂项"},
        }
        self.fake_model.responses = [[valid_op]]
        self.fake_model.calls = 0

        # 1. Plan
        response = self.client.post(
            "/api/wiki/organize/plan",
            json={"mode": "incremental", "instruction": "Clean up titles"}
        )
        run_id = response.json()["runId"]

        # 2. Execute
        self.client.post(
            "/api/wiki/organize/execute",
            json={"runId": run_id, "operationIds": ["op-1"]}
        )

        # 3. Undo
        undo_response = self.client.post(
            "/api/wiki/organize/undo",
            json={"runId": run_id}
        )
        self.assertEqual(undo_response.status_code, 200)
        self.assertEqual(undo_response.json()["runId"], run_id)
        self.assertEqual(undo_response.json()["status"], "undone")

        # Verify page was restored
        path = self.store.find_page_by_id("kp_math_1")
        meta, _ = parse_page(path.read_text(encoding="utf-8"))
        self.assertEqual(meta["short_title"], "分数裂项")

    def test_get_run_route_returns_persisted_run(self):
        valid_op = {
            "id": "op-1",
            "tool": "update_fields",
            "reason": "Update unlocked short_title",
            "before": {"id": "kp_math_1", "short_title": "分数裂项"},
            "after": {"id": "kp_math_1", "short_title": "新裂项"},
        }
        self.fake_model.responses = [[valid_op]]
        self.fake_model.calls = 0

        # 1. Plan
        response = self.client.post(
            "/api/wiki/organize/plan",
            json={"mode": "incremental", "instruction": "Clean up titles"}
        )
        run_id = response.json()["runId"]

        # 2. Get Run
        get_response = self.client.get(f"/api/wiki/organize/runs/{run_id}")
        self.assertEqual(get_response.status_code, 200)
        data = get_response.json()
        self.assertEqual(data["plan"]["run_id"], run_id)
        self.assertEqual(data["status"], "pending")


class WikiArtifactRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.wiki_dir = Path(self.temp.name) / "wiki"
        self.store = WikiStore(self.wiki_dir)
        self.events = EventStore(self.wiki_dir)
        self.ingest = WikiIngestService(self.store, self.events)
        self.store.write_page(
            "knowledge/math/kp_1.md",
            """---json
{"id":"kp_1","subject":"数学","chapter":"数与代数","short_title":"分数裂项","full_title":"分数裂项相消求和","evidence_ids":["event_123"]}
---

# 分数裂项相消求和

把相邻项拆开后抵消。
""",
        )
        self.store.write_page(
            "evidence/2026/06/event_123.md",
            """---json
{"id":"event_123","subject":"数学","knowledge_point":"分数裂项"}
---

# 错题证据

学生没有识别出相邻项可以抵消。
""",
        )
        app = FastAPI()
        app.include_router(create_wiki_router(self.store, self.events, self.ingest))
        self.client = TestClient(app)

    def tearDown(self):
        self.temp.cleanup()

    @patch("wiki_artifacts.call_ai_json", new_callable=AsyncMock)
    def test_create_paper_route(self, mock_call):
        mock_call.return_value = {
            "questions": [
                {
                    "prompt_markdown": "计算 [[wiki://kp_1|分数裂项]] 1/(1*2) + 1/(2*3)",
                    "knowledge_ids": ["kp_1"],
                    "evidence_ids": ["event_123"],
                    "steps_markdown": "解析...",
                    "final_answer_markdown": "1/2"
                }
            ]
        }

        response = self.client.post(
            "/api/wiki/papers",
            json={
                "knowledge_ids": ["kp_1"],
                "evidence_ids": ["event_123"],
                "difficulty": "medium",
                "count": 1,
                "ai_config": {"apiKey": "fake", "model": "fake", "aiBaseUrl": "fake"}
            }
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("id", data)
        self.assertTrue(data["paper_path"].endswith("_paper.md"))

        # Verify list and delete
        list_resp = self.client.get("/api/wiki/artifacts")
        self.assertEqual(list_resp.status_code, 200)
        self.assertEqual(len(list_resp.json()), 2) # Paper and Answers are listed as artifacts

        del_resp = self.client.delete(f"/api/wiki/artifacts/{data['id']}")
        self.assertEqual(del_resp.status_code, 200)

        # After delete, list should be empty
        list_resp2 = self.client.get("/api/wiki/artifacts")
        self.assertEqual(len(list_resp2.json()), 0)

    def test_get_artifact_page_returns_readable_link_labels(self):
        self.store.write_page(
            "papers/paper_demo_paper.md",
            """---json
{"id": "paper_demo", "type": "paper", "knowledge_ids": ["kp_1"], "evidence_ids": ["event_123"]}
---

# 练习试卷

相关知识点: [[wiki://kp_1|知识点 kp_1]] | 关联证据: [[evidence://event_123|证据 event_123]]
""",
        )

        response = self.client.get("/api/wiki/pages/v2/paper_demo")

        self.assertEqual(response.status_code, 200)
        markdown = response.json()["markdown"]
        self.assertIn("[[wiki://kp_1|分数裂项]]", markdown)
        self.assertIn("[[evidence://event_123|证据：分数裂项]]", markdown)
        self.assertNotIn("知识点 kp_1", markdown)


if __name__ == "__main__":
    unittest.main()
