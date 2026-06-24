import tempfile
import unittest
from pathlib import Path

from parent_control import ParentControlStore, ParentReminderRequest, ParentSettings, ParentStatusRequest


class ParentControlStoreTests(unittest.TestCase):
    def test_status_settings_and_reminders_round_trip(self):
        with tempfile.TemporaryDirectory() as temp:
            store = ParentControlStore(Path(temp) / "parent_state.json")

            state = store.update_status(
                ParentStatusRequest(
                    learningState="DISTRACTED",
                    reason="Looking away",
                    writingActive=False,
                    absent=False,
                    aiBusy=True,
                    activeTab="tutor",
                    lastLearningAt="2026-06-17T20:00:00+08:00",
                )
            )

            self.assertEqual(state.student.learningState, "DISTRACTED")
            self.assertEqual(state.student.activeTab, "tutor")
            self.assertTrue(state.student.updatedAt)

            state = store.update_settings(ParentSettings(aiTeacherMode="disabled", longIdleMinutes=15))
            self.assertEqual(state.settings.aiTeacherMode, "disabled")
            self.assertEqual(state.settings.longIdleMinutes, 15)

            state = store.add_reminder(ParentReminderRequest(type="focus", message="请回到数学题。"))
            self.assertEqual(len(state.reminders), 1)
            self.assertEqual(store.pending_reminders()[0].message, "请回到数学题。")

            state = store.mark_delivered(state.reminders[0].id)
            self.assertTrue(state.reminders[0].delivered)
            self.assertEqual(store.pending_reminders(), [])


if __name__ == "__main__":
    unittest.main()
