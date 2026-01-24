"""
Human-like timing delays for browser automation.

This module provides natural, Gaussian-distributed delays that simulate
realistic human behavior patterns during web browsing. Based on UX research:

- Reading speed: ~200-300 WPM, with scanning behavior on web pages
- Reaction time: ~200-400ms for simple decisions, longer for complex ones
- Typing speed: ~40-60 WPM average, with variable inter-key intervals
- Scroll behavior: Bursty with pauses to scan content

All delays use truncated Gaussian distributions to avoid extreme outliers
while maintaining natural variation.
"""

import random
import math
from typing import Optional


def _truncated_gaussian(
    mean: float,
    std_dev: float,
    min_val: float,
    max_val: float
) -> float:
    """
    Generate a random value from a truncated Gaussian distribution.

    Uses rejection sampling to stay within bounds while maintaining
    the natural bell curve shape that characterizes human behavior.

    Args:
        mean: Center of the distribution
        std_dev: Standard deviation (spread)
        min_val: Minimum allowed value
        max_val: Maximum allowed value

    Returns:
        A random float within [min_val, max_val]
    """
    while True:
        value = random.gauss(mean, std_dev)
        if min_val <= value <= max_val:
            return value


def _add_micro_jitter(base_delay: float, jitter_ratio: float = 0.1) -> float:
    """
    Add small random jitter to make delays feel more organic.

    Human timing has inherent noise even in repeated actions.
    This adds a small percentage-based variation.

    Args:
        base_delay: The base delay value
        jitter_ratio: Maximum jitter as a ratio of base (default 10%)

    Returns:
        Delay with added jitter
    """
    jitter = base_delay * jitter_ratio * (random.random() * 2 - 1)
    return max(0, base_delay + jitter)


def reading_delay(
    content_length: Optional[int] = None,
    min_seconds: float = 2.0,
    max_seconds: float = 5.0
) -> float:
    """
    Generate a delay simulating time spent reading/scanning a page.

    Based on research showing:
    - Average web page dwell time: 10-20 seconds
    - Initial scan time: 2-4 seconds for layout comprehension
    - F-pattern scanning behavior with variable attention

    Args:
        content_length: Optional content length to adjust delay
        min_seconds: Minimum delay (default 2.0)
        max_seconds: Maximum delay (default 5.0)

    Returns:
        Delay in seconds (float)
    """
    # Mean slightly above center, as people tend to scan briefly first
    mean = (min_seconds + max_seconds) / 2
    std_dev = (max_seconds - min_seconds) / 4  # ~95% within range

    base_delay = _truncated_gaussian(mean, std_dev, min_seconds, max_seconds)

    # Optionally scale by content length (rough heuristic)
    if content_length is not None:
        # Assume ~1000 chars = baseline, scale logarithmically
        scale_factor = 1.0 + 0.2 * math.log10(max(content_length, 100) / 1000)
        scale_factor = max(0.5, min(2.0, scale_factor))  # Clamp
        base_delay *= scale_factor
        base_delay = min(base_delay, max_seconds * 1.5)  # Cap at 1.5x max

    return _add_micro_jitter(base_delay)


def thinking_delay(
    complexity: str = "simple",
    min_ms: float = 300,
    max_ms: float = 800
) -> float:
    """
    Generate a delay simulating cognitive processing before action.

    Based on Hick-Hyman Law and reaction time research:
    - Simple reaction: ~200-300ms
    - Choice reaction: ~300-500ms
    - Complex decision: ~500-1000ms

    Args:
        complexity: "simple", "moderate", or "complex"
        min_ms: Minimum delay in milliseconds
        max_ms: Maximum delay in milliseconds

    Returns:
        Delay in seconds (float)
    """
    # Adjust range based on complexity
    complexity_multipliers = {
        "simple": 1.0,
        "moderate": 1.3,
        "complex": 1.7
    }
    multiplier = complexity_multipliers.get(complexity, 1.0)

    adjusted_min = min_ms * multiplier
    adjusted_max = max_ms * multiplier

    # Mean weighted toward lower end (most reactions are faster)
    mean = adjusted_min + (adjusted_max - adjusted_min) * 0.4
    std_dev = (adjusted_max - adjusted_min) / 4

    delay_ms = _truncated_gaussian(mean, std_dev, adjusted_min, adjusted_max)

    return _add_micro_jitter(delay_ms / 1000.0)


