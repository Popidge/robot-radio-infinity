# Robot Radio Infinity

This is the active Robot Radio Infinity product. It uses ElevenLabs and OpenAI, and all default repository commands target it.

The browser owns the station state, event log, timing rules, buffers, and audio transitions. The server owns API keys and provider adapters.

Eleven Music v2 streams each full track as it generates. It also creates short instrumental transition clips for immediate changes and underrun protection.

OpenAI makes scoped producer decisions. Deterministic browser code decides when audio starts, stops, fades, ducks, waits, or permits speech.

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

The default DJ voice is Blondie, a female London voice with a professional radio-announcer tone. Set `ELEVENLABS_VOICE_ID` to select another voice.

You can select one adapter at a time:

```text
LLM_PROVIDER=openai
MUSIC_PROVIDER=eleven
TRANSITION_PROVIDER=eleven
TTS_PROVIDER=eleven
```

Each value can also be `mock`.

## Station flow

The opening message starts one OpenAI producer call. The plan contains the musical direction, first track, show memory, and optional opening cue.

The browser starts the first Eleven Music stream. ElevenLabs MP3 stays compressed across the server and WebSocket, then a browser worker decodes it. Playback starts after the decoded stream has a safe PCM buffer.

Each listener message starts two calls at the same time:

- The fast call classifies the requested timing.
- The full call plans the destination intent and next track.

For an immediate request, the classifier also returns a short transition sketch. The browser starts the transition stream before the full plan returns.

The transition contains no vocals. ElevenLabs TTS can speak over it while deterministic gain automation ducks the music.

When the destination track has a safe buffer, the browser fades from the transition into that track.

For a normal request, the browser saves the new intent. The next-track horizon then starts the full track stream without a transition.

If a track stream is late, the browser starts an emergency transition. The transition prevents dead air while the track buffer grows.

Every asynchronous request has a revision number. The reducer ignores results from an older listener request.

## Producer and presenter

The opening, listener, and horizon planners return the same `ProducerPlan` contract. Each plan contains these decisions:

- One musical direction and one concrete next track
- An optional on-air cue with one editorial purpose and one link fingerprint
- Bounded updates for the show memory
- Composition notes for Eleven Music
- An advisory timing class

The browser keeps a bounded `ShowState`. This state contains presenter rules, listener memory, the musical thesis, production fingerprints, link fingerprints, and speech cadence.

A producer plan cannot start playback, a transition, or speech. The reducer ignores the advisory timing class when it selects an action.

The browser builds a `TrackPresentationMap` from the planned sections. It then reconciles this map with the observed Eleven Music word timestamps.

The reconciliation matches only authored lyric words. It does not interpret timestamped composition instructions as audible vocals.

The runtime prepares each TTS asset before its mic window. The preparation does not duck the music or start the TTS asset.

The fast urgency classifier remains separate. Its result tells the reducer whether a listener request is conversational, deferred, next-track, or immediate.

The reducer permits a cue only in these windows:

- The prepared opening cue fits before the observed first vocal.
- The prepared listener reply fits in a clean bed or transition.
- The prepared back-announce finishes near a ready handoff.
- The prepared observation fits in a rare instrumental gap.

The reducer starts prepared speech only when the full duration fits. The reducer discards speech when the cooldown, buffer, revision, or music blocks it.

Back-announces use the real track title and supplied presentation facts. The planner varies each link against the recent link fingerprints.

The station-element registry prepares one dry ID and one wet sting. The browser can replay these audio assets without a new music request.

The dry ID can play over an authorized clean bed. The wet sting stays available for an exposed handoff and never plays over full music.

The station remains listener-led. After two autonomous tracks, cruise mode develops the current thesis without a format clock.

After four autonomous tracks, exploratory mode makes one bolder adjacent move. A listener message returns the station to interactive mode immediately.

The reducer merges the plan composition notes into the `TrackSpec`. The Eleven Music adapter adds these notes to each section as production direction.

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

Live ElevenLabs music and TTS stay in their 128 kbps MP3 form while they pass through the server. A browser Web Worker decodes each incremental MP3 chunk and normalizes it to interleaved 48 kHz stereo `Float32Array` chunks for the AudioWorklet. This keeps live audio transport near 57.6 MB per listener-hour instead of about 1.38 GB per listener-hour for raw float PCM.

The mock providers still send generated 48 kHz stereo PCM. This keeps local development deterministic and provider-free. The music profiler retains its packaged FFmpeg decoder because it measures encoded and playable arrival timing outside the browser.

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

The reducer tests cover message races, bounded memory, mic windows, prepared speech, station elements, autonomy, underruns, crossfades, and stale results.

The presentation-map tests use the retained Eleven Music corpus. These tests cover observed vocal ramps, dense vocals, instrumental beds, and false instruction timestamps.

The server tests cover provider selection, structured logs, static hosting, and encoded provider pass-through. Browser tests cover streaming PCM normalization across decoder chunk boundaries.
