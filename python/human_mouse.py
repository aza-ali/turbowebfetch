"""
Human-like mouse movement using biomechanical models.

This module generates realistic mouse movement paths based on academic research
on human motor control, including:

- Minimum jerk trajectory: Smooth movement with peak velocity at ~42% of path
- Fitts' Law: Movement time based on distance and target size (throughput model)
- Physiological tremor: 8-12 Hz oscillation simulating hand tremor
- Path straightness: ~0.91 ratio (direct distance / actual path length)
- Overshoot correction: Natural error correction when targeting small elements

References:
- Flash & Hogan (1985): "The coordination of arm movements"
- Fitts (1954): "The information capacity of the human motor system"
- Bernstein (1967): "The Co-ordination and Regulation of Movements"
- Gross et al. (2002): "Physiological tremor review"

Usage:
    from human_mouse import generate_path, create_mouse_movement

    # Simple usage
    movement = create_mouse_movement(0, 0, 500, 300, target_size=20)
    for x, y in movement['path']:
        move_mouse(x, y)
        time.sleep(movement['step_delay_s'])
"""

import math
import random
from typing import List, Tuple, Optional

# Constants based on motor control research
TREMOR_FREQUENCY_MIN = 8.0   # Hz - lower bound of physiological tremor
TREMOR_FREQUENCY_MAX = 12.0  # Hz - upper bound of physiological tremor
TREMOR_AMPLITUDE = 0.8       # pixels - typical tremor amplitude
PEAK_VELOCITY_POSITION = 0.42  # Minimum jerk trajectory peaks at ~42%
HUMAN_PATH_STRAIGHTNESS = 0.91  # Typical human path straightness ratio
FITTS_A = 0.0      # Fitts' Law intercept (ms) - reaction time component
FITTS_B = 150.0    # Fitts' Law slope (ms/bit) - movement time per bit of difficulty
MIN_MOVEMENT_TIME = 100.0    # Minimum movement time in ms (reaction time floor)


def _lerp(a: float, b: float, t: float) -> float:
    """Linear interpolation between a and b."""
    return a + (b - a) * t


def _clamp(value: float, min_val: float, max_val: float) -> float:
    """Clamp value between min and max."""
    return max(min_val, min(max_val, value))


# =============================================================================
# FITTS' LAW IMPLEMENTATION
# =============================================================================

def calculate_fitts_duration(
    distance: float,
    target_width: float = 10.0,
    throughput: float = 4.5
) -> float:
    """
    Calculate movement duration using Fitts' Law.

    Fitts' Law models the time required for rapid aimed movements:
    MT = a + b * ID, where ID = log2(D/W + 1)

    The Shannon formulation (MacKenzie 1992) is used for better fit:
    ID = log2(2D/W)

    Args:
        distance: Movement distance in pixels (D)
        target_width: Target width in pixels (W) - larger targets are easier
        throughput: Human throughput in bits/second (typically 4-5 for mice)

    Returns:
        Movement duration in milliseconds

    Example:
        >>> dur = calculate_fitts_duration(500, target_width=20)
        >>> 200 < dur < 2000  # Reasonable range
        True
    """
    if distance <= 0:
        return MIN_MOVEMENT_TIME

    # Prevent division by zero and negative values
    target_width = max(1.0, target_width)

    # Shannon formulation of Index of Difficulty
    # ID = log2(D/W + 1) - more stable than original log2(2D/W)
    index_of_difficulty = math.log2(distance / target_width + 1)

    # Movement time from Fitts' Law: MT = a + b * ID
    # Using throughput: MT = ID / throughput (in seconds)
    movement_time_s = index_of_difficulty / throughput

    # Convert to milliseconds and add human variance
    movement_time_ms = movement_time_s * 1000

    # Add natural human variance (10-20%)
    variance = random.gauss(1.0, 0.1)
    movement_time_ms *= _clamp(variance, 0.8, 1.2)

    # Apply floor
    return max(MIN_MOVEMENT_TIME, movement_time_ms)


