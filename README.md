# Robot Radio Infinity

Robot Radio Infinity is an AI-generated radio station that reacts while the listener is listening. The active product uses OpenAI for station planning and ElevenLabs for streamable music, transitions, and speech.

The ElevenLabs/OpenAI implementation is the repository default. Its in-generation music stream gives the station a short time to first playable PCM, so its state machine is designed around live buffering, immediate transitions, and underrun protection.

## Start active development

Use Node.js 24 and pnpm 10 from the repository root:

```bash
pnpm install
cp apps/eleven/.env.example .env
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). The Node server runs on [http://localhost:8787](http://localhost:8787).

The default environment uses generated PCM fixtures and makes no paid provider calls. To use live providers, add `OPENAI_API_KEY` and `ELEVENLABS_API_KEY` to `.env` and set `PROVIDER_STACK=eleven`.

## Repository policy

`apps/eleven` is the active product. New product work, tests, and deployment changes should target this application unless a task says otherwise.

`apps/google` is a frozen reference implementation. It remains in the repository for comparison and research, but it does not constrain the active ElevenLabs state machine. The exact Google AI Studio-ready baseline is preserved at the immutable `snapshot/google-ai-studio-pre-monorepo` tag.

The applications deliberately own separate state machines, contracts, provider integrations, diagnostics, and tests. Shared packages should be introduced only after code has proved independent of both orchestration models. Provider interchangeability is not a design goal.

```text
apps/eleven/web       Active React client, state machine, runtime, and Web Audio code
apps/eleven/server    Active OpenAI and ElevenLabs orchestration and providers
apps/eleven/shared    Active app contracts and schemas

apps/google/web       Frozen Google client and state machine
apps/google/server    Frozen Gemini and Lyria orchestration and providers
apps/google/shared    Frozen app contracts and schemas
```

## Commands

The short commands target the active ElevenLabs/OpenAI application:

```bash
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm start
pnpm verify
```

The frozen Google application is available only through explicit commands:

```bash
npm run dev:google
npm run test:google
npm run typecheck:google
npm run build:google
npm run start:google
```

Use `pnpm verify:all` when a workspace or repository-infrastructure change must be checked against both applications.

The active workflow uses `pnpm-lock.yaml`. The root `package-lock.json` remains because the frozen Google AI Studio integration required npm. See [the active app guide](apps/eleven/README.md) and [the frozen Google guide](apps/google/README.md) for implementation details.
