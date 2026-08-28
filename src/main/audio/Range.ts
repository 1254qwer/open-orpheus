export class RangeNotSatisfiableError extends Error {}

/**
 * Parse a single HTTP byte range into an inclusive-exclusive interval.
 *
 * The returned end is clamped to the resource length, which is the convention
 * used by both audio protocol handlers when constructing a 206 response.
 */
export function parseRequestRange(
  rangeHeader: string | null,
  totalLength: number
) {
  if (!Number.isSafeInteger(totalLength) || totalLength < 0) {
    throw new RangeNotSatisfiableError();
  }
  if (!rangeHeader) return { start: 0, end: totalLength };

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) throw new RangeNotSatisfiableError();

  const [, startText, endText] = match;
  if (!startText && !endText) throw new RangeNotSatisfiableError();

  let start: number;
  let end: number;
  const total = BigInt(totalLength);

  if (!startText) {
    const suffixLength = parseRangeInteger(endText);
    if (suffixLength <= 0n) {
      throw new RangeNotSatisfiableError();
    }
    start = suffixLength >= total ? 0 : totalLength - Number(suffixLength);
    end = totalLength;
  } else {
    const parsedStart = parseRangeInteger(startText);
    if (parsedStart >= total) throw new RangeNotSatisfiableError();
    start = Number(parsedStart);
    if (!endText) {
      end = totalLength;
    } else {
      const parsedEnd = parseRangeInteger(endText);
      if (parsedEnd < parsedStart) throw new RangeNotSatisfiableError();
      end = parsedEnd >= total - 1n ? totalLength : Number(parsedEnd + 1n);
    }
  }

  if (start >= totalLength || end <= start) {
    throw new RangeNotSatisfiableError();
  }

  return {
    start,
    end: Math.min(end, totalLength),
  };
}

function parseRangeInteger(value: string) {
  try {
    return BigInt(value);
  } catch {
    throw new RangeNotSatisfiableError();
  }
}

export function normalizeBoundary(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
