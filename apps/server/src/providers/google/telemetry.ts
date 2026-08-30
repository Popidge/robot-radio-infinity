interface GoogleAudioTelemetryBase {
  provider: "lyria-realtime" | "lyria-3" | "gemini-tts";
  streamId?: string;
  at: number;
}

export type GoogleAudioTelemetryEvent =
  | (GoogleAudioTelemetryBase & { type: "request_started"; model: string })
  | (GoogleAudioTelemetryBase & { type: "response_opened" })
  | {
      type: "audio_delta";
      provider: "lyria-realtime" | "lyria-3" | "gemini-tts";
      streamId?: string;
      at: number;
      encodedBytes: number;
      mimeType?: string;
      sampleRate?: number;
      channels?: number;
    }
  | (GoogleAudioTelemetryBase & { type: "stream_event"; provider: "lyria-3" | "gemini-tts"; eventType: string })
  | (GoogleAudioTelemetryBase & { type: "completed" });

export type GoogleAudioTelemetrySink = (event: GoogleAudioTelemetryEvent) => void;

export function emitTelemetry(
  sink: GoogleAudioTelemetrySink | undefined,
  event: GoogleAudioTelemetryEvent
): void {
  sink?.(event);
}
