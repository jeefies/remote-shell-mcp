export function truncateUtf8(input: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  if (input.byteLength <= maxBytes) {
    return { text: input.toString("utf8"), truncated: false };
  }

  return {
    text: input.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

export function appendLimited(
  chunks: Buffer[],
  next: Buffer,
  currentBytes: number,
  maxBytes: number,
): { bytes: number; truncated: boolean } {
  if (currentBytes >= maxBytes) {
    return { bytes: currentBytes, truncated: true };
  }

  const remaining = maxBytes - currentBytes;
  if (next.byteLength <= remaining) {
    chunks.push(next);
    return { bytes: currentBytes + next.byteLength, truncated: false };
  }

  chunks.push(next.subarray(0, remaining));
  return { bytes: maxBytes, truncated: true };
}
