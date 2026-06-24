import unittest
import tempfile
import json
from pathlib import Path
from unittest.mock import patch, AsyncMock

from wiki_store import WikiStore
from wiki_models import CreatePaperRequest, CreateFlashcardsRequest, CreateReportRequest
from wiki_artifacts import (
    generate_practice_paper,
    generate_flashcards,
    generate_stage_report,
    list_artifacts,
    delete_artifact,
    archive_flashcard_deck,
    ArtifactValidationError,
    parse_ai_json_content,
)

class WikiArtifactTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.wiki_dir = Path(self.temp_dir.name) / "wiki"
        self.store = WikiStore(self.wiki_dir)
        self.store.write_page(
            "knowledge/math/kp_math_1.md",
            """---json
{"id":"kp_math_1","subject":"数学","chapter":"数与代数","short_title":"分数裂项","full_title":"分数裂项相消求和","evidence_ids":["event_123"]}
---

# 分数裂项相消求和

把相邻项拆开后抵消。
""",
        )
        self.store.write_page(
            "evidence/event_123.md",
            """---json
{"id":"event_123","subject":"数学","knowledge_point":"分数裂项"}
---

# 错题证据

学生没有识别出相邻项可以抵消。
""",
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_parse_ai_json_repairs_unescaped_quotes_inside_flashcard_strings(self):
        raw = '''{
  "flashcards": [
    {
      "front_markdown": "不定代词 everywhere 在句子中通常表达什么含义？",
      "back_markdown": "表达“到处、处处”，常用于描述普遍存在的状态，如 "flowers bloom everywhere"。",
      "knowledge_ids": ["kp_english_61ca536219e0"]
    },
    {
      "front_markdown": "遇到含有最高级的填空题时，解题的第一步应该做什么？",
      "back_markdown": "优先考虑 **anywhere** 来配合最高级表示“在任何地方都..."，而不是 somewhere 或 everywhere。",
      "knowledge_ids": ["kp_english_15001949ee29"]
    }
  ]
}'''

        parsed = parse_ai_json_content(raw)

        self.assertEqual(len(parsed["flashcards"]), 2)
        self.assertIn('"flowers bloom everywhere"', parsed["flashcards"][0]["back_markdown"])
        self.assertIn('都..."，而不是', parsed["flashcards"][1]["back_markdown"])

    @patch("wiki_artifacts.call_ai_json", new_callable=AsyncMock)
    async def test_valid_paper_request_creates_separate_files(self, mock_call):
        # Setup mock AI response
        mock_call.return_value = {
            "questions": [
                {
                    "prompt_markdown": "根据 [[wiki://kp_math_1|分数裂项]]，计算 1/(1*2) + 1/(2*3)",
                    "knowledge_ids": ["kp_math_1"],
                    "evidence_ids": ["event_123"],
                    "steps_markdown": "将各项拆开为 1/n - 1/(n+1) 后相消",
                    "final_answer_markdown": "1/2"
                }
            ]
        }

        req = CreatePaperRequest(
            knowledge_ids=["kp_math_1"],
            evidence_ids=["event_123"],
            difficulty="medium",
            count=1,
            ai_config={"apiKey": "fake", "model": "fake", "aiBaseUrl": "fake"}
        )

        res = await generate_practice_paper(self.store, req)
        
        # Verify return structure
        self.assertIn("id", res)
        self.assertTrue(res["paper_path"].endswith("_paper.md"))
        self.assertTrue(res["answers_path"].endswith("_answers.md"))

        # Verify files exist
        paper_file = self.wiki_dir / res["paper_path"]
        answers_file = self.wiki_dir / res["answers_path"]
        self.assertTrue(paper_file.exists())
        self.assertTrue(answers_file.exists())

        # Check content includes stable links
        paper_content = paper_file.read_text(encoding="utf-8")
        self.assertIn("[[wiki://kp_math_1|分数裂项]]", paper_content)
        self.assertIn("[[evidence://event_123|证据：分数裂项]]", paper_content)

    @patch("wiki_artifacts.call_ai_json", new_callable=AsyncMock)
    async def test_flashcard_with_invalid_back_fails(self, mock_call):
        mock_call.return_value = {
            "flashcards": [
                {
                    "front_markdown": "关于 [[wiki://kp_math_1|分数裂项]]",
                    "back_markdown": "回顾相关错因，以后注意", # 11 chars
                    "knowledge_ids": ["kp_math_1"]
                }
            ]
        }

        req = CreateFlashcardsRequest(
            knowledge_ids=["kp_math_1"],
            evidence_ids=["event_123"],
            count=1,
            ai_config={"apiKey": "fake", "model": "fake", "aiBaseUrl": "fake"}
        )

        with self.assertRaises(ArtifactValidationError):
            await generate_flashcards(self.store, req)

        # Verify that no file is written in flashcards directory
        flashcards_dir = self.wiki_dir / "flashcards"
        if flashcards_dir.exists():
            files = list(flashcards_dir.glob("*.md"))
            self.assertEqual(len(files), 0)

    @patch("wiki_artifacts.call_ai_json", new_callable=AsyncMock)
    async def test_report_missing_fields_fails(self, mock_call):
        mock_call.return_value = {
            "overview": "", # empty overview
            "evidence_summary": [], # missing
            "state_changes": [],
            "repeated_reasons": [],
            "review_order": [],
            "next_actions": [] # missing next actions
        }

        req = CreateReportRequest(
            subject="数学",
            date_range="30d",
            ai_config={"apiKey": "fake", "model": "fake", "aiBaseUrl": "fake"}
        )

        with self.assertRaises(ArtifactValidationError):
            await generate_stage_report(self.store, req)

    @patch("wiki_artifacts.call_ai_json", new_callable=AsyncMock)
    async def test_output_containing_thinking_process_fails(self, mock_call):
        mock_call.return_value = {
            "questions": [
                {
                    "prompt_markdown": "Thinking Process: The student needs help... Question content here",
                    "knowledge_ids": ["kp_math_1"],
                    "evidence_ids": ["event_123"],
                    "steps_markdown": "Steps...",
                    "final_answer_markdown": "Answer"
                }
            ]
        }

        req = CreatePaperRequest(
            knowledge_ids=["kp_math_1"],
            evidence_ids=["event_123"],
            difficulty="medium",
            count=1,
            ai_config={"apiKey": "fake", "model": "fake", "aiBaseUrl": "fake"}
        )

        with self.assertRaises(ArtifactValidationError):
            await generate_practice_paper(self.store, req)

        # Verify no files left behind
        papers_dir = self.wiki_dir / "papers"
        if papers_dir.exists():
            files = list(papers_dir.glob("*.md"))
            self.assertEqual(len(files), 0)

    @patch("wiki_artifacts.call_ai_json", new_callable=AsyncMock)
    async def test_generation_reads_local_knowledge_and_evidence(self, mock_call):
        mock_call.return_value = {
            "questions": [
                {
                    "prompt_markdown": "请计算一道分数裂项题。",
                    "knowledge_ids": [],
                    "evidence_ids": [],
                    "steps_markdown": "先拆项，再相消。",
                    "final_answer_markdown": "结果为二分之一。",
                }
            ]
        }
        req = CreatePaperRequest(
            knowledge_ids=["kp_math_1"],
            difficulty="medium",
            count=1,
            ai_config={"apiKey": "fake", "model": "fake", "aiBaseUrl": "fake"},
        )

        result = await generate_practice_paper(self.store, req)

        prompt = mock_call.await_args.args[1]
        self.assertIn("把相邻项拆开后抵消", prompt)
        self.assertIn("学生没有识别出相邻项可以抵消", prompt)
        self.assertIn("event_123", result["questions"][0]["evidence_ids"])

    @patch("wiki_artifacts.call_ai_json", new_callable=AsyncMock)
    async def test_list_and_delete_and_archive_flashcards(self, mock_call):
        # 1. Create a flashcard deck
        mock_call.return_value = {
            "flashcards": [
                {
                    "front_markdown": "问题：什么是裂项相消的技巧？",
                    "back_markdown": "解答：将每一项拆分为两项差的形式以进行抵消。",
                    "knowledge_ids": ["kp_math_1"]
                }
            ]
        }

        req = CreateFlashcardsRequest(
            knowledge_ids=["kp_math_1"],
            evidence_ids=["event_123"],
            count=1,
            ai_config={"apiKey": "fake", "model": "fake", "aiBaseUrl": "fake"}
        )

        res = await generate_flashcards(self.store, req)
        deck_id = res["id"]

        # List artifacts
        artifacts = list_artifacts(self.store)
        self.assertEqual(len(artifacts), 1)
        self.assertEqual(artifacts[0]["id"], deck_id)
        self.assertEqual(artifacts[0]["type"], "flashcards")
        self.assertFalse(artifacts[0]["meta"]["archived"])

        # Archive it
        archived_meta = archive_flashcard_deck(self.store, deck_id, archived=True)
        self.assertTrue(archived_meta["archived"])

        # Re-list to check
        artifacts = list_artifacts(self.store)
        self.assertTrue(artifacts[0]["meta"]["archived"])

        # Delete it
        delete_artifact(self.store, deck_id)
        artifacts = list_artifacts(self.store)
        self.assertEqual(len(artifacts), 0)