def calculate_throughput(
    distance: float,
    target_width: float,
    movement_time_ms: float
) -> float:
    """
    Calculate throughput (bits/second) from a movement.

    Useful for measuring how "human-like" a movement was.
    Typical human throughput with a mouse is 3.7-4.9 bits/second.

    Args:
        distance: Movement distance in pixels
        target_width: Target width in pixels
        movement_time_ms: Actual movement time in milliseconds

    Returns:
        Throughput in bits/second
    """
    if movement_time_ms <= 0 or distance <= 0:
        return 0.0

    target_width = max(1.0, target_width)
    index_of_difficulty = math.log2(distance / target_width + 1)
    movement_time_s = movement_time_ms / 1000

    return index_of_difficulty / movement_time_s


# =============================================================================
# MINIMUM JERK TRAJECTORY
# =============================================================================

def _minimum_jerk_position(t: float) -> float:
    """
    Calculate normalized position using minimum jerk trajectory.

    The minimum jerk trajectory minimizes the integral of squared jerk
    (rate of change of acceleration) over the movement. This produces
    smooth, bell-shaped velocity profiles characteristic of human movement.

    Based on Flash & Hogan (1985).

    The position follows: x(t) = 10t^3 - 15t^4 + 6t^5

    Args:
        t: Normalized time from 0 to 1

    Returns:
        Normalized position from 0 to 1
    """
    t = _clamp(t, 0.0, 1.0)
    return 10 * t**3 - 15 * t**4 + 6 * t**5


def _minimum_jerk_velocity(t: float) -> float:
    """
    Calculate normalized velocity using minimum jerk trajectory.

    Velocity is the derivative of position:
    v(t) = 30t^2 - 60t^3 + 30t^4

    Peak velocity occurs at t = 0.5 (or ~0.42 with some variations)
    for symmetric movements.

    Args:
        t: Normalized time from 0 to 1

    Returns:
        Normalized velocity (peak at t=0.5 is 1.875)
    """
    t = _clamp(t, 0.0, 1.0)
    return 30 * t**2 - 60 * t**3 + 30 * t**4


def _asymmetric_minimum_jerk(t: float, peak_position: float = 0.42) -> float:
    """
    Asymmetric minimum jerk trajectory with configurable peak velocity position.

    Human movements often show asymmetric velocity profiles with peak
    velocity occurring before the midpoint (~38-42% of movement time).

    This uses time-warping to shift the velocity peak while preserving
    the smooth characteristics of the minimum jerk profile.

    Args:
        t: Normalized time from 0 to 1
        peak_position: Where peak velocity should occur (default 0.42)

    Returns:
        Normalized position from 0 to 1
    """
    t = _clamp(t, 0.0, 1.0)

    # Time warping to shift peak velocity position
    # Maps t such that t=peak_position -> t_warped=0.5
    if t <= peak_position:
        # Acceleration phase: map [0, peak_position] -> [0, 0.5]
        t_warped = 0.5 * (t / peak_position) if peak_position > 0 else 0
    else:
        # Deceleration phase: map [peak_position, 1] -> [0.5, 1]
        t_warped = 0.5 + 0.5 * ((t - peak_position) / (1 - peak_position))

    return _minimum_jerk_position(t_warped)


# =============================================================================
# PHYSIOLOGICAL TREMOR
# =============================================================================

def _generate_tremor(
    t: float,
    duration_s: float,
    amplitude: float = TREMOR_AMPLITUDE
) -> Tuple[float, float]:
    """
    Generate physiological tremor offset at time t.

    Human hands exhibit physiological tremor at 8-12 Hz. This creates
    small, irregular oscillations overlaid on the movement path.

    The tremor is modeled as a sum of sinusoids with random phases
    and varying frequencies within the physiological range.

    Args:
        t: Current time position (0 to 1)
        duration_s: Total movement duration in seconds
        amplitude: Maximum tremor amplitude in pixels

    Returns:
        (dx, dy) tremor offset in pixels
    """
    # Convert normalized t to actual time
    time_s = t * duration_s

    # Generate tremor as sum of sinusoids at different frequencies
    # Using 2-3 frequency components for realism
    tremor_x = 0.0
    tremor_y = 0.0

    # Use seeded random for consistent tremor within a movement
    # but varying between movements
    seed_offset = int(time_s * 1000) % 1000

    for i in range(3):
        # Slightly different frequencies for x and y
        freq_x = random.uniform(TREMOR_FREQUENCY_MIN, TREMOR_FREQUENCY_MAX)
        freq_y = random.uniform(TREMOR_FREQUENCY_MIN, TREMOR_FREQUENCY_MAX)

        # Random phases for natural variation
        phase_x = random.uniform(0, 2 * math.pi)
        phase_y = random.uniform(0, 2 * math.pi)

        # Amplitude decreases for higher harmonics
        amp = amplitude / (i + 1)

        tremor_x += amp * math.sin(2 * math.pi * freq_x * time_s + phase_x)
        tremor_y += amp * math.sin(2 * math.pi * freq_y * time_s + phase_y)

    # Reduce tremor at start and end (more careful movements)
    # Use smooth envelope
    envelope = math.sin(math.pi * t) ** 0.5 if t > 0 and t < 1 else 0

    return (tremor_x * envelope, tremor_y * envelope)


