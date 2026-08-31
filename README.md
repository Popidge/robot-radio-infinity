# Robot Radio Infinity

This repository contains a local-first prototype of an infinite AI radio station. All providers use local mocks by default. A vertically integrated Google stack is also available.

The browser owns the station state, event log, timing rules, and audio transitions. The server owns provider adapters and streams PCM audio.

## Run the prototype

1. Install the workspace packages:

   ```bash
   pnpm install
   ```

2. Start the web app and the server:

   ```bash
   pnpm dev
   ```

3. Open [http://localhost:5173](http://localhost:5173).

4. Enter a starting style in **What's your vibe today?**. Then click **Start listening**. This action gives the browser permission to start its `AudioContext`.

The first LLM call converts this message into the station's initial musical intent. The browser then starts Lyria RealTime and Lyria 3 Pro at the same time. Lyria plays when its safe buffer is ready. The first full track fades in when its buffer is ready.

Open **Diagnostics** to find the mock controls. Enable **Simulate slow generation** before the next-track horizon. Lyria becomes audible when the incoming track cannot become safe in time.

Select **Immediate redirect** in **Diagnostics** to test this sequence:

1. The browser starts a muted Lyria stream.
2. The urgency and intent mock calls run at the same time.
3. The browser waits for a safe Lyria buffer.
4. The browser fades the current track into Lyria.
5. The runtime steers Lyria and starts replacement music.
6. The mock DJ speaks while deterministic gain automation ducks the music.
7. The browser fades Lyria into the replacement track.

A normal next-track request follows one of two paths. Well before the horizon, it updates the musical intent and waits for normal horizon generation. Within the ten-second guard band before the horizon, it becomes a continuity-assisted request at the natural track boundary. The urgency classifier is the only model call that selects the timing path.

The main interface shows the station, the DJ conversation, and a live audio visualizer. The visualizer uses the real output spectrum. The current intent controls its color, energy, and pulse.

The DJ keeps a short memory of listener messages and its own recent lines. During hands-off playback, it can make small changes within the current musical direction. It speaks sparingly and avoids repeating recent phrases.

## Workspace

```text
apps/web       React, station reducer, runtime, Web Audio, and debugger
apps/server    Native Node HTTP, WebSocket streams, and provider adapters
packages/shared  Contracts and Zod schemas
```

The reducer is pure. Provider results return as events, and external services never change station state directly.

The LLM converts named artists, songs, and albums into musical attributes before it creates a provider request. If Lyria still rejects a track, the reducer sends the exact error and rejected specification back to Gemini. Gemini repairs only the rejected part, and the reducer starts a new generation. This retry is limited to two attempts. A healthy Lyria bridge remains available while the repair runs.

The mock server makes stereo PCM fixtures after each stream request. It simulates startup latency, stream speed, cancellation, starvation, and failures through environment variables.

## Commands

```bash
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @robot-radio/server profile:google-audio -- --mode realtime --realtime-seconds 20
pnpm --filter @robot-radio/server profile:google-audio -- --mode pro --duration 180
pnpm --filter @robot-radio/server profile:google-audio -- --mode tts
pnpm --filter @robot-radio/server profile:google-tts -- --runs 3 --warmups 1
```

## Production server

The production adapter serves the web app, API, and WebSocket streams from one Node process.

Build the workspace:

```bash
pnpm build
```

Start the production server:

```bash
PORT=8787 PROVIDER_STACK=mock pnpm start
```

Open [http://localhost:8787](http://localhost:8787). The server reads the built files from `apps/web/dist`.

The production server uses the port in `PORT`. Cloud Run sets this value automatically.

### Deploy from Google AI Studio

1. Import the GitHub repository in AI Studio Build mode.
2. Add `GEMINI_API_KEY` to the server secrets if AI Studio has not added it.
3. Build the app.
4. Publish the app to Cloud Run.

The server selects the Google stack when `GEMINI_API_KEY` exists. Set `PROVIDER_STACK=mock` only when you want the hosted mock stack.

AI Studio can install and build this npm workspace from `package-lock.json`. Its development command detects the hosted environment. It then builds the web app and starts the combined Node server.

The repository can remain private. Give the Google AI Studio GitHub App access to this repository only.

Cloud Run sets `K_SERVICE`. The server then writes structured logs to standard output.

If you want local NDJSON files, set `ROBOT_RADIO_DEBUG_LOG=on`. Cloud Run does not preserve these files.

## Mock configuration

The prototype uses these optional environment variables:

```text
PORT=8787
PROVIDER_STACK=mock
MOCK_URGENCY_LATENCY_MS=180
MOCK_PLANNER_LATENCY_MS=850
MOCK_MUSIC_STARTUP_MS=450
MOCK_LYRIA_STARTUP_MS=220
MOCK_TTS_STARTUP_MS=180
```

If you need failure or starvation controls, copy `.env.example`. The server reads these values from its process environment.

## Google provider stack

Set the following values in `.env`. This configuration selects the complete Google provider stack:

```text
PROVIDER_STACK=google
GEMINI_API_KEY=your-key
```

`LLM_PROVIDER`, `MUSIC_PROVIDER`, `LYRIA_PROVIDER`, and `TTS_PROVIDER` can each be `mock` or `google`.

An individual value overrides `PROVIDER_STACK`. This behavior lets you integrate and test one service at a time.

The default Google model values are:

```text
GEMINI_LLM_MODEL=gemini-3.7-flash
GEMINI_FAST_LLM_MODEL=gemini-3.5-flash-lite
GEMINI_FAST_LLM_THINKING_LEVEL=minimal
GEMINI_MUSIC_MODEL=lyria-3-pro-preview
GEMINI_LYRIA_REALTIME_MODEL=models/lyria-realtime-exp
GEMINI_LYRIA_API_VERSION=v1alpha
GEMINI_TTS_MODEL=gemini-3.1-flash-tts-preview
GEMINI_TTS_VOICE=Kore
GEMINI_TTS_DELIVERY=stream
```

The adapters keep Google types and prompts on the server. They expose the same provider-neutral contracts as the mocks.

The fast model handles the opening intent and urgency classification. The main model handles full user-intent and continuity plans. Gemini 3.7 Flash supports `low`, `medium`, and `high` thinking. The default fast Gemini 3.5 Flash-Lite model supports `minimal`, which reduces latency for these two narrow calls.

The adapters convert all Google audio to interleaved 48 kHz stereo `Float32Array` chunks. The browser receives only this common format.

Lyria 3 currently returns one MP3 block, even when the request uses `response_format: { type: "audio" }`. The adapter decodes this block with `ffmpeg`.

Gemini billing must be active for the music models. The server starts without an external request. The `/api/health` response shows the selected adapters.

The Google music adapter includes a packaged FFmpeg binary. Set `FFMPEG_PATH` to use a different executable.

### Profile Google music buffering

Run a short Lyria RealTime capture:

```bash
pnpm --filter @robot-radio/server profile:google-audio -- --mode realtime --realtime-seconds 20
```

Measure a requested three-minute Lyria 3 Pro track:

```bash
pnpm --filter @robot-radio/server profile:google-audio -- --mode pro --duration 180
```

Measure the selected Gemini TTS adapter:

```bash
pnpm --filter @robot-radio/server profile:google-audio -- --mode tts
```

Compare the Interactions and Generate Content TTS routes in streaming and batch modes:

```bash
pnpm --filter @robot-radio/server profile:google-tts -- --runs 3 --warmups 1
```

The profiler reports the connection latency and the response-open latency. It measures the time to the first encoded audio and playable PCM.

It also reports the wall time, audio duration, generation rate, chunk timing, byte count, audio format, and stream event counts.

A generation rate above `1` means that the provider delivered audio faster than playback consumes it.

Gemini TTS uses `generateContentStream` by default. Set `GEMINI_TTS_DELIVERY=batch` to wait for a complete spoken line from `generateContent` instead.

Lyria 3 uses the Interactions API with `stream: true`. The current preview returns its audio in one block after generation finishes.

The profile results show whether the current preview sends multiple audio deltas or one complete audio block.

See [the recorded Google provider profile](docs/google-provider-profile.md) for the first live measurements.

## Debug logs

The server writes one structured NDJSON file for each server run. The startup output shows the absolute file path.

The default directory is `logs/` at the workspace root. Git ignores this directory. Each log file has owner-only permissions.

Use this procedure for a test session:

1. Start the app:

   ```bash
   pnpm dev
   ```

2. Use the station and reproduce the problem.

3. Click **Stop** in the station UI.

4. Stop the development processes with `Ctrl+C`.

5. Find the newest log:

   ```bash
   ls -1t logs/robot-radio-*.ndjson | head -1
   ```

The log contains browser events, reducer commands, state summaries, LLM plans, provider timings, stream metrics, and errors.

The log does not contain API keys or raw audio. The logger removes configured secrets from messages and stack traces.

Listener requests and DJ text are in the log. Do not share a log if these fields contain private information.

Set `ROBOT_RADIO_DEBUG_LOG=off` to disable file logs. Set `ROBOT_RADIO_DEBUG_LOG_DIR` to select a different directory.

## Transition thresholds

The next-track horizon is 50 seconds by default. Set `VITE_NEXT_TRACK_HORIZON_MS` to use a different value. The default generated programme-track duration is 180 seconds. Set `VITE_PROGRAM_TRACK_DURATION_MS` to change it.

The 50-second default includes a margin over the measured 40-second Lyria 3 Pro generation time. A normal incoming stream starts after four buffered seconds.

A next-track listener request uses a ten-second guard band before the horizon. Before this band, the reducer saves the new intent and waits. Inside this band, it generates the requested track immediately and reserves Lyria for the natural boundary.

For a stream that is slower than real time, the runtime calculates a larger safe buffer. This rule prevents playback from consuming audio faster than generation.

Lyria becomes healthy after three buffered seconds. The runtime commits Lyria when less than eight seconds remain and the next track is unsafe.

## Tests

The reducer tests cover prewarm ordering, idempotent leases, direct fades, Lyria commits, resolved durations, user-request timing, and provider-rejection repair.

The server tests cover Google audio conversion and provider selection.
