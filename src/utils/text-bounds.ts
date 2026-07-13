export function utf8BufferHead(value: Buffer, maxBytes: number): Buffer {
  const end = Math.min(maxBytes, value.length);
  if (end === 0) return value.subarray(0, 0);
  let sequenceStart = end - 1;
  while (sequenceStart > 0 && (value[sequenceStart] & 0xc0) === 0x80) sequenceStart -= 1;
  const lead = value[sequenceStart];
  const expectedBytes = lead >= 0xf0 && lead <= 0xf4
    ? 4
    : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 1;
  if (expectedBytes > end - sequenceStart) {
    return value.subarray(0, sequenceStart);
  }
  return value.subarray(0, end);
}

export function utf8BufferTail(value: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, value.length - maxBytes);
  while (start < value.length && (value[start] & 0xc0) === 0x80) start += 1;
  return value.subarray(start);
}

/** Clip UTF-8 text without splitting a code point. */
export function clipUtf8Bytes(
  text: string,
  maxBytes: number,
  marker: string,
  headRatio = 0.65,
): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;

  const markerBuffer = Buffer.from(marker, "utf8");
  if (markerBuffer.length >= maxBytes) {
    return utf8BufferHead(markerBuffer, maxBytes).toString("utf8");
  }
  const keepBytes = Math.max(0, maxBytes - markerBuffer.length);
  const headBudget = Math.floor(keepBytes * headRatio);
  const tailBudget = keepBytes - headBudget;

  const head = utf8BufferHead(buffer, headBudget);
  const tail = utf8BufferTail(buffer, tailBudget);

  return Buffer.concat([
    head,
    markerBuffer,
    tail,
  ]).toString("utf8");
}