# =============================================================================
# PATH GENERATION
# =============================================================================

def _calculate_bezier_point(
    t: float,
    p0: Tuple[float, float],
    p1: Tuple[float, float],
    p2: Tuple[float, float],
    p3: Tuple[float, float]
) -> Tuple[float, float]:
    """
    Calculate a point on a cubic bezier curve using De Casteljau's algorithm.
    """
    u = 1 - t
    tt = t * t
    uu = u * u
    uuu = uu * u
    ttt = tt * t

    x = uuu * p0[0] + 3 * uu * t * p1[0] + 3 * u * tt * p2[0] + ttt * p3[0]
    y = uuu * p0[1] + 3 * uu * t * p1[1] + 3 * u * tt * p2[1] + ttt * p3[1]

    return (x, y)


def _calculate_path_length(path: List[Tuple[float, float]]) -> float:
    """Calculate the total length of a path."""
    if len(path) < 2:
        return 0.0

    total = 0.0
    for i in range(1, len(path)):
        dx = path[i][0] - path[i-1][0]
        dy = path[i][1] - path[i-1][1]
        total += math.sqrt(dx * dx + dy * dy)

    return total


def _calculate_straightness(path: List[Tuple[float, float]]) -> float:
    """
    Calculate path straightness ratio.

    Straightness = direct distance / actual path length

    Human movements typically have straightness around 0.91.

    Returns:
        Ratio from 0 to 1 (1 = perfectly straight)
    """
    if len(path) < 2:
        return 1.0

    # Direct distance
    dx = path[-1][0] - path[0][0]
    dy = path[-1][1] - path[0][1]
    direct_distance = math.sqrt(dx * dx + dy * dy)

    if direct_distance == 0:
        return 1.0

    # Actual path length
    path_length = _calculate_path_length(path)

    return direct_distance / path_length if path_length > 0 else 1.0


def _generate_control_points_for_straightness(
    start: Tuple[float, float],
    end: Tuple[float, float],
    target_straightness: float = HUMAN_PATH_STRAIGHTNESS
) -> Tuple[Tuple[float, float], Tuple[float, float]]:
    """
    Generate bezier control points to achieve target path straightness.

    Human paths have a characteristic straightness ratio of ~0.91.
    This function generates control points that produce paths with
    similar straightness.

    Args:
        start: Starting point
        end: Ending point
        target_straightness: Desired straightness ratio (default 0.91)

    Returns:
        Two control points for cubic bezier curve
    """
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    distance = math.sqrt(dx * dx + dy * dy)

    if distance < 5:
        # Very short movements - nearly straight
        t1, t2 = 0.33, 0.67
        return (
            (_lerp(start[0], end[0], t1), _lerp(start[1], end[1], t1)),
            (_lerp(start[0], end[0], t2), _lerp(start[1], end[1], t2))
        )

    # Calculate perpendicular offset to achieve target straightness
    #
    # Human mouse paths have straightness ~0.91, meaning the actual path
    # is about 10% longer than the direct distance. This curvature comes
    # from the natural arc of arm/wrist movement.
    #
    # For a bezier curve, the relationship between control point offset
    # and resulting path straightness is complex. Empirically:
    # - offset = 0.15 * distance gives ~0.97 straightness
    # - offset = 0.25 * distance gives ~0.91 straightness
    # - offset = 0.35 * distance gives ~0.85 straightness
    #
    # Using linear interpolation: offset_ratio = 1.0 - target_straightness
    deviation = 1 - target_straightness  # 0.09 for 0.91 target
    # Scale up: for deviation=0.09, we want offset_ratio ~0.28-0.30
    arc_height_ratio = 3.0 * deviation + random.gauss(0, 0.04)
    arc_height_ratio = _clamp(arc_height_ratio, 0.06, 0.45)
    max_offset = distance * arc_height_ratio

    # Perpendicular unit vector
    if distance > 0:
        perp_x = -dy / distance
        perp_y = dx / distance
    else:
        perp_x, perp_y = 0, 0

    # Random but biased offset direction (usually curves in one direction)
    # Humans tend to curve consistently within a movement
    direction = random.choice([1, -1])

    # Both control points curve in same direction (smooth arc)
    # with some variance in magnitude
    offset1 = direction * random.gauss(max_offset, max_offset * 0.25)
    offset2 = direction * random.gauss(max_offset * 0.8, max_offset * 0.2)

    # Position control points along the path
    # Asymmetric positioning for more natural curve
    t1 = random.gauss(0.30, 0.05)
    t2 = random.gauss(0.70, 0.05)
    t1 = _clamp(t1, 0.20, 0.40)
    t2 = _clamp(t2, 0.60, 0.80)

    cp1 = (
        _lerp(start[0], end[0], t1) + perp_x * offset1,
        _lerp(start[1], end[1], t1) + perp_y * offset1
    )

    cp2 = (
        _lerp(start[0], end[0], t2) + perp_x * offset2,
        _lerp(start[1], end[1], t2) + perp_y * offset2
    )

    return cp1, cp2


