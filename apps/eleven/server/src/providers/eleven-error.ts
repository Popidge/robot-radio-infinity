export const ELEVENLABS_CREDITS_EXHAUSTED_MESSAGE =
  "This demo has used its current ElevenLabs allowance. It cannot make more audio until the credits reset.";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorCodes(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];
  const codes = [record.code, record.status, record.type]
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.toLowerCase());
  return [...codes, ...errorCodes(record.detail), ...errorCodes(record.error)];
}

export function isElevenLabsCreditsError(status: number, payload: unknown): boolean {
  if (status === 402) return true;
  return errorCodes(payload).some((code) => code === "insufficient_credits" || code === "quota_exceeded");
}

export async function elevenLabsResponseError(response: Response, operation: string): Promise<Error> {
  const text = (await response.text()).slice(0, 12_000);
  let payload: unknown = text;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    // Keep the provider text for diagnostics when it is not JSON.
  }
  if (isElevenLabsCreditsError(response.status, payload)) {
    return new Error(ELEVENLABS_CREDITS_EXHAUSTED_MESSAGE);
  }
  const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Error(`${operation} with HTTP ${response.status}: ${detail}`);
}
