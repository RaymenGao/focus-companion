import json
import re
from typing import Any

from wiki_models import KnowledgePageMeta


KNOWLEDGE_SECTIONS = [
    "核心概念",
    "常见错因",
    "解题方法",
    "前置知识",
    "相关知识",
    "学习证据",
    "掌握验证",
]


def wiki_link(page_id: str, label: str) -> str:
    return f"[[wiki://{page_id}|{label}]]"


def render_knowledge_page(meta: KnowledgePageMeta, sections: dict[str, str]) -> str:
    body = [
        "---json",
        meta.model_dump_json(indent=2),
        "---",
        "",
        f"# {meta.full_title}",
        "",
    ]
    for heading in KNOWLEDGE_SECTIONS:
        body.extend([f"## {heading}", "", sections.get(heading, ""), ""])
    return "\n".join(body)


def parse_page(markdown: str) -> tuple[dict[str, Any], dict[str, str]]:
    frontmatter = re.match(r"^---json\r?\n(.*?)\r?\n---\r?\n", markdown, re.S)
    if not frontmatter:
        raise ValueError("Wiki page is missing JSON frontmatter.")
    sections = {
        match.group(1): match.group(2).strip()
        for match in re.finditer(
            r"^## (.+?)\r?\n\r?\n(.*?)(?=^## |\Z)",
            markdown,
            re.M | re.S,
        )
    }
    return json.loads(frontmatter.group(1)), sections