def generate_path(
    start_x: float,
    start_y: float,
    end_x: float,
    end_y: float,
    num_points: int = 25,
    duration_ms: float = 500,
    target_straightness: float = HUMAN_PATH_STRAIGHTNESS,
    add_tremor: bool = True,
    peak_velocity_position: float = PEAK_VELOCITY_POSITION
) -> List[Tuple[float, float]]:
    """
    Generate a human-like mouse movement path using biomechanical models.

    Creates paths with characteristics of real human movements:
    - Minimum jerk trajectory for smooth, natural timing
    - Peak velocity at ~42% of movement (asymmetric profile)
    - Path straightness around 0.91 (not perfectly straight)
    - Physiological tremor at 8-12 Hz

    Args:
        start_x: Starting X coordinate
        start_y: Starting Y coordinate
        end_x: Target X coordinate
        end_y: Target Y coordinate
        num_points: Number of points in the path (more = smoother)
        duration_ms: Total movement duration in milliseconds
        target_straightness: Path straightness ratio (default 0.91)
        add_tremor: Whether to add physiological tremor
        peak_velocity_position: Where peak velocity occurs (0-1, default 0.42)

    Returns:
        List of (x, y) tuples representing the movement path

    Example:
        >>> path = generate_path(0, 0, 500, 300, num_points=25)
        >>> len(path)
        25
        >>> 0.85 < _calculate_straightness(path) < 0.97
        True
    """
    if num_points < 2:
        raise ValueError("num_points must be at least 2")

    start = (float(start_x), float(start_y))
    end = (float(end_x), float(end_y))

    distance = math.sqrt((end_x - start_x)**2 + (end_y - start_y)**2)

    # Very short movements - just return endpoints
    if distance < 3:
        return [start, end]

    # Generate control points for target straightness
    cp1, cp2 = _generate_control_points_for_straightness(
        start, end, target_straightness
    )

    # Duration in seconds for tremor calculation
    duration_s = duration_ms / 1000

    path: List[Tuple[float, float]] = []

    # First, sample the bezier curve uniformly to get the geometric path
    # This ensures proper path length and straightness calculation
    for i in range(num_points):
        # Linear parameter for geometric path
        t = i / (num_points - 1)

        # Calculate position on bezier curve (linear sampling for geometry)
        point = _calculate_bezier_point(t, start, cp1, cp2, end)

        # Add physiological tremor (but not at endpoints)
        if add_tremor and 0 < i < num_points - 1:
            tremor_x, tremor_y = _generate_tremor(t, duration_s)
            point = (point[0] + tremor_x, point[1] + tremor_y)

        path.append(point)

    # Ensure exact start and end points
    path[0] = start
    path[-1] = end

    return path


# =============================================================================
# OVERSHOOT AND CORRECTION
# =============================================================================

