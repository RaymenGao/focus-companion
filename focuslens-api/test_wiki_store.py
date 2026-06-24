import tempfile
import unittest
from pathlib import Path

from wiki_store import WikiStore


class WikiStoreTests(unittest.TestCase):
    def test_transaction_can_rollback_and_trash_is_reversible(self):
        with tempfile.TemporaryDirectory() as temp:
            store = WikiStore(Path(temp))
            relative = "knowledge/math/a/kp_math_1.md"
            store.write_page(relative, "# Original")

            tx = store.begin_transaction("organize")
            tx.write_page(relative, "# Changed")
            tx.trash_page(relative)
            tx.rollback()

            self.assertEqual(store.read_page(relative), "# Original")
            self.assertFalse(any(store.trash_dir.rglob("*.md")))

    def test_transaction_commit_writes_changelog_and_keeps_trash(self):
        with tempfile.TemporaryDirectory() as temp:
            store = WikiStore(Path(temp))
            relative = "knowledge/math/a/kp_math_1.md"
            store.write_page(relative, "# Original")

            tx = store.begin_transaction("delete")
            tx.trash_page(relative)
            transaction_id = tx.commit([{"tool": "trash_page", "path": relative}])

            self.assertFalse((store.wiki_dir / relative).exists())
            self.assertTrue(any(store.trash_dir.rglob("*.md")))
            self.assertTrue((store.changelog_dir / f"{transaction_id}.md").exists())

    def test_committed_transaction_can_be_undone(self):
        with tempfile.TemporaryDirectory() as temp:
            store = WikiStore(Path(temp))
            relative = "knowledge/math/a/kp_math_1.md"
            store.write_page(relative, "# Original")
            tx = store.begin_transaction("edit")
            tx.write_page(relative, "# Changed")
            tx.write_page("knowledge/math/a/kp_math_new.md", "# New")
            transaction_id = tx.commit([{"tool": "update_fields", "path": relative}])

            store.undo_transaction(transaction_id)

            self.assertEqual(store.read_page(relative), "# Original")
            self.assertFalse((store.wiki_dir / "knowledge/math/a/kp_math_new.md").exists())

    def test_store_rejects_paths_outside_wiki(self):
        with tempfile.TemporaryDirectory() as temp:
            store = WikiStore(Path(temp))

            with self.assertRaises(ValueError):
                store.write_page("../outside.md", "bad")
            with self.assertRaises(ValueError):
                store.write_page(str(Path(temp).resolve().parent / "outside.md"), "bad")


if __name__ == "__main__":
    unittest.main()
