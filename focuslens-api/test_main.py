import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

import main


class MistakeTimestampTests(unittest.TestCase):
    def test_new_mistake_can_build_wiki_path_before_database_flush(self):
        mistake = main.Mistake(id="timestamp-regression")

        path = main.mistake_page_rel(mistake)

        self.assertIsNotNone(mistake.created_at)
        self.assertRegex(path, r"^mistakes/\d{8}_timestam\.md$")

    def test_new_mistake_can_render_markdown_before_database_flush(self):
        mistake = main.Mistake(
            id="markdown-regression",
            subject="数学",
            grade="四年级",
            knowledge_point="分数",
            mistake_reason="待分析",
            mastery=0,
            question_text="1/2 + 1/3",
            student_question="这题怎么做？",
            answer_markdown="先通分。",
            correct_answer_markdown="5/6",
            chapter="数与运算",
            prerequisites_json="[]",
        )

        markdown = main.mistake_markdown(mistake)

        self.assertIn("# 错题 ", markdown)
        self.assertIn("分数", markdown)

    def test_mistake_wiki_summary_uses_metadata_instead_of_question_prefix(self):
        with tempfile.TemporaryDirectory() as temp:
            wiki_dir = Path(temp)
            mistake_dir = wiki_dir / "mistakes"
            mistake_dir.mkdir(parents=True)
            (mistake_dir / "20260613_example.md").write_text(
                "# A very long question prefix that should not become the UI title\n\n"
                "- 学科：数学\n"
                "- 章节：分数运算\n"
                "- 知识点：分数裂项相消\n",
                encoding="utf-8",
            )

            with patch.object(main, "WIKI_DIR", wiki_dir):
                pages = main.build_wiki_pages()

        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0].title, "错题 · 分数裂项相消")
        self.assertEqual(pages[0].subject, "数学")
        self.assertEqual(pages[0].chapter, "分数运算")
        self.assertEqual(pages[0].knowledgePoint, "分数裂项相消")

    def test_graph_mistake_node_does_not_use_question_prefix(self):
        row = main.Mistake(
            id="graph-label",
            subject="数学",
            chapter="数与运算",
            knowledge_point="奇数与偶数",
            question_text="有一个很长很长的题目开头，不应该出现在图谱标题里",
            mastery=20,
        )
        db = SimpleNamespace(scalars=lambda statement: SimpleNamespace(all=lambda: [row]))

        graph = main.build_wiki_graph(db)
        mistake_node = next(node for node in graph.nodes if node.type == "mistake")

        self.assertEqual(mistake_node.label, "错题 · 奇数与偶数")


class KnowledgeStatusTests(unittest.TestCase):
    def test_mastered_knowledge_is_excluded_from_default_review(self):
        with tempfile.TemporaryDirectory() as temp:
            wiki_dir = Path(temp)
            knowledge_dir = wiki_dir / "knowledge"
            knowledge_dir.mkdir(parents=True)
            (knowledge_dir / "数学__分数裂项.md").write_text(
                "# 分数裂项\n\n- 状态：mastered\n- 学科：数学\n",
                encoding="utf-8",
            )
            (knowledge_dir / "英语__音标.md").write_text(
                "# 音标\n\n- 状态：learning\n- 学科：英语\n",
                encoding="utf-8",
            )

            with patch.object(main, "WIKI_DIR", wiki_dir):
                self.assertEqual(main.excluded_review_knowledge(), {"分数裂项"})

    def test_status_update_preserves_markdown_content(self):
        markdown = "# 分数裂项\n\n- 状态：weak\n\n## 核心概念\n\n保留内容"

        updated = main.update_knowledge_status_markdown(markdown, "mastered")

        self.assertEqual(main.read_knowledge_status(updated), "mastered")
        self.assertIn("保留内容", updated)


class TutorResponseParsingTests(unittest.TestCase):
    def test_loose_json_extracts_answer_with_unescaped_english_quotes(self):
        raw = (
            '{"subject":"英语","answer_markdown":"先读句子："In fact, it may be clear."'
            '\\n2. 比较三个选项。","knowledge_point":"副词辨析","mastery":0}'
        )

        parsed = main.parse_json_block(raw)

        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["subject"], "英语")
        self.assertIn("In fact", parsed["answer_markdown"])
        self.assertIn("\n2. 比较", parsed["answer_markdown"])

    def test_valid_json_preserves_answer_markdown(self):
        parsed = main.parse_json_block(
            '{"subject":"英语","answer_markdown":"第一步\\n第二步","knowledge_point":"语法"}'
        )

        self.assertEqual(parsed["answer_markdown"], "第一步\n第二步")


class FollowUpEventTests(unittest.TestCase):
    def test_followup_without_existing_event_is_rejected(self):
        request = SimpleNamespace(eventId="", interactionMode="followup")

        with self.assertRaises(HTTPException) as raised:
            main.create_tutor_event(request)

        self.assertEqual(raised.exception.status_code, 400)

    def test_new_question_cannot_overwrite_existing_event(self):
        request = SimpleNamespace(eventId="event_existing", interactionMode="voice")

        with self.assertRaises(HTTPException) as raised:
            main.create_tutor_event(request)

        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