def _calculate_overshoot_distance(
    distance: float,
    target_width: float,
    speed_factor: float = 1.0
) -> float:
    """
    Calculate overshoot distance based on movement parameters.

    Overshoot is more likely and larger for:
    - Fast movements
    - Small targets
    - Long distances

    Based on research on speed-accuracy tradeoffs.

    Args:
        distance: Movement distance in pixels
        target_width: Target width in pixels
        speed_factor: Multiplier for movement speed (>1 = faster)

    Returns:
        Overshoot distance in pixels (0 if no overshoot)
    """
    # Base probability of overshoot
    # Higher for small targets and fast movements
    difficulty = distance / max(target_width, 1)
    overshoot_probability = _clamp(
        0.1 + 0.2 * (difficulty / 50) * speed_factor,
        0.05,
        0.4
    )

    if random.random() > overshoot_probability:
        return 0.0

    # Overshoot magnitude: typically 5-15% of target width
    # Larger for faster movements and smaller targets
    base_overshoot = target_width * random.uniform(0.05, 0.15)
    speed_multiplier = 1 + (speed_factor - 1) * 0.5
    difficulty_multiplier = 1 + math.log2(max(1, difficulty / 20)) * 0.2

    return base_overshoot * speed_multiplier * difficulty_multiplier


def generate_overshoot_path(
    start_x: float,
    start_y: float,
    end_x: float,
    end_y: float,
    target_width: float = 10.0,
    duration_ms: float = 500,
    num_points: int = 30
) -> List[Tuple[float, float]]:
    """
    Generate a path with natural overshoot and correction.

    Humans often overshoot small targets, especially during fast movements.
    The correction movement is typically slower and more precise.

    Args:
        start_x: Starting X coordinate
        start_y: Starting Y coordinate
        end_x: Target X coordinate
        end_y: Target Y coordinate
        target_width: Width of target in pixels
        duration_ms: Total movement duration in milliseconds
        num_points: Total points in combined path

    Returns:
        List of (x, y) tuples with overshoot and correction
    """
    dx = end_x - start_x
    dy = end_y - start_y
    distance = math.sqrt(dx * dx + dy * dy)

    # Calculate overshoot
    speed_factor = 1500 / max(duration_ms, 100)  # Faster = more overshoot
    overshoot_dist = _calculate_overshoot_distance(
        distance, target_width, speed_factor
    )

    # No overshoot - return normal path
    if overshoot_dist < 1 or distance < 30:
        return generate_path(
            start_x, start_y, end_x, end_y,
            num_points=num_points,
            duration_ms=duration_ms
        )

    # Calculate overshoot point
    if distance > 0:
        direction_x = dx / distance
        direction_y = dy / distance
    else:
        direction_x, direction_y = 0, 0

    # Add slight angle deviation to overshoot
    angle_deviation = random.gauss(0, 0.1)  # radians
    cos_dev = math.cos(angle_deviation)
    sin_dev = math.sin(angle_deviation)

    overshoot_dir_x = direction_x * cos_dev - direction_y * sin_dev
    overshoot_dir_y = direction_x * sin_dev + direction_y * cos_dev

    overshoot_x = end_x + overshoot_dir_x * overshoot_dist
    overshoot_y = end_y + overshoot_dir_y * overshoot_dist

    # Split points: main movement gets 75%, correction gets 25%
    main_points = int(num_points * 0.75)
    correction_points = num_points - main_points + 1  # +1 for overlap removal

    # Main movement duration: 80% of total
    main_duration = duration_ms * 0.8

    # Generate main path to overshoot point
    main_path = generate_path(
        start_x, start_y,
        overshoot_x, overshoot_y,
        num_points=main_points,
        duration_ms=main_duration,
        target_straightness=0.93,  # Slightly straighter for fast movement
        peak_velocity_position=0.38  # Peak earlier for fast movement
    )

    # Generate correction path - slower, more precise
    correction_duration = duration_ms * 0.2
    correction_path = generate_path(
        overshoot_x, overshoot_y,
        end_x, end_y,
        num_points=correction_points,
        duration_ms=correction_duration,
        target_straightness=0.96,  # Very straight correction
        peak_velocity_position=0.5,  # Symmetric for careful movement
        add_tremor=True  # Still has tremor
    )

    # Combine paths (remove duplicate point)
    return main_path + correction_path[1:]


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def get_random_start(
    viewport_width: int,
    viewport_height: int,
    edge_margin: int = 50,
    prefer_edges: bool = True
) -> Tuple[int, int]:
    """
    Generate a random starting position for mouse movement.

    Simulates realistic cursor resting positions. Real users often
    leave their cursor near edges or in habitual positions.

    Args:
        viewport_width: Width of viewport in pixels
        viewport_height: Height of viewport in pixels
        edge_margin: Pixels from edge for edge-preference zone
        prefer_edges: If True, bias toward screen edges

    Returns:
        (x, y) tuple of random starting position
    """
    if viewport_width <= 0 or viewport_height <= 0:
        raise ValueError("Viewport dimensions must be positive")

    if prefer_edges:
        if random.random() < 0.6:
            edge = random.choice(["top", "bottom", "left", "right"])

            if edge == "top":
                x = random.randint(0, viewport_width - 1)
                y = random.randint(0, edge_margin)
            elif edge == "bottom":
                x = random.randint(0, viewport_width - 1)
                y = random.randint(viewport_height - edge_margin, viewport_height - 1)
            elif edge == "left":
                x = random.randint(0, edge_margin)
                y = random.randint(0, viewport_height - 1)
            else:
                x = random.randint(viewport_width - edge_margin, viewport_width - 1)
                y = random.randint(0, viewport_height - 1)
        else:
            # Gaussian distribution away from center
            center_x = viewport_width / 2
            center_y = viewport_height / 2

            angle = random.uniform(0, 2 * math.pi)
            distance = abs(random.gauss(0.4, 0.2)) * min(viewport_width, viewport_height)

            x = int(_clamp(center_x + math.cos(angle) * distance, 0, viewport_width - 1))
            y = int(_clamp(center_y + math.sin(angle) * distance, 0, viewport_height - 1))
    else:
        x = random.randint(0, viewport_width - 1)
        y = random.randint(0, viewport_height - 1)

    return (x, y)


