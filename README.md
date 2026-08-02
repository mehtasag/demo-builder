# Demo Builder

Record your screen and webcam in the browser, review the take, then share it
with a link. Optional Dropbox mirroring for the recordings you want off-machine.

Everything runs locally: recordings are captured with `MediaRecorder`, uploaded
to a local Express server, and streamed back with HTTP range requests. The
webcam background blur/replacement runs on-device with MediaPipe, and the noise
suppressor is a hand-rolled AudioWorklet. Nothing is sent anywhere unless you
configure Dropbox.

## Quick start

Needs Node 20+, Docker (for Postgres), and pnpm.

```bash
./dev.sh
```

That installs dependencies, starts a Postgres container, pushes the schema, and
runs the API on :8080 with the frontend on :5173. Copy `.env.example` to `.env`
first if you want to point at your own database or enable Dropbox.

```bash
./dev.sh --setup
```

Setup only, without starting the servers.

## Features

- Screen capture with an optional webcam bubble, composited into one recording
- Background blur or replacement (gradient presets or your own image)
- Mic chain: highpass -> spectral noise suppression -> compressor -> makeup gain
- Countdown, retake, and a review step before anything is uploaded
- Library with search, plus a combined local + Dropbox view
- Per-video visibility: `private`, `unlisted`, `public`
- One-way Dropbox mirroring with shared links that track visibility

## Stack

pnpm workspaces, TypeScript. React + Vite, Tailwind, wouter, TanStack Query on
the frontend. Express 5 + multer on the API. Postgres via Drizzle. The OpenAPI
spec in `lib/api-spec/openapi.yaml` is the source of truth for API contracts;
orval generates the react-query hooks and Zod schemas from it.

```
artifacts/web         React frontend
artifacts/api-server  Express API, Dropbox client, video streaming
lib/api-spec          openapi.yaml + orval config
lib/api-zod           generated Zod schemas and types
lib/api-client-react  generated react-query hooks
lib/db                Drizzle schema
scripts               dropbox-setup CLI
```

Anything under `src/generated/` is emitted by orval. Don't hand-edit it; change
`openapi.yaml` and re-run codegen:

```bash
pnpm --filter @workspace/api-spec run codegen
```

## Commands

```bash
pnpm run typecheck
```

```bash
pnpm run build
```

```bash
pnpm --filter @workspace/db run push
```

```bash
pnpm dropbox:setup
```

The Dropbox setup script walks the OAuth flow and writes the credentials into
`.env` with mode 600. Dropbox needs `account_info.read`, `files.content.write`,
`files.metadata.read`, `sharing.write` and `sharing.read`; enable them before
generating credentials or every call fails with `missing_scope`.

## Security note

There is no login. Visibility governs _shared links_, not the API:
`GET /videos` returns share tokens because the library needs them to build
playback URLs, so anyone who can reach the API can enumerate every recording.
Run it on localhost. Making this multi-user would mean adding auth and scoping
reads to an owner.

Within that boundary the link model does hold up: non-public reads require
`?t=<shareToken>` for both metadata and the stream and 404 without it, so a bare
`/watch/:id` URL reveals nothing. Switching a video to private mints a new
token, which is what actually kills links you have already sent.

## Notes

Things that took a while to get right, kept here so they don't get re-broken:

- **Don't drive the recording canvas from `requestAnimationFrame` alone.** rAF
  stops firing when the document is hidden, and screen recording means the user
  leaves the tab within seconds. `canvas.captureStream()` then repeats the last
  drawn frame and you get a still image with perfect audio.
  `lib/media/frame-clock.ts` ticks from the audio thread while hidden, because
  background timers are clamped to 1s and would be just as unusable.
- **Never store the browser-reported MIME type for an upload.** A MediaRecorder
  blob is typed `video/webm;codecs=vp9,opus`, and that unquoted comma breaks the
  multipart part header: busboy reports `text/plain`, which then gets served as
  the stream's Content-Type and no player can decode it. `resolveVideoMime()`
  derives the type from the filename and runs on read as well as write, so rows
  stored before the fix heal themselves.
- AudioWorklet modules can't contain `import` statements, and Vite's dev server
  injects one into anything it transforms. The worklets live in `public/` and
  are loaded by URL rather than bundled.
- `applyConstraints` replaces the whole constraint set, so `voiceIsolation` is
  folded into `micConstraintsFor()` instead of being applied as a second call.
- MediaPipe's mask polarity for single-label selfie models is undocumented, so
  `BackgroundProcessor` auto-detects it with a centre-vs-border vote over the
  first frames. Guessing wrong cuts out the person instead of the background.
- Uploads over 140 MB use a Dropbox upload session. `append_v2` rejects any
  offset that disagrees with what the server holds, so the chunk loop has to
  track byte offsets exactly.
- `Dropbox-API-Arg` is an HTTP header and must be ASCII, so non-ASCII filename
  characters are `\uXXXX`-escaped before sending.
- Upload uses raw XHR rather than a generated hook, to get progress events on
  large files. `/api/videos/:id/stream` is likewise not in codegen; the player
  builds that URL directly.

## License

MIT
