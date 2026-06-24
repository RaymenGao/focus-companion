import tempfile
import unittest
from pathlib import Path

from event_store import EventStore
from wiki_ingest import WikiIngestService
from wiki_markdown import parse_page, render_knowledge_page
from wiki_models import IngestDecision, KnowledgePageMeta
from wiki_store import WikiStore


class WikiIngestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.wiki_dir = Path(self.temp.name) / "wiki"
        self.events = EventStore(self.wiki_dir)
        self.store = WikiStore(self.wiki_dir)
        self.service = WikiIngestService(self.store, self.events)

    def tearDown(self):
        self.temp.cleanup()

    def create_event(self, subject="数学"):
        draft = self.events.create_draft(
            interaction_mode="vision",
            original_question="这题怎么做",
            grade="四年级",
        )
        return self.events.complete(
            draft.id,
            {
                "subject": subject,
                "answer_markdown": "先分析条件。",
                "knowledge_point": "分数裂项",
            },
        )

    def decision(self, **overrides):
        values = {
            "confidence": 0.95,
            "subject": "数学",
            "chapter": "数与代数",
            "short_title": "分数裂项",
            "full_title": "分数裂项相消求和",
        }
        values.update(overrides)
        return IngestDecision(**values)

    def test_followup_updates_existing_knowledge_instead_of_creating_duplicate(self):
        first = self.create_event()
        result = self.service.ingest_event(first, self.decision())
        self.events.append_follow_up(first.id, "为什么裂项", "为了相消。")

        second = self.events.get(first.id)
        self.service.ingest_event(
            second,
            self.decision(existing_page_id=result.page_id, independent_concept=False),
        )

        pages = list((self.wiki_dir / "knowledge").rglob("*.md"))
        meta, _ = parse_page(pages[0].read_text(encoding="utf-8"))
        self.assertEqual(len(pages), 1)
        self.assertEqual(meta["evidence_ids"], [first.id])

    def test_high_confidence_new_subject_is_created(self):
        event = self.create_event(subject="科学")

        result = self.service.ingest_event(
            event,
            self.decision(subject="科学", chapter="物质", short_title="密度", full_title="物质的密度"),
        )

        self.assertEqual(result.status, "ingested")
        self.assertTrue((self.wiki_dir / "subjects" / "science" / "index.md").exists())

    def test_low_confidence_classification_goes_to_inbox(self):
        event = self.create_event()

        result = self.service.ingest_event(event, self.decision(confidence=0.55))

        self.assertEqual(result.status, "pending")
        self.assertFalse(any((self.wiki_dir / "knowledge").rglob("*.md")))
        self.assertEqual(len(list((self.wiki_dir / "inbox").glob("pending_*.md"))), 1)

    def test_manual_and_locked_fields_are_not_overwritten(self):
        event = self.create_event()
        meta = KnowledgePageMeta(
            id="kp_math_locked",
            subject="数学",
            chapter="人工章节",
            short_title="分数裂项",
            full_title="人工完整标题",
            manual_fields={"chapter"},
            locked_fields={"full_title"},
        )
        self.store.write_page(
            "knowledge/math/manual/kp_math_locked.md",
            render_knowledge_page(meta, {"核心概念": "已有内容"}),
        )

        self.service.ingest_event(
            event,
            self.decision(
                existing_page_id=meta.id,
                chapter="AI 章节",
                full_title="AI 完整标题",
            ),
        )

        updated, _ = parse_page(self.store.find_page_by_id(meta.id).read_text(encoding="utf-8"))
        self.assertEqual(updated["chapter"], "人工章节")
        self.assertEqual(updated["full_title"], "人工完整标题")

    def test_existing_match_merges_only_with_high_confidence(self):
        first = self.create_event()
        created = self.service.ingest_event(first, self.decision())
        second = self.create_event()

        pending = self.service.ingest_event(
            second,
            self.decision(confidence=0.70, existing_page_id=created.page_id),
        )

        self.assertEqual(pending.status, "pending")
        self.assertEqual(len(list((self.wiki_dir / "knowledge").rglob("*.md"))), 1)


if __name__ == "__main__":
    unittest.main()