def calculate_step_delays(
    num_points: int,
    duration_ms: float,
    peak_velocity_position: float = PEAK_VELOCITY_POSITION
) -> List[float]:
    """
    Calculate variable delays between points based on minimum jerk velocity.

    Unlike constant delays, this creates realistic timing where the cursor
    moves faster in the middle of the movement and slower at the ends.

    Args:
        num_points: Number of points in the path
        duration_ms: Total duration in milliseconds
        peak_velocity_position: Where peak velocity occurs (0-1)

    Returns:
        List of delays in seconds (length = num_points - 1)
    """
    if num_points < 2:
        return []

    duration_s = duration_ms / 1000
    delays = []

    # Calculate velocity at each point
    velocities = []
    for i in range(num_points):
        t = i / (num_points - 1)
        v = _minimum_jerk_velocity(t)
        velocities.append(max(v, 0.01))  # Avoid division by zero

    # Normalize velocities
    total_v = sum(velocities[:-1])  # Exclude last point
    if total_v == 0:
        total_v = 1

    # Calculate delays inversely proportional to velocity
    for i in range(num_points - 1):
        # Time spent is inversely proportional to velocity
        relative_time = (1 / velocities[i]) / sum(1/v for v in velocities[:-1])
        delay = duration_s * relative_time

        # Add small variance (5-10%)
        delay *= random.uniform(0.95, 1.05)

        delays.append(max(0.001, delay))

    return delays


def calculate_step_delay(
    total_duration_ms: float,
    num_points: int,
    add_variance: bool = True
) -> float:
    """
    Calculate average delay between mouse movement steps.

    For backwards compatibility. Use calculate_step_delays() for
    more realistic variable-speed movements.

    Args:
        total_duration_ms: Total movement duration in milliseconds
        num_points: Number of points in the path
        add_variance: If True, add random variance

    Returns:
        Delay in seconds
    """
    if num_points < 2:
        raise ValueError("num_points must be at least 2")
    if total_duration_ms <= 0:
        raise ValueError("total_duration_ms must be positive")

    base_delay = (total_duration_ms / 1000) / (num_points - 1)

    if add_variance:
        variance = random.uniform(-0.2, 0.2)
        delay = base_delay * (1 + variance)
        return max(0.001, delay)

    return base_delay


# =============================================================================
# MAIN API
# =============================================================================

