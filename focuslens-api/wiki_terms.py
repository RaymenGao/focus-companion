from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from wiki_store import WikiStore


LEGACY_TERM_ID = "legacy"
LEGACY_TERM_LABEL = "未分学期"


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _terms_path(store: WikiStore):
    return store.wiki_dir / "terms" / "index.json"


def _slug(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return cleaned[:40] or f"term_{datetime.now().strftime('%Y%m%d')}"


def default_terms() -> dict[str, Any]:
    return {
        "active_term_id": LEGACY_TERM_ID,
        "terms": [
            {
                "id": LEGACY_TERM_ID,
                "label": LEGACY_TERM_LABEL,
                "status": "active",
                "created_at": _now(),
                "archived_at": "",
            }
        ],
    }


def load_terms(store: WikiStore) -> dict[str, Any]:
    path = _terms_path(store)
    if not path.exists():
        data = default_terms()
        save_terms(store, data)
        return data
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = default_terms()
    terms = data.get("terms") if isinstance(data, dict) else None
    if not isinstance(terms, list):
        data = default_terms()
    if not any(item.get("id") == LEGACY_TERM_ID for item in data["terms"]):
        data["terms"].insert(
            0,
            {
                "id": LEGACY_TERM_ID,
                "label": LEGACY_TERM_LABEL,
                "status": "active",
                "created_at": _now(),
                "archived_at": "",
            },
        )
    if not data.get("active_term_id"):
        data["active_term_id"] = LEGACY_TERM_ID
    return data


def save_terms(store: WikiStore, data: dict[str, Any]) -> None:
    path = _terms_path(store)
    path.parent.mkdir(parents=True, exist_ok=True)
    store._atomic_write_bytes(path, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))


def active_term_id(store: WikiStore) -> str:
    return str(load_terms(store).get("active_term_id") or LEGACY_TERM_ID)


def create_term(store: WikiStore, label: str) -> dict[str, Any]:
    data = load_terms(store)
    label = label.strip()
    if not label:
        raise ValueError("学期名称不能为空。")
    existing_ids = {item.get("id") for item in data["terms"]}
    base_id = _slug(label)
    term_id = base_id
    suffix = 2
    while term_id in existing_ids:
        term_id = f"{base_id}_{suffix}"
        suffix += 1
    term = {
        "id": term_id,
        "label": label,
        "status": "active",
        "created_at": _now(),
        "archived_at": "",
    }
    data["terms"].append(term)
    data["active_term_id"] = term_id
    save_terms(store, data)
    return term


def set_active_term(store: WikiStore, term_id: str) -> dict[str, Any]:
    data = load_terms(store)
    if not any(item.get("id") == term_id for item in data["terms"]):
        raise FileNotFoundError(term_id)
    data["active_term_id"] = term_id
    save_terms(store, data)
    return data


def set_term_archived(store: WikiStore, term_id: str, archived: bool) -> dict[str, Any]:
    data = load_terms(store)
    found = False
    for item in data["terms"]:
        if item.get("id") == term_id:
            found = True
            item["status"] = "archived" if archived else "active"
            item["archived_at"] = _now() if archived else ""
            break
    if not found:
        raise FileNotFoundError(term_id)
    if archived and data.get("active_term_id") == term_id:
        data["active_term_id"] = LEGACY_TERM_ID
    save_terms(store, data)
    return data


def term_matches(meta: dict[str, Any], term_id: str = "") -> bool:
    if not term_id or term_id == "all":
        return True
    requested = {item.strip() for item in term_id.split(",") if item.strip()}
    if not requested:
        return True
    return str(meta.get("term_id") or LEGACY_TERM_ID) in requested
