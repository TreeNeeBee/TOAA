const MIN_EXISTING_BYTES = 200;
const MIN_REPLACEMENT_BYTES = 80;
const MIN_REPLACEMENT_RATIO = 0.2;

export interface TextReplacementGuardInput {
  tool: string;
  path: string;
  originalBytes: number;
  replacementBytes: number;
}

export function suspiciousTextTruncationError(
  input: TextReplacementGuardInput,
): string | undefined {
  if (input.originalBytes < MIN_EXISTING_BYTES) return undefined;
  const minimum = Math.max(
    MIN_REPLACEMENT_BYTES,
    Math.ceil(input.originalBytes * MIN_REPLACEMENT_RATIO),
  );
  if (input.replacementBytes >= minimum) return undefined;
  return (
    `${input.tool} refused suspicious truncation of ${input.path}: existing ${input.originalBytes}B, ` +
    `replacement ${input.replacementBytes}B (minimum safe result ${minimum}B). ` +
    'The existing file was left unchanged. Use a focused replace_in_file/apply_patch edit, ' +
    'or provide a complete replacement that preserves the intended file structure.'
  );
}
