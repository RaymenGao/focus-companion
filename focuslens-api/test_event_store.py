import base64
import tempfile
import unittest
from pathlib import Path

from event_store import EventStore


class EventStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = EventStore(Path(self.temp.name) / "wiki")

    def tearDown(self):
        self.temp.cleanup()

    def test_event_lifecycle_and_followup_updates_same_markdown(self):
        image = "data:image/jpeg;base64," + base64.b64encode(b"compressed-image").decode()
        draft = self.store.create_draft(interaction_mode="vision", original_question="第33题怎么做", grade="四年级", image_data_url=image)

        complete = self.store.complete(
            draft.id,
            {
                "event_type": "stuck",
                "classification_confidence": 0.9,
                "subject": "数学",
                "chapter": "数与运算",
                "question_text": "计算一道裂项题",
                "answer_markdown": "先尝试裂项。",
                "correct_answer_markdown": "最终答案",
                "knowledge_point": "分数裂项",
                "mistake_reason": "不会裂项",
                "mastery": 10,
            },
        )
        followed = self.store.append_follow_up(draft.id, "为什么要裂项", "为了让相邻项相消。")
        revealed = self.store.reveal_answer(draft.id)
        archived = self.store.archive(draft.id)

        self.assertEqual(complete.write_status, "complete")
        self.assertEqual(followed.id, draft.id)
        self.assertEqual(len(followed.follow_ups), 1)
        self.assertEqual(followed.knowledge_suggestions, complete.knowledge_suggestions)
        self.assertEqual(len(self.store.list()), 1)
        self.assertTrue(revealed.answer_revealed)
        self.assertEqual(archived.write_status, "archived")
        self.assertTrue((self.store.wiki_dir / revealed.question_image).exists())
        self.assertEqual(len(self.store.list()), 1)

    def test_ingested_event_moves_to_evidence_without_losing_followups(self):
        draft = self.store.create_draft(
            interaction_mode="vision",
            original_question="第33题怎么做",
            grade="四年级",
        )
        self.store.complete(
            draft.id,
            {
                "subject": "数学",
                "answer_markdown": "先尝试裂项。",
                "knowledge_point": "分数裂项",
            },
        )
        self.store.append_follow_up(draft.id, "为什么要裂项", "为了让相邻项相消。")

        archived = self.store.archive_as_evidence(draft.id, ["kp_math_7f31"])

        self.assertEqual(archived.write_status, "archived")
        self.assertEqual(archived.related_knowledge, ["kp_math_7f31"])
        self.assertEqual(len(archived.follow_ups), 1)
        self.assertIn("evidence", self.store._find_path(draft.id).parts)
        self.assertEqual(len(self.store.list()), 1)

    def test_followup_can_update_archived_evidence(self):
        draft = self.store.create_draft(
            interaction_mode="voice",
            original_question="单词怎么拼",
            grade="四年级",
        )
        self.store.complete(draft.id, {"subject": "英语", "answer_markdown": "先听音节。"})
        self.store.archive_as_evidence(draft.id, ["kp_english_spelling"])

        updated = self.store.append_follow_up(draft.id, "第二个音节呢", "第二个音节读作 ing。")

        self.assertEqual(len(updated.follow_ups), 1)
        self.assertIn("evidence", self.store._find_path(draft.id).parts)


if __name__ == "__main__":
    unittest.main()
