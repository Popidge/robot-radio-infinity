# Robot Radio Infinity

Robot Radio Infinity contains two independently deployable implementations of the same AI radio experience:

- `apps/google` uses Gemini for planning and speech, Lyria 3 Pro for full tracks, and Lyria RealTime for continuity.
- `apps/eleven` uses OpenAI for planning and ElevenLabs for music, generated transitions, and speech.

The applications deliberately own separate station state machines, contracts, provider integrations, diagnostics, and tests. Shared packages will be introduced only for code that is demonstrably independent of either orchestration model.

## Start an application

Install the workspace once from the repository root:

```bash
pnpm install
```

Start the Google application, which is also the default for Google AI Studio:

```bash
pnpm dev
```

Start the ElevenLabs/OpenAI application:

```bash
pnpm dev:eleven
```

Both commands start a Vite client on `http://localhost:5173` and a Node server on `http://localhost:8787`.

Copy the relevant environment template to the repository root before using a live provider stack:

```bash
cp apps/google/.env.example .env
# or
cp apps/eleven/.env.example .env
```

## Workspace

```text
apps/google/web       Google client, state machine, runtime, and Web Audio integration
apps/google/server    Gemini and Lyria server and provider integrations
apps/google/shared    Contracts and schemas used only by the Google application

apps/eleven/web       ElevenLabs/OpenAI client, state machine, runtime, and Web Audio integration
apps/eleven/server    OpenAI and ElevenLabs server and provider integrations
apps/eleven/shared    Contracts and schemas used only by the ElevenLabs/OpenAI application
```

## Verification commands

```bash
pnpm test:google
pnpm test:eleven
pnpm test
pnpm typecheck
pnpm build:google
pnpm build:eleven
pnpm build:all
```

`pnpm build` and `pnpm start` default to the Google application for AI Studio compatibility. Use `pnpm start:eleven` for the ElevenLabs/OpenAI production server.

For implementation details and provider configuration, see [the Google app guide](apps/google/README.md) and [the ElevenLabs/OpenAI app guide](apps/eleven/README.md).
