import tempfile
import unittest
from pathlib import Path

from wiki_migration import migrate_legacy_wiki
from wiki_ingest import knowledge_id
from wiki_markdown import parse_page, render_knowledge_page
from wiki_models import KnowledgePageMeta
from wiki_store import WikiStore


class WikiMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = WikiStore(Path(self.temp.name) / "wiki")
        self.store.write_page(
            "knowledge/数学__分数裂项相消.md",
            "# 分数裂项相消\n\n## 相关错题\n\n- [旧错题](../mistakes/20260601_demo.md)\n",
        )
        self.store.write_page("mistakes/20260601_demo.md", "# 旧错题\n\n请计算裂项求和。")

    def tearDown(self):
        self.temp.cleanup()

    def test_migration_is_non_destructive_and_idempotent(self):
        first = migrate_legacy_wiki(self.store)
        second = migrate_legacy_wiki(self.store)

        self.assertEqual(first["created_pages"], 1)
        self.assertEqual(first["created_evidence"], 1)
        self.assertEqual(second["created_pages"], 0)
        self.assertTrue(self.store.resolve("knowledge/数学__分数裂项相消.md").exists())
        self.assertTrue(self.store.resolve("evidence/legacy/legacy_20260601_demo.md").exists())
        migrated = list((self.store.wiki_dir / "knowledge").rglob("kp_*.md"))
        self.assertEqual(len(migrated), 1)
        self.assertIn("legacy_20260601_demo", migrated[0].read_text(encoding="utf-8"))

    def test_migration_repairs_existing_empty_structured_page(self):
        page = KnowledgePageMeta(
            id=knowledge_id("数学", "分数裂项相消"),
            subject="数学",
            chapter="待整理",
            short_title="分数裂项相消",
            full_title="分数裂项相消",
        )
        self.store.write_page(
            "knowledge/math/chapter/kp_math_existing.md",
            render_knowledge_page(page, {}),
        )
        legacy = self.store.resolve("knowledge/数学__分数裂项相消.md")
        legacy.write_text(
            "# 分数裂项相消\n\n"
            "- 高频错因：没有识别裂项公式\n"
            "- 可能缺口：分数加减法, 乘法分配律\n\n"
            "## 相关错题\n\n"
            "- [旧错题](../mistakes/20260601_demo.md)\n\n"
            "## 复习路径\n\n1. 先写出裂项公式。\n",
            encoding="utf-8",
        )

        result = migrate_legacy_wiki(self.store)

        self.assertEqual(result["repaired_pages"], 1)
        meta, sections = parse_page(
            self.store.resolve("knowledge/math/chapter/kp_math_existing.md").read_text(encoding="utf-8")
        )
        self.assertEqual(meta["evidence_ids"], ["legacy_20260601_demo"])
        self.assertIn("没有识别裂项公式", sections["常见错因"])
        self.assertIn("分数加减法", sections["前置知识"])
        self.assertIn("先写出裂项公式", sections["解题方法"])
        self.assertIn("legacy_20260601_demo", sections["学习证据"])

    def test_repair_only_does_not_recreate_missing_structured_page(self):
        result = migrate_legacy_wiki(self.store, create_missing=False)

        self.assertEqual(result["created_pages"], 0)
        self.assertEqual(result["repaired_pages"], 0)
        self.assertFalse(any((self.store.wiki_dir / "knowledge").rglob("kp_*.md")))
