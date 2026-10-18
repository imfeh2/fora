from fora.core.context_budget import (
    CONTEXT_WINDOW_FALLBACK,
    IMAGE_TOKENS,
    estimate_image_tokens,
    estimate_text_tokens,
    threshold_tokens,
    window_tokens,
)


def test_threshold_uses_the_declared_window() -> None:
    assert window_tokens(1_000_000) == 1_000_000
    assert threshold_tokens(1_000_000, 80) == 800_000
    assert threshold_tokens(1_000_000, 95) == 950_000


def test_threshold_falls_back_when_the_window_is_unknown() -> None:
    assert window_tokens(None) == CONTEXT_WINDOW_FALLBACK
    assert threshold_tokens(None, 80) == CONTEXT_WINDOW_FALLBACK * 80 // 100
    assert threshold_tokens(0, 80) == CONTEXT_WINDOW_FALLBACK * 80 // 100


def test_override_wins_over_the_declared_window() -> None:
    assert window_tokens(1_000_000, 600_000) == 600_000
    assert threshold_tokens(1_000_000, 80, 600_000) == 480_000
    assert window_tokens(None, 600_000) == 600_000


def test_ratio_is_clamped_to_its_range() -> None:
    assert threshold_tokens(None, 10) == threshold_tokens(None, 50)
    assert threshold_tokens(None, 100) == threshold_tokens(None, 95)


def test_estimates_count_utf8_bytes_and_images_separately() -> None:
    assert estimate_text_tokens("x" * 400) == 160
    assert estimate_text_tokens("中" * 100) == 120
    assert estimate_text_tokens("x" * 200 + "中" * 50) == 140
    assert estimate_text_tokens("") == 0
    assert estimate_image_tokens(2) == IMAGE_TOKENS * 2
