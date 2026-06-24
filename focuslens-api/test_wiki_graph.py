import tempfile
import unittest
from pathlib import Path

from wiki_graph import WikiGraphService
from wiki_markdown import render_knowledge_page
from wiki_models import KnowledgePageMeta, MasteryState
from wiki_store import WikiStore


class WikiGraphTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = WikiStore(Path(self.temp.name) / "wiki")
        self.graph = WikiGraphService(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def add_knowledge(
        self,
        page_id: str,
        subject: str,
        chapter: str,
        short_title: str,
        full_title: str,
        state: MasteryState,
        evidence_ids=None,
        prerequisites=None,
    ):
        meta = KnowledgePageMeta(
            id=page_id,
            subject=subject,
            chapter=chapter,
            short_title=short_title,
            full_title=full_title,
            mastery_state=state,
            evidence_ids=evidence_ids or [],
            prerequisites=prerequisites or [],
        )
        self.store.write_page(
            f"knowledge/{subject}/{chapter}/{page_id}.md",
            render_knowledge_page(meta, {"核心概念": "内容"}),
        )
        for evidence_id in evidence_ids or []:
            self.store.write_page(f"evidence/2026/06/{evidence_id}.md", f"# {evidence_id}")

    def test_weak_graph_excludes_mastered_and_uses_short_titles(self):
        self.add_knowledge(
            "kp_math_weak",
            "数学",
            "数与代数",
            "分数裂项",
            "分数裂项相消求和的完整长标题",
            MasteryState.WEAK,
            ["event_1"],
        )
        self.add_knowledge(
            "kp_math_mastered",
            "数学",
            "数与代数",
            "整数加法",
            "整数加法",
            MasteryState.MASTERED,
        )

        response = self.graph.build("weak")
        knowledge = [node for node in response.nodes if node.type == "knowledge"]

        self.assertEqual({node.id for node in knowledge}, {"kp_math_weak"})
        self.assertEqual(knowledge[0].label, "分数裂项")
        self.assertTrue(knowledge[0].why)
        self.assertTrue(knowledge[0].next_action)
        self.assertTrue({node.type for node in response.nodes} <= {"subject", "chapter", "knowledge", "prerequisite"})

    def test_full_graph_contains_mastered_and_subject_filter_partitions(self):
        self.add_knowledge("kp_math_1", "数学", "数与代数", "分数", "分数", MasteryState.WEAK)
        self.add_knowledge("kp_eng_1", "英语", "语法", "时态", "一般现在时", MasteryState.MASTERED)

        full = self.graph.build("full")
        math = self.graph.build("full", subject="数学")

        self.assertIn("kp_eng_1", {node.id for node in full.nodes})
        self.assertNotIn("英语", {node.subject for node in math.nodes})

    def test_missing_evidence_is_not_counted(self):
        self.add_knowledge(
            "kp_math_1",
            "数学",
            "数与代数",
            "分数",
            "分数",
            MasteryState.WEAK,
            ["event_1"],
        )
        before = next(node for node in self.graph.build("weak").nodes if node.id == "kp_math_1")
        (self.store.wiki_dir / "evidence/2026/06/event_1.md").unlink()
        self.graph.invalidate({"kp_math_1"})
        after = next(node for node in self.graph.build("weak").nodes if node.id == "kp_math_1")

        self.assertEqual(before.evidence_count, 1)
        self.assertEqual(after.evidence_count, 0)


if __name__ == "__main__":
    unittest.main()
