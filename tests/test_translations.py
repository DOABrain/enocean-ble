"""Consistency checks for the integration translations."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

TRANSLATIONS = Path(__file__).parent.parent / "custom_components" / "enocean_ble" / "translations"
OEM_NOTICE = (
    "Some OEM modules are restricted to manufacturer-specific commissioning methods. "
    "Manual and/or QR commissioning may be unavailable depending on the module and firmware."
)


def _keys(node: Any, prefix: str = "") -> set[str]:
    if not isinstance(node, dict):
        return {prefix}
    keys: set[str] = set()
    for key, value in node.items():
        keys |= _keys(value, f"{prefix}.{key}" if prefix else key)
    return keys


def _load(lang: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((TRANSLATIONS / f"{lang}.json").read_text(encoding="utf-8"))
    return data


@pytest.mark.parametrize("path", sorted(TRANSLATIONS.glob("*.json")), ids=lambda p: p.stem)
def test_same_keys_as_english(path: Path) -> None:
    assert _keys(_load(path.stem)) == _keys(_load("en"))


@pytest.mark.parametrize("path", sorted(TRANSLATIONS.glob("*.json")), ids=lambda p: p.stem)
def test_add_step_links_to_the_commissioning_page(path: Path) -> None:
    description = _load(path.stem)["config"]["progress"]["open_commissioning_page"]
    for placeholder in ("{mac}", "{page_url}"):
        assert placeholder in description


def test_add_page_oem_notice_wording() -> None:
    script = (TRANSLATIONS.parent / "frontend" / "enocean-ble-scan-panel.js").read_text(encoding="utf-8")
    assert " ".join(OEM_NOTICE.split()) in " ".join(script.split())


@pytest.mark.parametrize("path", sorted(TRANSLATIONS.glob("*.json")), ids=lambda p: p.stem)
def test_progress_step_titles_have_no_placeholders(path: Path) -> None:
    """HA renders a progress step title without placeholders (formatjs MISSING_VALUE)."""
    steps = _load(path.stem)["config"]["step"]
    for step_id in ("bluetooth_method", "commissioning"):
        assert "{" not in steps[step_id]["title"]
