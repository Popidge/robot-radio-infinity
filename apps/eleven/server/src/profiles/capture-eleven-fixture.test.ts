import { describe, expect, it } from "vitest";
import { SseCaptureDecoder } from "./capture-eleven-fixture";

describe("Eleven Music fixture capture", () => {
  it("preserves detailed metadata while extracting base64 audio", () => {
    const decoder = new SseCaptureDecoder();
    const first = decoder.push('event: audio_chunk\ndata: {"type":"audio_chunk","data":{"audio_base64":"AQID","words_timestamps":[{"word":"Radio","start_ms":20,"end_ms":200}]}}\n');
    expect(first).toEqual([]);
    const captured = decoder.push("\n");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.audio[0]).toEqual(Buffer.from([1, 2, 3]));
    expect(captured[0]!.event).toMatchObject({ type: "audio_chunk", audioBytes: 3 });
    expect(captured[0]!.event.payload).toEqual({
      type: "audio_chunk",
      data: {
        audio_base64_capture: { omitted: true, bytes: 3 },
        words_timestamps: [{ word: "Radio", start_ms: 20, end_ms: 200 }]
      }
    });
  });

  it("supports double-encoded JSON and multiple streamed events", () => {
    const decoder = new SseCaptureDecoder();
    const captured = decoder.push('data: "{\\"type\\":\\"composition_plan\\",\\"chunks\\":[]}"\n\ndata: {"type":"song_metadata","title":"Fixture"}\n\n');
    expect(captured.map((item) => item.event.type)).toEqual(["composition_plan", "song_metadata"]);
    expect(captured.map((item) => item.event.sequence)).toEqual([1, 2]);
  });
});
