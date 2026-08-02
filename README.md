# Demo Builder

Record your screen and webcam in the browser, review the take, and hand someone
a link to the product you are building — one click, no export step.

![Demo Builder recorder](readme_image_1.png)

## System design

The browser does the media work; the server is a thin store-and-stream tier.

```
getDisplayMedia + getUserMedia
  -> canvas composite (screen + webcam bubble, MediaPipe segmentation)
  -> Web Audio mic chain (mixed with system audio)
  -> MediaRecorder -> single WebM blob
  -> XHR multipart upload -> Express 5 + multer -> file on disk
                                                -> metadata row in Postgres
  -> playback via HTTP range requests
  -> optional mirror to Dropbox -> shared link
```

Capture is client-side by design: compositing, segmentation and audio processing
all run on-device, so the server never transcodes and scales with disk and
bandwidth rather than CPU. The recording canvas is driven by a clock ticked from
the audio thread rather than `requestAnimationFrame`, which stops firing the
moment the user leaves the tab — the normal case for screen recording.

Contracts are generated, not hand-written: `lib/api-spec/openapi.yaml` is the
source of truth and orval emits the Zod schemas and react-query hooks from it.
Anything under `src/generated/` is output — change the spec and re-run codegen.

```
artifacts/web         React + Vite + Tailwind frontend
artifacts/api-server  Express API, Dropbox client, range streaming
lib/api-spec          openapi.yaml + orval config
lib/api-zod           generated schemas          lib/db   Drizzle schema
lib/api-client-react  generated hooks            scripts  dropbox-setup CLI
```

pnpm workspaces, TypeScript throughout. Postgres via Drizzle.

## Noise cancellation

No third-party service or package — it is built directly on the Web Audio API,
in two layers that the four profiles (Raw, Standard, Strong, Studio) tune
together:

1. **The browser's own audio processor**, via `getUserMedia` constraints:
   `echoCancellation`, `noiseSuppression`, `autoGainControl`, plus Chromium's
   `voiceIsolation` on Studio. Tuned for conferencing — aggressive, low latency,
   not adjustable.
2. **A custom AudioWorklet** (`artifacts/web/public/worklets/noise-suppressor.js`)
   running a spectral suppressor on the audio thread: 1024-point STFT with a
   sqrt-Hann window at 75% overlap, per-bin noise tracking with an asymmetric
   follower, a decision-directed (Ephraim–Malah) a-priori SNR estimate feeding a
   Wiener gain, a spectral floor and 3-tap frequency smoothing to kill musical
   noise, and an optional broadband gate for pauses. About 18.7 ms of latency at
   48 kHz, and bypass is COLA-exact so toggling it cannot colour the signal.

The graph is `source -> highpass -> suppressor -> compressor -> makeup gain ->
analyser`. Its shape is fixed and profile switches only retune parameters, so
changing profiles mid-session never clicks or drops audio.

Background blur and replacement use `@mediapipe/tasks-vision` for on-device
selfie segmentation — the only third-party media dependency.

## Dropbox sharing

The point of the integration: finish a take and the viewer gets a working link,
without anyone installing anything. Dropbox holds the file and serves the link;
the app only orchestrates.

There is no Dropbox SDK — the API server calls the v2 HTTP endpoints directly.
Auth is the OAuth refresh-token grant, exchanged for a short-lived access token
that is cached until just before it expires, so setup happens once and the token
never goes stale. Uploads under 140 MB go in a single request; larger ones use an
upload session in 16 MB chunks, tracking byte offsets exactly because
`append_v2` rejects any offset that disagrees with the server.

Saving a recording that is public or unlisted mirrors the file and calls
`sharing/create_shared_link_with_settings` — that URL is the shareable link.
Visibility is the control surface: switching a video back to private revokes the
Dropbox link and mints a new local share token, which is what actually kills
links you have already sent. Mirroring is one-way; Dropbox is a delivery
surface, not a source of truth.

## Quick start

Needs Node 20+, Docker (for Postgres), and pnpm.

```bash
./dev.sh              # install, start Postgres, push schema, run both servers
./dev.sh --setup      # setup only
```

The API runs on :8080 and the frontend on :5173, shifting up if those ports are
taken. `dev.sh` runs its own Postgres container unless you set `DATABASE_URL` in
`.env`, in which case it uses exactly that server and creates nothing.

```bash
pnpm dropbox:setup    # walks the OAuth flow, writes credentials to .env (mode 600)
```

Enable `account_info.read`, `files.content.write`, `files.metadata.read`,
`sharing.write` and `sharing.read` before generating credentials, or every call
fails with `missing_scope`.

## Security note

There is no login. Visibility governs shared links, not the API: `GET /videos`
returns share tokens, so anyone who can reach the API can enumerate every
recording. Run it on localhost. Within that boundary the link model holds —
non-public reads require `?t=<shareToken>` for both metadata and the stream and
404 without it. Multi-user would mean adding auth and scoping reads to an owner.

## License

MIT
