"""
Regression tests for _strip_dashes in backend/action.py.

No network calls; pure-string assertions only.
"""

import pytest

from backend.action import _strip_dashes

EM_DASH = "—"
EN_DASH = "–"


def test_space_bounded_em_dash_becomes_semicolon():
    """A space-em-dash-space sequence must become '; '."""
    result = _strip_dashes(f"Stores are understaffed {EM_DASH} reallocate now")
    assert "; " in result, f"Expected '; ' in output, got: {result!r}"
    assert "Stores are understaffed; reallocate now" == result


def test_output_contains_no_em_or_en_dash(request):
    """After stripping, neither em dash nor en dash should remain."""
    inputs = [
        f"First segment {EM_DASH} second segment",
        f"First segment {EN_DASH} second segment",
        f"Mixed {EM_DASH} and trailing{EN_DASH}end",
        f"Bare{EM_DASH}nodash",
        f"Bare{EN_DASH}nodash",
    ]
    for text in inputs:
        result = _strip_dashes(text)
        assert EM_DASH not in result, f"Em dash still present in: {result!r}"
        assert EN_DASH not in result, f"En dash still present in: {result!r}"


def test_space_bounded_en_dash_becomes_semicolon():
    """A space-en-dash-space sequence must also become '; '."""
    result = _strip_dashes(f"Stores are understaffed {EN_DASH} reallocate now")
    assert "Stores are understaffed; reallocate now" == result


def test_normal_sentence_unchanged():
    """A sentence with no em/en dashes must be returned as-is (modulo strip)."""
    sentence = "Reallocate labor hours from overstaffed stores to the understaffed locations."
    assert _strip_dashes(sentence) == sentence