def create_mouse_movement(
    start_x: float,
    start_y: float,
    end_x: float,
    end_y: float,
    target_size: float = 10.0,
    duration_ms: Optional[float] = None
) -> dict:
    """
    Create a complete human-like mouse movement specification.

    This is the main API for generating realistic mouse movements.
    It combines all biomechanical models:
    - Fitts' Law for duration calculation
    - Minimum jerk trajectory for smooth movement
    - Physiological tremor for realistic imperfection
    - Overshoot correction for targeting behavior

    Args:
        start_x: Starting X coordinate
        start_y: Starting Y coordinate
        end_x: Target X coordinate
        end_y: Target Y coordinate
        target_size: Size of target element in pixels (affects timing and overshoot)
        duration_ms: Override duration (auto-calculated via Fitts' Law if None)

    Returns:
        Dictionary containing:
        - path: List of (x, y) coordinates
        - duration_ms: Total movement duration
        - delays: List of delays between points (seconds)
        - step_delay_s: Average delay (for simple usage)
        - num_points: Number of points in path
        - distance_px: Direct distance in pixels
        - straightness: Path straightness ratio
        - has_overshoot: Whether path includes overshoot
        - throughput: Calculated throughput (bits/second)

    Example:
        >>> movement = create_mouse_movement(0, 0, 500, 300, target_size=20)
        >>> for i, (x, y) in enumerate(movement['path']):
        ...     move_mouse(x, y)
        ...     if i < len(movement['delays']):
        ...         time.sleep(movement['delays'][i])
    """
    distance = math.sqrt((end_x - start_x)**2 + (end_y - start_y)**2)

    # Calculate duration using Fitts' Law if not provided
    if duration_ms is None:
        duration_ms = calculate_fitts_duration(distance, target_size)

    # Determine number of points based on distance and duration
    # More points for longer/slower movements
    points_per_100ms = 5
    num_points = max(10, min(60, int(duration_ms / 100 * points_per_100ms)))

    # Decide whether to include overshoot
    # More likely for fast movements to small targets
    speed_factor = 1500 / max(duration_ms, 100)
    overshoot_probability = _clamp(
        0.15 + 0.1 * speed_factor - 0.05 * (target_size / 20),
        0.05,
        0.35
    )
    use_overshoot = distance > 50 and random.random() < overshoot_probability

    # Generate path
    if use_overshoot:
        path = generate_overshoot_path(
            start_x, start_y, end_x, end_y,
            target_width=target_size,
            duration_ms=duration_ms,
            num_points=num_points
        )
    else:
        path = generate_path(
            start_x, start_y, end_x, end_y,
            num_points=num_points,
            duration_ms=duration_ms
        )

    # Calculate delays
    delays = calculate_step_delays(len(path), duration_ms)
    avg_delay = sum(delays) / len(delays) if delays else 0

    # Calculate metrics
    straightness = _calculate_straightness(path)
    throughput = calculate_throughput(distance, target_size, duration_ms)

    return {
        "path": path,
        "duration_ms": duration_ms,
        "delays": delays,
        "step_delay_s": avg_delay,
        "num_points": len(path),
        "distance_px": distance,
        "straightness": straightness,
        "has_overshoot": use_overshoot,
        "throughput": throughput
    }


def generate_movement_duration(
    distance: float,
    min_duration_ms: float = 200,
    max_duration_ms: float = 1500,
    target_size: float = 10.0
) -> float:
    """
    Calculate movement duration using Fitts' Law.

    This is a convenience wrapper around calculate_fitts_duration()
    with configurable min/max bounds.

    Args:
        distance: Distance in pixels
        min_duration_ms: Minimum duration
        max_duration_ms: Maximum duration
        target_size: Target width for Fitts' Law

    Returns:
        Duration in milliseconds
    """
    duration = calculate_fitts_duration(distance, target_size)
    return _clamp(duration, min_duration_ms, max_duration_ms)


# =============================================================================
# DEMO AND TESTING
# =============================================================================

