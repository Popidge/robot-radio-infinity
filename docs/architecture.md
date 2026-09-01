# Architecture

Robot Radio Infinity separates editorial decisions from playback authority. The AI producer can propose a show, but deterministic code controls the live output.

## Runtime ownership

The browser owns these systems:

- The station reducer and event log
- Playback timing and state transitions
- Audio buffers, decoding, gain, fades, and ducking
- Mic-window authorization
- Lyric timing and visual presentation

The server owns these systems:

- OpenAI and ElevenLabs API keys
- Producer, urgency, music, transition, and TTS provider calls
- Compressed audio streaming
- Provider error normalization
- Structured debug logs

The server does not keep session state. Each browser owns one personal station session.

## Producer decisions

The opening, listener, and horizon calls return one `ProducerPlan` shape. Each plan contains the following information:

- The next musical direction
- One concrete track specification
- An optional presenter cue and purpose
- Bounded show-memory updates
- Composition notes for Eleven Music
- An advisory timing class

The reducer ignores direct playback implications from model output. It applies the plan only when the current revision and station state permit it.

## Listener requests

Each listener message starts a fast urgency call and a full producer call. The urgency result classifies the message as conversational, deferred, next-track, or immediate.

An immediate change can start an instrumental transition before the full destination plan returns. A next-track request changes the next horizon plan without interrupting the current song.

Text replies can appear immediately. Prepared TTS waits for a safe mic window, or the reducer discards it.

## Audio transport

ElevenLabs audio stays in MP3 form between the provider and the browser. The browser worker decodes each incremental stream before the AudioWorklet receives PCM.

This design keeps transport near 57.6 MB per listener-hour at 128 kbps. Raw 48 kHz stereo float PCM uses about 1.38 GB per listener-hour.

Each music, transition, or TTS asset uses one WebSocket. The socket closes after the asset finishes or the browser cancels it.

## Presentation maps

The producer supplies planned track sections. Eleven Music can also return observed word timestamps.

The browser reconciles both sources into a `TrackPresentationMap`. This map marks vocals, instrumental ramps, clean beds, section boundaries, and ending style.

The reducer uses this map to fit prepared speech into safe windows. It does not cross an observed vocal because a model requested speech.

## Autonomy

The station remains listener-led. A listener message returns the DJ to interactive mode immediately.

After two tracks without a listener message, cruise mode develops the current musical thesis. After four tracks, exploratory mode permits one adjacent move.

Autonomous speech stays sparse. A separate deterministic cooldown blocks frequent links even when the producer proposes them.

## Failure behavior

An active playable source continues when a future generation fails. Repairable composition errors return to the producer for a bounded repair attempt.

Short instrumental transitions protect handoffs when the next full track is late. A spent ElevenLabs key produces a clear listener-facing allowance message.

The demo password protects every paid HTTP route and WebSocket upgrade. The static client contains no provider keys.
