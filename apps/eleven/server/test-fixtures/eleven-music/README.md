# Eleven Music golden fixtures

This corpus keeps a deliberately small set of real Music v2 responses for offline presentation-map, lyric-timing, ramp, and station-element tests.

Each generated fixture contains:

- the exact composition-plan request;
- the encoded provider audio;
- the returned song ID and safe request headers;
- detailed-stream events with audio payloads removed;
- composition, song, timestamp, and waveform metadata returned by ElevenLabs;
- an audio SHA-256 digest.

Important provider behaviour captured by this corpus: `words_timestamps` includes tokens from inline composition instructions such as `{instrumental, no vocals}`. Do not interpret every returned word timestamp as audible singing. Presentation maps must match returned timestamps against the authored lyric lines and section type.

The checked definitions cover three track shapes and two station elements:

- `vocal-ramp`: clean instrumental intro and outro around vocal sections;
- `instrumental-bed`: instrumental cue and handoff windows;
- `dense-vocal`: an intentionally difficult vocal structure with only one clean break;
- `dry-id`: isolated station identification intended to sit over music;
- `wet-sting`: a self-contained musical logo intended for exposed placement.

`catalog.json` is the placement contract. Dry elements may sit over an existing music bed. Wet elements have their own harmonic and rhythmic footprint and are restricted to exposed openings, gaps, or handoffs.

Do not grow this into a music library. Add a fixture only when it represents a timing or metadata shape that the existing corpus cannot test.

Capture one definition from the server package directory:

```bash
pnpm capture:eleven-fixture -- \
  --request test-fixtures/eleven-music/definitions/vocal-ramp.json \
  --output test-fixtures/eleven-music/golden/vocal-ramp \
  --confirm-cost
```

The command refuses to overwrite an existing fixture unless `--overwrite` is explicit.
