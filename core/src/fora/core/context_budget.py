from __future__ import annotations

import math

CONTEXT_WINDOW_FALLBACK = 128_000
CONTEXT_WINDOW_RATIO_DEFAULT = 80
CONTEXT_WINDOW_RATIO_MIN = 50
CONTEXT_WINDOW_RATIO_MAX = 95

BYTES_PER_TOKEN = 2.5

IMAGE_TOKENS = 1_500


def window_tokens(declared: int | None = None, override: int | None = None) -> int:
    if type(override) is int and override > 0:
        return override
    if type(declared) is int and declared > 0:
        return declared
    return CONTEXT_WINDOW_FALLBACK


def threshold_tokens(
    declared: int | None = None,
    ratio_percent: int = CONTEXT_WINDOW_RATIO_DEFAULT,
    override: int | None = None,
) -> int:
    ratio = min(max(ratio_percent, CONTEXT_WINDOW_RATIO_MIN), CONTEXT_WINDOW_RATIO_MAX)
    return window_tokens(declared, override) * ratio // 100


def estimate_text_tokens(text: str) -> int:
    if not text:
        return 0
    return math.ceil(len(text.encode("utf-8")) / BYTES_PER_TOKEN)


def estimate_image_tokens(images: int) -> int:
    return images * IMAGE_TOKENS
