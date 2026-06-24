from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


def _timestamp() -> str:
    return datetime.now().astimezone().strftime("%Y%m%d_%H%M%S")


class WikiStore:
    def __init__(self, wiki_dir: Path):
        self.wiki_dir = wiki_dir.resolve()
        self.trash_dir = self.wiki_dir / "trash"
        self.snapshots_dir = self.wiki_dir / "snapshots"
        self.changelog_dir = self.wiki_dir / "changelog"

    def resolve(self, relative: str | Path) -> Path:
        candidate = Path(relative)
        if candidate.is_absolute():
            raise ValueError("Wiki paths must be relative.")
        resolved = (self.wiki_dir / candidate).resolve()
        if resolved != self.wiki_dir and self.wiki_dir not in resolved.parents:
            raise ValueError("Wiki path escapes the configured Wiki directory.")
        return resolved

    def _atomic_write_bytes(self, path: Path, content: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    def write_page(self, relative: str, markdown: str) -> Path:
        path = self.resolve(relative)
        self._atomic_write_bytes(path, markdown.encode("utf-8"))
        return path

    def read_page(self, relative: str) -> str:
        return self.resolve(relative).read_text(encoding="utf-8")

    def find_page_by_id(self, page_id: str) -> Path:
        pattern = re.compile(rf'"id"\s*:\s*"{re.escape(page_id)}"')
        for path in self.wiki_dir.rglob("*.md"):
            if self.trash_dir in path.parents or self.snapshots_dir in path.parents or self.changelog_dir in path.parents:
                continue
            if pattern.search(path.read_text(encoding="utf-8")):
                return path
        raise FileNotFoundError(page_id)

    def begin_transaction(self, label: str) -> "WikiTransaction":
        return WikiTransaction(self, label)

    def undo_transaction(self, transaction_id: str) -> str:
        snapshot_dir = self.resolve(Path("snapshots") / transaction_id)
        manifest_path = snapshot_dir / ".manifest.json"
        if not manifest_path.exists():
            raise FileNotFoundError(transaction_id)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for item in reversed(manifest["paths"]):
            relative = item["path"]
            target = self.resolve(relative)
            if item["existed"]:
                snapshot = snapshot_dir / relative
                self._atomic_write_bytes(target, snapshot.read_bytes())
            elif target.is_file():
                target.unlink()
            elif target.is_dir():
                shutil.rmtree(target)
        undo_id = f"undo_{transaction_id}_{uuid.uuid4().hex[:6]}"
        self.write_page(
            f"changelog/{undo_id}.md",
            f"# Wiki 撤销 {transaction_id}\n\n已恢复事务执行前的文件状态。\n",
        )
        return undo_id


class WikiTransaction:
    def __init__(self, store: WikiStore, label: str):
        self.store = store
        self.label = label
        self.id = f"{_timestamp()}_{uuid.uuid4().hex[:8]}"
        self.snapshot_dir = store.snapshots_dir / self.id
        self._snapshots: dict[Path, bytes | None] = {}
        self._finished = False

    def _snapshot(self, path: Path) -> None:
        if path in self._snapshots:
            return
        content = path.read_bytes() if path.exists() else None
        self._snapshots[path] = content
        if content is not None:
            relative = path.relative_to(self.store.wiki_dir)
            snapshot = self.snapshot_dir / relative
            snapshot.parent.mkdir(parents=True, exist_ok=True)
            snapshot.write_bytes(content)

    def write_page(self, relative: str, markdown: str) -> None:
        path = self.store.resolve(relative)
        self._snapshot(path)
        self.store._atomic_write_bytes(path, markdown.encode("utf-8"))

    def move_page(self, source: str, target: str) -> None:
        source_path = self.store.resolve(source)
        target_path = self.store.resolve(target)
        self._snapshot(source_path)
        self._snapshot(target_path)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source_path, target_path)

    def trash_page(self, relative: str) -> str:
        source = self.store.resolve(relative)
        if not source.exists():
            raise FileNotFoundError(relative)
        target_relative = Path("trash") / self.id / Path(relative)
        target = self.store.resolve(target_relative)
        self._snapshot(source)
        self._snapshot(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, target)
        return target_relative.as_posix()

    def commit(self, operations: list[dict[str, Any]]) -> str:
        if self._finished:
            raise RuntimeError("Transaction has already finished.")
        markdown = "\n".join(
            [
                f"# Wiki 事务 {self.id}",
                "",
                f"- 标签：{self.label}",
                f"- 操作数量：{len(operations)}",
                "",
                "## 操作",
                "",
                "```json",
                json.dumps(operations, ensure_ascii=False, indent=2),
                "```",
                "",
            ]
        )
        manifest = {
            "transaction_id": self.id,
            "label": self.label,
            "paths": [
                {
                    "path": path.relative_to(self.store.wiki_dir).as_posix(),
                    "existed": content is not None,
                }
                for path, content in self._snapshots.items()
            ],
        }
        self.snapshot_dir.mkdir(parents=True, exist_ok=True)
        self.store._atomic_write_bytes(
            self.snapshot_dir / ".manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
        )
        self.store.write_page(f"changelog/{self.id}.md", markdown)
        self._finished = True
        return self.id

    def rollback(self) -> None:
        if self._finished:
            raise RuntimeError("Transaction has already finished.")
        for path, content in reversed(list(self._snapshots.items())):
            if content is None:
                if path.is_file():
                    path.unlink()
                elif path.is_dir():
                    shutil.rmtree(path)
            else:
                self.store._atomic_write_bytes(path, content)
        if self.snapshot_dir.exists():
            shutil.rmtree(self.snapshot_dir)
        self._finished = True