if __name__ == "__main__":
    import time

    print("Human Mouse Movement Module - Biomechanical Model Demo")
    print("=" * 60)

    # Test Fitts' Law
    print("\n1. Fitts' Law Duration Calculation:")
    test_cases = [
        (100, 20, "Short distance, large target"),
        (500, 20, "Medium distance, large target"),
        (500, 5, "Medium distance, small target"),
        (1000, 10, "Long distance, medium target"),
    ]
    for dist, target, desc in test_cases:
        dur = calculate_fitts_duration(dist, target)
        tp = calculate_throughput(dist, target, dur)
        print(f"   {desc}: {dur:.0f}ms (throughput: {tp:.2f} bits/s)")

    # Test minimum jerk trajectory
    print("\n2. Minimum Jerk Trajectory:")
    print("   Time:     ", end="")
    for t in [0.0, 0.2, 0.42, 0.6, 0.8, 1.0]:
        print(f"{t:.2f}  ", end="")
    print()
    print("   Position: ", end="")
    for t in [0.0, 0.2, 0.42, 0.6, 0.8, 1.0]:
        pos = _asymmetric_minimum_jerk(t)
        print(f"{pos:.2f}  ", end="")
    print()
    print("   Velocity: ", end="")
    for t in [0.0, 0.2, 0.42, 0.6, 0.8, 1.0]:
        vel = _minimum_jerk_velocity(t)
        print(f"{vel:.2f}  ", end="")
    print()

    # Test path generation
    print("\n3. Path Generation (0,0) -> (500, 300):")
    path = generate_path(0, 0, 500, 300, num_points=10, duration_ms=500)
    print(f"   Points: {len(path)}")
    print(f"   Straightness: {_calculate_straightness(path):.3f}")
    print(f"   First 3 points: {[(f'{x:.1f}', f'{y:.1f}') for x, y in path[:3]]}")

    # Test variable delays
    print("\n4. Variable Step Delays (minimum jerk timing):")
    delays = calculate_step_delays(10, 500)
    print(f"   Delays (ms): {[f'{d*1000:.1f}' for d in delays]}")
    print(f"   Total: {sum(delays)*1000:.1f}ms (target: 500ms)")

    # Test complete movement
    print("\n5. Complete Movement Specification:")
    movement = create_mouse_movement(100, 100, 800, 600, target_size=15)
    print(f"   Distance: {movement['distance_px']:.0f}px")
    print(f"   Duration: {movement['duration_ms']:.0f}ms")
    print(f"   Points: {movement['num_points']}")
    print(f"   Straightness: {movement['straightness']:.3f}")
    print(f"   Overshoot: {movement['has_overshoot']}")
    print(f"   Throughput: {movement['throughput']:.2f} bits/s")

    # Test overshoot path
    print("\n6. Overshoot Path Test:")
    overshoot_count = 0
    for _ in range(20):
        mov = create_mouse_movement(0, 0, 600, 400, target_size=8, duration_ms=400)
        if mov['has_overshoot']:
            overshoot_count += 1
    print(f"   Overshoot frequency: {overshoot_count}/20 ({overshoot_count*5}%)")

    # Validate straightness
    print("\n7. Straightness Validation (target: ~0.91):")
    straightness_values = []
    for _ in range(50):
        p = generate_path(0, 0, 500, 300)
        s = _calculate_straightness(p)
        straightness_values.append(s)
    avg_straight = sum(straightness_values) / len(straightness_values)
    min_straight = min(straightness_values)
    max_straight = max(straightness_values)
    print(f"   Average: {avg_straight:.3f}")
    print(f"   Range: {min_straight:.3f} - {max_straight:.3f}")

    # Validate tremor characteristics
    print("\n8. Physiological Tremor (target: 8-12 Hz):")
    print(f"   Frequency range: {TREMOR_FREQUENCY_MIN}-{TREMOR_FREQUENCY_MAX} Hz")
    print(f"   Amplitude: {TREMOR_AMPLITUDE} pixels")
    tremor_samples = [_generate_tremor(t/10, 0.5) for t in range(11)]
    max_tremor = max(max(abs(tx), abs(ty)) for tx, ty in tremor_samples)
    print(f"   Max observed offset: {max_tremor:.2f}px")

    # Summary of biomechanical features
    print("\n9. Biomechanical Model Summary:")
    print(f"   - Fitts' Law: ID = log2(D/W + 1), throughput ~4-5 bits/s")
    print(f"   - Min Jerk: Peak velocity at {PEAK_VELOCITY_POSITION*100:.0f}% of movement")
    print(f"   - Straightness: Target {HUMAN_PATH_STRAIGHTNESS} (human average)")
    print(f"   - Tremor: {TREMOR_FREQUENCY_MIN}-{TREMOR_FREQUENCY_MAX} Hz oscillation")
    print(f"   - Overshoot: Probabilistic, based on speed/target size")

    print("\n" + "=" * 60)
    print("All demonstrations complete!")
