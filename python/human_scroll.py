"""
Human-like scrolling behavior for browser automation.

Generates scroll sequences that mimic natural human scrolling patterns:
- Variable scroll distances (not exact amounts)
- Pauses between scrolls (simulating reading time)
- Occasional overshoot corrections (scrolling back up slightly)
- Mix of smooth scrolls and quick jumps
"""

import random
import math
from typing import List, Dict


def random_scroll_distance(base: int = 300) -> int:
    """
    Generate a random scroll distance with natural variance.

    Humans don't scroll exact pixel amounts. This adds realistic variation
    using a normal distribution centered on the base value.

    Args:
        base: The target scroll distance in pixels (default 300)

    Returns:
        Scroll distance in pixels with natural variance (+/- ~30%)
    """
    # Use normal distribution for natural variance
    # Standard deviation of ~20% of base gives realistic spread
    std_dev = base * 0.20
    distance = random.gauss(base, std_dev)

    # Occasionally do a bigger or smaller scroll (outliers)
    if random.random() < 0.15:  # 15% chance of unusual scroll
        if random.random() < 0.5:
            # Quick small scroll (distracted, adjusting)
            distance = base * random.uniform(0.3, 0.5)
        else:
            # Bigger scroll (skimming content)
            distance = base * random.uniform(1.5, 2.0)

    # Ensure minimum scroll and round to integer
    return max(50, int(distance))


def _reading_pause() -> float:
    """
    Generate a pause duration simulating reading time.

    Uses a log-normal distribution which better models human reaction times:
    - Most pauses are short (quick scanning)
    - Occasional longer pauses (reading interesting content)
    - Very rarely extra long pauses (deep reading)

    Returns:
        Pause duration in seconds (typically 0.3 to 2.0 seconds)
    """
    # Log-normal parameters tuned for reading behavior
    # Mean around 0.6s, with occasional longer pauses
    mu = -0.5  # log of median
    sigma = 0.6  # spread

    pause = random.lognormvariate(mu, sigma)

    # Clamp to reasonable range
    return max(0.15, min(pause, 3.0))


def _should_overshoot() -> bool:
    """
    Determine if this scroll should include an overshoot correction.

    Humans sometimes scroll past their target and correct by scrolling back.
    This happens more often during fast scrolling or when distracted.

    Returns:
        True if an overshoot correction should be added
    """
    return random.random() < 0.12  # ~12% of scrolls include overshoot


def _overshoot_amount(scroll_distance: int) -> int:
    """
    Calculate how much to scroll back after an overshoot.

    Args:
        scroll_distance: The original scroll distance

    Returns:
        Pixels to scroll back (negative relative to scroll direction)
    """
    # Overshoot is typically 10-30% of the scroll distance
    overshoot_fraction = random.uniform(0.1, 0.3)
    return int(scroll_distance * overshoot_fraction)


def _is_smooth_scroll() -> bool:
    """
    Determine scroll type: smooth (animated) vs instant jump.

    Most human scrolling is smooth (trackpad, mouse wheel), but occasionally
    people use keyboard shortcuts or click-drag for instant jumps.

    Returns:
        True for smooth scroll, False for instant jump
    """
    return random.random() < 0.85  # 85% smooth, 15% jump


