# Contributing

Robot Radio Infinity is an experimental live-audio application. Small, focused changes are easier to test and hear.

## Product scope

Make active product changes in `apps/eleven`.

The code in `apps/google` is a frozen reference. Change it only when a task names the Google implementation.

Do not extract a shared package because two files look similar. Share code only after both orchestration models prove the same behavior.

## Local work

1. Install Node.js 24 and pnpm 10.

2. Run `pnpm install`.

3. Copy `apps/eleven/.env.example` to `.env`.

4. Keep `PROVIDER_STACK=mock` for normal development.

5. Run `pnpm dev`.

6. Run `pnpm verify` before a pull request.

## Paid provider calls

Do not use live providers for visual or reducer work. The fixture corpus covers presentation timing without new ElevenLabs generations.

Paid profiler commands require `--confirm-cost`. State the expected provider before you run one of these commands.

Never commit `.env`, provider keys, `.vercel` project files, private prompts, or production debug logs.

## State-machine changes

Keep model output advisory. The reducer must own playback, fades, cancellation, mic windows, and stale-request rejection.

Add reducer tests for new events and race behavior. Add provider tests for request shapes and normalized errors.

## Pull requests

Explain the listener-visible result first. Then name the affected state-machine invariant and the tests that cover it.

Keep generated audio out of a pull request unless it belongs to the documented golden fixture corpus.
