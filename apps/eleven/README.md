# Robot Radio Infinity

This is the active Robot Radio Infinity product. It uses ElevenLabs and OpenAI, and all default repository commands target it.

The browser owns the station state, event log, timing rules, buffers, and audio transitions. The server owns API keys and provider adapters.

Eleven Music v2 streams each full track as it generates. It also creates short instrumental transition clips for immediate changes and underrun protection.

OpenAI makes scoped musical decisions. Deterministic browser code decides when audio starts, stops, fades, ducks, or waits.

## Start with mocks

1. Install the workspace packages:

   ```bash
   pnpm install
   ```

2. Copy the environment template:

   ```bash
   cp apps/eleven/.env.example .env
   ```

3. Start the web app and the server:

   ```bash
   pnpm dev
   ```

4. Open [http://localhost:5173](http://localhost:5173).

5. Enter a starting style in **What do you want to hear today?**.

6. Select **Start listening**.

The mock stack uses generated PCM fixtures. It does not make external API calls.

## Start the live stack

Set these values in `.env`:

```text
PROVIDER_STACK=eleven
OPENAI_API_KEY=your-key
ELEVENLABS_API_KEY=your-key
```

Then run `pnpm dev`.

The server selects the live stack automatically when both keys exist. An explicit `PROVIDER_STACK=mock` value still selects mocks.

The live stack uses these default models:

```text
OPENAI_LLM_MODEL=gpt-5.6-luna
OPENAI_FAST_LLM_MODEL=gpt-5.6-luna
OPENAI_FAST_SERVICE_TIER=priority
ELEVENLABS_MUSIC_MODEL=music_v2
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
```

Set `ELEVENLABS_VOICE_ID` to select the DJ voice. The template contains a premade voice ID as the default.

You can select one adapter at a time:

```text
LLM_PROVIDER=openai
MUSIC_PROVIDER=eleven
TRANSITION_PROVIDER=eleven
TTS_PROVIDER=eleven
```

Each value can also be `mock`.

## Station flow

The opening message starts one OpenAI planning call. The returned plan contains the musical intent, track title, and composition sections.

The browser starts the first Eleven Music stream. Playback starts after the stream has a safe PCM buffer.

Each listener message starts two calls at the same time:

- The fast call classifies the requested timing.
- The full call plans the destination intent and next track.

For an immediate request, the classifier also returns a short transition sketch. The browser starts the transition stream before the full plan returns.

The transition contains no vocals. ElevenLabs TTS can speak over it while deterministic gain automation ducks the music.

When the destination track has a safe buffer, the browser fades from the transition into that track.

For a normal request, the browser saves the new intent. The next-track horizon then starts the full track stream without a transition.

If a track stream is late, the browser starts an emergency transition. The transition prevents dead air while the track buffer grows.

Every asynchronous request has a revision number. The reducer ignores results from an older listener request.

## Music-provider errors

The LLM translates named artist and song references into generic musical attributes. It keeps useful differences such as era, vocals, structure, and production.

If Eleven Music rejects a track, the reducer sends the exact error and rejected plan to OpenAI. OpenAI returns a repaired track plan.

The reducer permits two repair attempts. Existing audio continues during the repair when a playable source remains.

## Workspace

```text
apps/eleven/web     React, pure reducer, runtime, Web Audio, and debugger
apps/eleven/server  Node HTTP server, WebSocket streams, and provider adapters
apps/eleven/shared  ElevenLabs/OpenAI contracts and Zod schemas
```

The AudioWorklet receives interleaved 48 kHz stereo `Float32Array` chunks. The server decodes ElevenLabs MP3 streams with the packaged FFmpeg binary.

## Commands

```bash
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm start
pnpm verify
```

The longer `:eleven` command aliases remain available when an explicit application name is useful.

The Eleven Music profiler makes paid API requests. Add `--confirm-cost` to permit a generation mode:

```bash
pnpm --filter @robot-radio/eleven-server profile:eleven-music -- --mode stream --duration-seconds 30 --confirm-cost
pnpm --filter @robot-radio/eleven-server profile:eleven-music -- --mode bridge --transition-seconds 30 --confirm-cost
```

Run the profiler with `--help` to see all modes.

## Debug logs

The server writes one NDJSON log for each local run. The startup output shows the absolute file path.

Use this procedure for a test session:

1. Start the app with `pnpm dev`.

2. Reproduce the problem.

3. Select **End session** in the player.

4. Stop the development processes with `Ctrl+C`.

5. Find the newest log:

   ```bash
   ls -1t logs/robot-radio-*.ndjson | head -1
   ```

The log contains station events, commands, state summaries, provider timings, stream metrics, and errors. It does not contain API keys or audio.

Listener messages and DJ lines are present in the log. Do not share a log that contains private listener text.

## Timing values

The next-track horizon is 50 seconds. Set `VITE_NEXT_TRACK_HORIZON_MS` to change this value.

The default track duration is 180 seconds. Set `VITE_PROGRAM_TRACK_DURATION_MS` to change this value.

A track starts with 10 seconds of safe PCM by default. A transition starts with 8 seconds of safe PCM.

If fewer than 15 seconds remain and the next track is unsafe, the reducer starts an emergency transition.

## Tests

The reducer tests cover message races, classifier-first transitions, future requests, horizon generation, underruns, crossfades, and stale provider results.

The server tests cover provider selection, structured logs, static hosting, and audio conversion.
