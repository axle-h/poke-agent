# Build and ship

Read when a build fails before it reaches Rust, and before touching the `Dockerfile`,
`.dockerignore`, `.github/workflows` or `k8s/`.

- pokered needs rgbds ≥ 1.0.0 and fails hard below it, so an old rgbds produces no ROM rather than a
  wrong one. The container pins the version.
- pokered's symbol names are upstream's to change. `poke-agent/build.rs` emits a constant per symbol, so a
  rename upstream is a compile error here, which is the point.
- `web/dist` must exist for the crate to compile: `rust-embed`'s derive fails on a missing folder.
  `.gitkeep` is committed and `vite build` copies it back. A checkout that never ran `pnpm run build`
  compiles and serves a page naming the two commands to run.
- The `minimumReleaseAge` cooldown in `pnpm-workspace.yaml` is checked on every install,
  `--frozen-lockfile` included. Raise it without regenerating the lock file and the container build
  fails while the dev loop keeps working. pnpm's own version comes from `packageManager` via corepack
  and is deliberately not repeated in the Dockerfile.
- The sha1 check on the assembled ROM is load-bearing: every fixture and every generated symbol is
  pinned to those bytes, and a ROM that merely assembles would fail deep inside the agent.
- `.dockerignore` excludes the submodule's build outputs with `**` patterns. A narrower pattern
  leaves `pokered/gfx/pics_red.o` in the context, and a stale object from a newer rgbds stops the
  build inside the container.
- The build stage copies each crate's manifest and `src/`, and `poke-core/build/`, rather than the
  crate directories whole, so an edit to a doc does not invalidate the cargo layer. The two SDL
  crates are never built but must still load: their real manifests keep `Cargo.lock` exact, and a
  generated `fn main() {}` stands in for each one's source, because cargo refuses a workspace member
  with no target at all.
- `CMD` is exec form so the binary is PID 1 and receives SIGTERM itself. That signal is what
  checkpoints the run; a shell in between loses everything since the last periodic checkpoint.
- Shutdown must not be axum's graceful one: the three streaming endpoints never finish, so it would
  wait for every viewer to close their tab and SIGKILL would take the checkpoint. The accept loop is
  selected against the signal, and the runtime's shutdown timeout is what ends the connection tasks.
- The build stamp is `ENV` in the runtime stage, below the `COPY` of the binary, and read at run time
  rather than with `env!()`. An `ARG` the cargo stage read would invalidate that stage every CI run,
  and `type=gha` caches layers rather than the cargo cache mounts — a full cold build each time. A
  binary nobody stamped reports `null`.
- `recreation.yml` builds `pokered-sdl` and tests `pokered` with no rgbds: the proof neither needs the cartridge.
- CI builds the image, smoke-tests the running container, then pushes. The push steps are main-only:
  a fork PR's token is read-only whatever `permissions:` asks for.
- `k8s/` is one replica, `strategy: Recreate`, a PVC, a 30 s grace period and no CPU limit, all for
  one reason: a run directory has exactly one writer, and a CFS quota shows up as the game running
  slow rather than as a resource error. The liveness probe proves the HTTP server only.
