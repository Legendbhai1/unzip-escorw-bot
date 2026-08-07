/**
 * Parses a time string into total minutes.
 * Only accepts whole numbers with valid units.
 * No fractional values (e.g. "1.5h", "90min") allowed.
 *
 * Valid formats:
 *   1h, 2h, 10hours, 1hour
 *   30m, 1min, 5mins, 10minutes, 1minute
 *   1w, 2w, 1weeks, 1week
 *   1d, 2d, 1days, 1day
 *
 * Returns { minutes: number, valid: true } or { valid: false, error: string }
 */
function parseTimeToMinutes(input) {
  const t = input.trim();

  // Match: optional whole number + unit
  // No decimals allowed — the number must be \d+
  const match = t.match(/^(\d+)\s*(h|hours?|m|mins?|minutes?|w|weeks?|d|days?)$/i);
  if (!match) {
    return {
      valid: false,
      error:
        'Invalid time format. Use whole numbers only, e.g.:\n' +
        '  1h, 2h, 30m, 45mins, 1w, 2w, 1d, 3d\n' +
        'Fractions like 1.5h or 90min are NOT allowed.',
    };
  }

  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (num <= 0) {
    return { valid: false, error: 'Time must be at least 1.' };
  }

  let minutes;
  if (unit.startsWith('h')) {
    minutes = num * 60;
  } else if (unit.startsWith('w')) {
    minutes = num * 7 * 24 * 60;
  } else if (unit.startsWith('d')) {
    minutes = num * 24 * 60;
  } else {
    // m, min, mins, minute, minutes
    minutes = num;
  }

  return { minutes, valid: true };
}

/** Format minutes into a human-readable string */
function formatMinutes(minutes) {
  if (minutes >= 7 * 24 * 60) {
    const weeks = Math.round(minutes / (7 * 24 * 60));
    return `${weeks} week${weeks > 1 ? 's' : ''}`;
  }
  if (minutes >= 24 * 60) {
    const days = Math.round(minutes / (24 * 60));
    return `${days} day${days > 1 ? 's' : ''}`;
  }
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours > 1 ? 's' : ''}`;
  }
  return `${minutes} min${minutes > 1 ? 's' : ''}`;
}

module.exports = { parseTimeToMinutes, formatMinutes };
