# Deploy to Vercel

This repository uses [Vercel Services](https://vercel.com/docs/services) for one Vite service and one Node.js service. Both services use the same public domain.

The Node.js service uses Vercel WebSocket support. Each audio stream stays pinned to one function instance until that asset finishes.

## Before deployment

Create restricted keys for this demo.

For ElevenLabs, restrict the key to the Music and Text to Speech APIs. Set a credit quota on the key.

For OpenAI, use a project key that you can rotate without affecting other applications.

## Create the Vercel project

1. Import the GitHub repository into Vercel.

2. Keep the project root at the repository root.

3. Set the Framework Preset to **Services**.

4. Do not add dashboard overrides for the install, build, or output commands.

5. Keep Fluid compute enabled.

6. Add the production environment variables from the next section.

7. Deploy the project.

The `vercel.json` file contains both service builds and all public routes. It selects pnpm for both services.

The frozen Google application keeps its separate npm lockfile.

## Environment variables

Import `apps/eleven/.env.example` into the Production environment. Then add values for these three secrets:

```text
OPENAI_API_KEY=your-restricted-openai-key
ELEVENLABS_API_KEY=your-spend-limited-elevenlabs-key
DEMO_PASSWORD=your-shared-demo-password
```

The template already contains the live provider selection, model names, voice ID, timeouts, and standard-output logging.

The required non-secret values are:

```text
PROVIDER_STACK=eleven
ROBOT_RADIO_DEBUG_LOG=stdout
OPENAI_LLM_MODEL=gpt-5.6-luna
OPENAI_FAST_LLM_MODEL=gpt-5.6-luna
OPENAI_FAST_SERVICE_TIER=priority
ELEVENLABS_MUSIC_MODEL=music_v2
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
ELEVENLABS_VOICE_ID=st7NwhTPEzqo2riw7qWC
```

Add the secrets to Preview only when a preview must call live providers. A preview without `DEMO_PASSWORD` fails closed.

Do not add provider keys with a `VITE_` prefix. Vite exposes variables with that prefix to browser code.

## Password behavior

The password exists only in the server environment. A correct password creates an opaque signed token.

The server stores that token in an HttpOnly, Secure, SameSite cookie for 30 days. The cookie does not contain the submitted password.

Changing `DEMO_PASSWORD` invalidates all existing access cookies. Redeploy the project after a password change.

This gate protects a private demo link. It is not a user-account system.

## Function duration

The server requests the maximum function duration that the selected Vercel plan permits. [Vercel documents the current limits here](https://vercel.com/docs/functions/limitations).

The normal track duration is 180 seconds. The Eleven Music provider timeout is 240 seconds.

One function invocation serves one WebSocket asset. The browser opens a new socket for each track, transition, or TTS cue.

## Production smoke test

1. Open the deployment in a private browser window.

2. Make sure that the password page appears before the onboarding flow.

3. Enter a wrong password. Make sure that the server rejects it.

4. Enter the correct password. Make sure that the onboarding flow appears.

5. Refresh the page. Make sure that the cookie restores access.

6. Start one station and listen through the first handoff.

7. Send a conversational message and an immediate musical redirect.

8. Examine the Vercel function log for provider or socket errors.

9. Examine the ElevenLabs dashboard for the expected key usage.

10. Open the built JavaScript files in browser developer tools. Search for each provider key.

No provider key must appear in a browser asset, response body, or client log.

## Credit exhaustion

ElevenLabs currently reports spent quotas as `insufficient_credits` or `quota_exceeded`. The server converts both responses into one safe listener message.

The station keeps existing playable audio when possible. It stops requesting usable new audio until the key quota resets or changes.

## Logs and listener privacy

Production logs go to standard output. The logger redacts configured secrets and fields with sensitive names.

Listener prompts and DJ copy remain in structured logs. Do not publish logs from a private listening session.

## Local Vercel test

Install the current Vercel CLI, then run the Services environment locally:

```bash
vercel dev -L
```

The normal `pnpm dev` command remains faster for daily work. It uses the same Node server and Vite proxy without Vercel routing.
