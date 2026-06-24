import unittest

from pydantic import ValidationError

from wiki_markdown import parse_page, render_knowledge_page, wiki_link
from wiki_models import KnowledgePageMeta, MasteryState, WikiOperation


class WikiModelTests(unittest.TestCase):
    def test_knowledge_page_requires_stable_id_and_short_title(self):
        meta = KnowledgePageMeta(
            id="kp_math_7f31",
            subject="数学",
            chapter="数与代数",
            short_title="分数裂项",
            full_title="分数裂项相消求和",
        )

        self.assertEqual(meta.mastery_state, MasteryState.PENDING_VERIFICATION)

    def test_operation_rejects_unknown_tool(self):
        with self.assertRaises(ValidationError):
            WikiOperation(
                id="op-1",
                tool="overwrite_filesystem",
                reason="bad",
                before={},
                after={},
            )


class WikiMarkdownTests(unittest.TestCase):
    def test_knowledge_page_round_trip_and_stable_link(self):
        meta = KnowledgePageMeta(
            id="kp_math_7f31",
            subject="数学",
            chapter="数与代数",
            short_title="分数裂项",
            full_title="分数裂项相消求和",
        )

        markdown = render_knowledge_page(meta, {"核心概念": "相邻项相消。"})
        parsed_meta, sections = parse_page(markdown)

        self.assertEqual(parsed_meta["id"], "kp_math_7f31")
        self.assertEqual(sections["核心概念"], "相邻项相消。")
        self.assertEqual(wiki_link(meta.id, meta.short_title), "[[wiki://kp_math_7f31|分数裂项]]")


if __name__ == "__main__":
    unittest.main()