def generate_scroll_sequence(
    page_height: int,
    viewport_height: int,
    target_coverage: float = 0.9
) -> List[Dict]:
    """
    Generate a complete scroll sequence to cover a page naturally.

    Creates a sequence of scroll actions that:
    - Covers the specified portion of the page
    - Uses variable scroll distances
    - Includes natural pauses
    - Occasionally overshoots and corrects
    - Mixes smooth scrolls and jumps

    Args:
        page_height: Total page height in pixels
        viewport_height: Visible viewport height in pixels
        target_coverage: Fraction of page to scroll through (default 0.9)

    Returns:
        List of scroll actions, each containing:
        - scroll_to: Target scroll position in pixels
        - delay_after: Pause duration after scrolling (seconds)
        - smooth: Whether to use smooth scrolling (optional)
        - is_correction: Whether this is an overshoot correction (optional)

    Example:
        >>> sequence = generate_scroll_sequence(5000, 800)
        >>> for action in sequence:
        ...     window.scrollTo(0, action['scroll_to'])
        ...     time.sleep(action['delay_after'])
    """
    if page_height <= viewport_height:
        # Page fits in viewport, no scrolling needed
        return []

    sequence: List[Dict] = []
    current_position = 0
    max_scroll = page_height - viewport_height
    target_position = int(max_scroll * target_coverage)

    # Base scroll distance relative to viewport (typically 30-50% of viewport)
    base_scroll = int(viewport_height * random.uniform(0.30, 0.50))

    # Initial pause - human looks at page before scrolling
    initial_pause = random.uniform(0.5, 1.5)

    # Track direction for overshoot logic
    scrolling_down = True
    consecutive_scrolls = 0

    while current_position < target_position:
        # Determine scroll distance with variance
        scroll_distance = random_scroll_distance(base_scroll)

        # Adjust base scroll occasionally (humans change scrolling pace)
        if random.random() < 0.1:  # 10% chance to change pace
            base_scroll = int(viewport_height * random.uniform(0.25, 0.55))

        # Calculate new position
        new_position = current_position + scroll_distance

        # Don't overshoot the page
        new_position = min(new_position, max_scroll)

        # Determine scroll type
        smooth = _is_smooth_scroll()

        # Generate pause (longer if content is "interesting" - simulate with randomness)
        pause = _reading_pause()

        # Longer pause after several consecutive scrolls (fatigue/deep reading)
        consecutive_scrolls += 1
        if consecutive_scrolls > 3 and random.random() < 0.3:
            pause *= random.uniform(1.5, 2.5)
            consecutive_scrolls = 0

        # Add the scroll action
        sequence.append({
            'scroll_to': new_position,
            'delay_after': pause if sequence else initial_pause + pause,
            'smooth': smooth
        })

        current_position = new_position

        # Handle overshoot correction
        if _should_overshoot() and current_position < max_scroll - 100:
            # First, scroll too far
            overshoot_extra = _overshoot_amount(scroll_distance)
            overshoot_position = min(current_position + overshoot_extra, max_scroll)

            # Quick scroll to overshoot position
            sequence.append({
                'scroll_to': overshoot_position,
                'delay_after': random.uniform(0.1, 0.25),  # Quick pause before correction
                'smooth': True,
                'is_correction': False
            })

            # Correct by scrolling back
            correction_position = overshoot_position - overshoot_extra - random.randint(10, 30)
            correction_position = max(0, correction_position)

            sequence.append({
                'scroll_to': correction_position,
                'delay_after': _reading_pause() * 1.2,  # Slightly longer pause after correction
                'smooth': True,
                'is_correction': True
            })

            current_position = correction_position

        # Occasionally pause longer (got distracted, reading something)
        if random.random() < 0.08:  # 8% chance
            sequence[-1]['delay_after'] += random.uniform(1.0, 2.5)

    # Sometimes scroll to absolute bottom at the end
    if random.random() < 0.3 and current_position < max_scroll:
        sequence.append({
            'scroll_to': max_scroll,
            'delay_after': random.uniform(0.3, 0.8),
            'smooth': True
        })

    return sequence


def generate_lazy_load_sequence(
    page_height: int,
    viewport_height: int,
    check_interval: int = 3
) -> List[Dict]:
    """
    Generate a scroll sequence optimized for triggering lazy-loaded content.

    Similar to regular scrolling but ensures we pause at regular intervals
    to allow content to load. Useful for infinite scroll pages.

    Args:
        page_height: Current known page height
        viewport_height: Visible viewport height
        check_interval: Number of scrolls between load checks

    Returns:
        List of scroll actions (same format as generate_scroll_sequence)
    """
    if page_height <= viewport_height:
        return []

    sequence: List[Dict] = []
    current_position = 0
    max_scroll = page_height - viewport_height

    # Smaller, more consistent scrolls for lazy loading
    base_scroll = int(viewport_height * 0.6)
    scroll_count = 0

    while current_position < max_scroll:
        scroll_distance = random_scroll_distance(base_scroll)
        new_position = min(current_position + scroll_distance, max_scroll)

        scroll_count += 1

        # Longer pause every few scrolls to allow content to load
        if scroll_count % check_interval == 0:
            pause = random.uniform(0.8, 1.5)  # Wait for lazy content
        else:
            pause = random.uniform(0.2, 0.5)  # Quick scroll

        sequence.append({
            'scroll_to': new_position,
            'delay_after': pause,
            'smooth': True
        })

        current_position = new_position

    # Final pause at bottom for any remaining lazy content
    if sequence:
        sequence[-1]['delay_after'] = random.uniform(1.0, 2.0)

    return sequence


