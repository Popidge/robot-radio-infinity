# Google provider profile

This profile records one live sample from 30 August 2026. It is an integration measurement, not a performance guarantee.

## Results

| Provider | First playable PCM | Audio received | Wall time | Rate | Delivery |
| --- | ---: | ---: | ---: | ---: | --- |
| Lyria RealTime | 3.01 s | 20.00 s | 21.04 s | 0.95× | Ten 2-second PCM chunks |
| Lyria 3 Pro | 40.25 s | 175.65 s | 40.26 s | 4.36× | One MP3 audio block |
| Gemini 3.1 Flash TTS, Interactions stream | 1.10 s | 6.32 s | 19.31 s | 0.33× | 158 PCM chunks |

The Lyria RealTime handshake completed in 184 ms. The first raw audio arrived in 2.98 seconds.

The median RealTime chunk interval was 2.00 seconds. The p95 interval was 2.36 seconds.

The Lyria 3 Pro request asked for 180 seconds. The model returned 175.65 seconds of audio in 40.26 seconds.

The Interactions stream sent one Lyria 3 audio delta. The delta used `audio/mpeg`, so playable PCM was unavailable until generation finished.

The Interactions TTS stream started quickly but generated slower than playback. A separate route comparison identified the endpoint as the cause.

## TTS route comparison

Each measured result below is the median of three requests. The short line had six words. The medium line had 13 words.

| Route | Text | First audio | Complete audio rate | Safe playback start | Failures |
| --- | --- | ---: | ---: | ---: | ---: |
| Interactions stream | Short | 0.91 s | 0.30× | 7.91 s | 2 of 3 |
| Interactions batch | Short | 2.97 s | 1.27× | 2.97 s | 0 of 3 |
| Generate Content stream | Short | 0.72 s | 2.11× | 0.72 s | 0 of 3 |
| Generate Content batch | Short | 2.32 s | 1.57× | 2.32 s | 0 of 3 |
| Interactions stream | Medium | 0.93 s | 0.32× | 13.77 s | 0 of 3 |
| Interactions batch | Medium | 4.91 s | 1.32× | 4.91 s | 0 of 3 |
| Generate Content stream | Medium | 0.73 s | 2.10× | 0.73 s | 0 of 3 |
| Generate Content batch | Medium | 4.93 s | 1.20× | 4.93 s | 0 of 3 |

The Generate Content stream produced 40 ms PCM chunks. It remained ahead of playback in every measured run. The browser can therefore start after its normal TTS safety buffer without waiting for the full line.

The server now uses `generateContentStream` by default. Set `GEMINI_TTS_DELIVERY=batch` to select whole-line generation. Batch mode is useful as a controlled fallback, but it adds two to five seconds before speech can start in these samples.

A final live call through the production adapter produced its first 48 kHz stereo PCM at 0.84 seconds. It returned 6.64 seconds of speech in 2.78 seconds, or 2.39× realtime. The same adapter in batch mode produced its first PCM at 4.55 seconds and completed at 1.45× realtime.

## Resulting defaults

The next-track horizon is 50 seconds. This value gives the measured Pro generation time a margin of approximately 10 seconds.

Lyria RealTime becomes healthy after three buffered seconds. Its 2-second chunks make the effective prewarm time approximately five seconds.

The runtime records track duration from received PCM. It does not assume that the requested Lyria 3 duration is exact.

## Format probes

The documented `response_format: { type: "audio" }` request succeeded but returned MP3.

An explicit `delivery: "inline"` value failed with `400 Audio delivery mode is not supported.`

An explicit `mime_type: "audio/wav"` value also failed with HTTP 400. The adapter uses the accepted request and decodes MP3 with `ffmpeg`.