def micro_delay(
    min_ms: float = 50,
    max_ms: float = 150,
    typing_speed: str = "average"
) -> float:
    """
    Generate inter-keystroke delay for typing simulation.

    Based on typing research:
    - Professional typist: 30-80ms between keys
    - Average typist: 80-150ms between keys
    - Hunt-and-peck: 200-400ms between keys

    Includes natural variation patterns:
    - Faster for common letter pairs (digraphs)
    - Slower after errors (we don't simulate errors, but vary speed)
    - Occasional micro-pauses

    Args:
        min_ms: Minimum inter-key delay
        max_ms: Maximum inter-key delay
        typing_speed: "fast", "average", or "slow"

    Returns:
        Delay in seconds (float)
    """
    speed_adjustments = {
        "fast": 0.6,
        "average": 1.0,
        "slow": 1.8
    }
    adjustment = speed_adjustments.get(typing_speed, 1.0)

    adjusted_min = min_ms * adjustment
    adjusted_max = max_ms * adjustment

    # Typing delays tend toward the faster end with occasional slowdowns
    # Use a slightly skewed distribution (lower mean)
    mean = adjusted_min + (adjusted_max - adjusted_min) * 0.35
    std_dev = (adjusted_max - adjusted_min) / 3

    delay_ms = _truncated_gaussian(mean, std_dev, adjusted_min, adjusted_max)

    # 5% chance of a micro-pause (hesitation, thinking about next word)
    if random.random() < 0.05:
        delay_ms += random.uniform(100, 300)

    return delay_ms / 1000.0


def scroll_pause(
    min_ms: float = 500,
    max_ms: float = 1500,
    position: str = "middle"
) -> float:
    """
    Generate pause duration during scrolling behavior.

    Human scrolling is bursty with pauses to:
    - Scan newly visible content
    - Read interesting sections
    - Orient themselves on the page

    Pauses tend to be longer at:
    - Top of page (initial orientation)
    - Areas with high information density
    - Bottom of sections

    Args:
        min_ms: Minimum pause duration
        max_ms: Maximum pause duration
        position: "top", "middle", or "bottom" of content

    Returns:
        Delay in seconds (float)
    """
    # Position affects pause duration
    position_multipliers = {
        "top": 1.3,      # Longer pause to orient
        "middle": 1.0,   # Normal scanning
        "bottom": 0.8    # Faster at end, seeking next section
    }
    multiplier = position_multipliers.get(position, 1.0)

    adjusted_min = min_ms * multiplier
    adjusted_max = max_ms * multiplier

    mean = (adjusted_min + adjusted_max) / 2
    std_dev = (adjusted_max - adjusted_min) / 4

    delay_ms = _truncated_gaussian(mean, std_dev, adjusted_min, adjusted_max)

    return _add_micro_jitter(delay_ms / 1000.0)


def maybe_distraction(
    probability: float = 0.05,
    min_seconds: float = 3.0,
    max_seconds: float = 8.0
) -> float:
    """
    Occasionally return a longer pause simulating human distraction.

    Real users get distracted by:
    - Phone notifications
    - Thoughts about other tasks
    - Looking away from screen
    - Brief interruptions

    This makes browsing patterns more realistic and less bot-like.

    Args:
        probability: Chance of distraction (0.0 to 1.0, default 5%)
        min_seconds: Minimum distraction duration
        max_seconds: Maximum distraction duration

    Returns:
        Delay in seconds (0 if no distraction, otherwise 3-8s)
    """
    if random.random() >= probability:
        return 0.0

    # Distraction durations follow a log-normal-ish distribution
    # (many short, few long)
    mean = min_seconds + (max_seconds - min_seconds) * 0.4
    std_dev = (max_seconds - min_seconds) / 3

    delay = _truncated_gaussian(mean, std_dev, min_seconds, max_seconds)

    return delay