def scroll_to_element_sequence(
    current_scroll: int,
    element_position: int,
    viewport_height: int
) -> List[Dict]:
    """
    Generate a scroll sequence to bring an element into view naturally.

    Instead of jumping directly to an element, scroll there in a human-like way.

    Args:
        current_scroll: Current scroll position
        element_position: Target element's Y position on page
        viewport_height: Visible viewport height

    Returns:
        List of scroll actions to reach the element
    """
    # Target scroll position (element at ~30% from top of viewport)
    target_scroll = max(0, element_position - int(viewport_height * 0.3))

    if abs(target_scroll - current_scroll) < 100:
        # Already close enough
        return []

    sequence: List[Dict] = []
    position = current_scroll

    # Determine direction
    going_down = target_scroll > current_scroll
    distance = abs(target_scroll - current_scroll)

    # For short distances, maybe just one scroll
    if distance < viewport_height * 0.5:
        sequence.append({
            'scroll_to': target_scroll,
            'delay_after': random.uniform(0.2, 0.4),
            'smooth': True
        })
        return sequence

    # For longer distances, scroll in chunks
    base_scroll = int(viewport_height * 0.4)

    while abs(target_scroll - position) > 50:
        remaining = abs(target_scroll - position)

        # Slow down as we approach target
        if remaining < viewport_height:
            scroll_distance = random_scroll_distance(int(remaining * 0.6))
        else:
            scroll_distance = random_scroll_distance(base_scroll)

        scroll_distance = min(scroll_distance, remaining)

        if going_down:
            position += scroll_distance
        else:
            position -= scroll_distance

        # Ensure we don't overshoot
        if going_down:
            position = min(position, target_scroll)
        else:
            position = max(position, target_scroll)

        sequence.append({
            'scroll_to': position,
            'delay_after': random.uniform(0.15, 0.35),
            'smooth': True
        })

    # Small final adjustment if needed
    if position != target_scroll:
        sequence.append({
            'scroll_to': target_scroll,
            'delay_after': random.uniform(0.2, 0.4),
            'smooth': True
        })

    return sequence


# Convenience function for simple use cases
def quick_scroll_sequence(
    page_height: int,
    viewport_height: int
) -> List[int]:
    """
    Generate a simple list of scroll positions for basic use cases.

    Returns just the scroll positions without timing information.
    Useful when you want to control timing externally.

    Args:
        page_height: Total page height in pixels
        viewport_height: Visible viewport height in pixels

    Returns:
        List of scroll positions (integers)
    """
    full_sequence = generate_scroll_sequence(page_height, viewport_height)
    return [action['scroll_to'] for action in full_sequence]


if __name__ == '__main__':
    # Demo/test the module
    import json

    print("Human Scroll Module Demo")
    print("=" * 50)

    # Simulate a typical page
    page_height = 5000
    viewport_height = 800

    print(f"\nPage: {page_height}px tall, viewport: {viewport_height}px")
    print("\nGenerated scroll sequence:")
    print("-" * 50)

    sequence = generate_scroll_sequence(page_height, viewport_height)

    total_time = 0
    for i, action in enumerate(sequence):
        total_time += action['delay_after']
        correction = " (correction)" if action.get('is_correction') else ""
        smooth = "smooth" if action.get('smooth', True) else "jump"
        print(f"  {i+1:2d}. Scroll to {action['scroll_to']:4d}px, "
              f"pause {action['delay_after']:.2f}s [{smooth}]{correction}")

    print("-" * 50)
    print(f"Total actions: {len(sequence)}")
    print(f"Estimated time: {total_time:.1f}s")

    print("\n\nRandom scroll distance samples (base=300):")
    samples = [random_scroll_distance(300) for _ in range(10)]
    print(f"  {samples}")
    print(f"  Mean: {sum(samples)/len(samples):.0f}px")