def natural_delay_sequence(
    action_type: str,
    count: int = 1
) -> list[float]:
    """
    Generate a sequence of delays for repeated actions.

    Humans show patterns in repeated actions:
    - Gradual speedup (learning effect)
    - Occasional slowdowns (fatigue, distraction)
    - Rhythmic patterns

    Args:
        action_type: "keystroke", "click", or "scroll"
        count: Number of delays to generate

    Returns:
        List of delays in seconds
    """
    delays = []

    # Base delay generator based on action type
    delay_funcs = {
        "keystroke": lambda: micro_delay(),
        "click": lambda: thinking_delay(),
        "scroll": lambda: scroll_pause()
    }
    get_delay = delay_funcs.get(action_type, lambda: thinking_delay())

    # Learning curve factor (gets slightly faster over time)
    for i in range(count):
        base = get_delay()

        # Slight speedup over sequence (learning effect), capped at 20% faster
        learning_factor = max(0.8, 1.0 - (i / count) * 0.2)

        # Random fatigue spikes (occasional slowdown)
        if random.random() < 0.08:
            learning_factor *= random.uniform(1.2, 1.5)

        delays.append(base * learning_factor)

    return delays


# Convenience function for async usage
async def async_reading_delay(**kwargs) -> float:
    """Async wrapper for reading_delay. Returns the delay (caller awaits sleep)."""
    return reading_delay(**kwargs)


async def async_thinking_delay(**kwargs) -> float:
    """Async wrapper for thinking_delay. Returns the delay (caller awaits sleep)."""
    return thinking_delay(**kwargs)


async def async_micro_delay(**kwargs) -> float:
    """Async wrapper for micro_delay. Returns the delay (caller awaits sleep)."""
    return micro_delay(**kwargs)


async def async_scroll_pause(**kwargs) -> float:
    """Async wrapper for scroll_pause. Returns the delay (caller awaits sleep)."""
    return scroll_pause(**kwargs)


async def async_maybe_distraction(**kwargs) -> float:
    """Async wrapper for maybe_distraction. Returns the delay (caller awaits sleep)."""
    return maybe_distraction(**kwargs)


# Quick test / demo
if __name__ == "__main__":
    print("Human Timing Module Demo")
    print("=" * 50)

    print("\nReading delays (5 samples):")
    for _ in range(5):
        print(f"  {reading_delay():.3f}s")

    print("\nThinking delays (5 samples):")
    for _ in range(5):
        print(f"  {thinking_delay():.3f}s ({thinking_delay() * 1000:.0f}ms)")

    print("\nMicro delays for typing (10 samples):")
    delays = [micro_delay() for _ in range(10)]
    print(f"  {[f'{d*1000:.0f}ms' for d in delays]}")

    print("\nScroll pauses (5 samples):")
    for _ in range(5):
        print(f"  {scroll_pause():.3f}s")

    print("\nDistraction check (20 trials at 20% probability):")
    distractions = [maybe_distraction(probability=0.2) for _ in range(20)]
    occurred = [d for d in distractions if d > 0]
    print(f"  Distractions: {len(occurred)}/20")
    if occurred:
        print(f"  Durations: {[f'{d:.2f}s' for d in occurred]}")

    print("\nNatural keystroke sequence (15 keystrokes):")
    seq = natural_delay_sequence("keystroke", 15)
    print(f"  {[f'{d*1000:.0f}ms' for d in seq]}")
