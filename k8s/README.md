# Kubernetes deployment

k3s. The ingress assumes traefik and cert-manager, and the volume assumes the `local-path`
provisioner. One pod: the emulator, the agent and the web server are one process, and a run's whole
state is one directory on one volume.

`secret.example.yml` lives outside `gb/` because `gb/` is applied as a directory, and placeholders
there would blank the real API key and admin token. Copy it to `gb/secret.axh.yml` (gitignored) and
fill it in; it is applied with the rest.

Set `GB_POLICY` and `GB_MODEL` in `gb/configmap.yml` and the hostname in `ingress.yml`, then apply
`redirect-http-https.yml`, `./gb` and `ingress.yml` in that order. The namespace must be `gb`: the
ingress names the redirect middleware as `gb-redirect-http-https@kubernetescrd`, and traefik resolves
that by namespace.

## The run

The binary resumes by default: it continues the newest run under `/runs` whose save state loads, so a
rollout, a deleted pod or a node reboot all pick the playthrough up where it was. SIGTERM writes that
checkpoint, within the 30 s grace period.

With `GB_ADMIN_TOKEN` set, `/reset-game` starts the game over from a browser and
`POST /api/new-run` does it from a script (`new-run.sh`); `POST /api/clear` keeps the run and throws
away only what the model remembers of it. All three 404 while the token is unset or blank. A clear
lands on the model's next turn, so a run parked on a spent quota is cleared when the quota reopens.

The volume grows on its own: a run that finishes the game is archived to `/runs/hall-of-fame/` and
the next run starts automatically. Nothing prunes the archive.

## What plays the game

`GB_POLICY` in `gb/configmap.yml`: `llm`, `random` or `deterministic`. A `--policy` flag on the
container's args overrides it, for a one-off.

A ConfigMap edit restarts nothing: `envFrom` is read once at process start, so apply, then
`kubectl -n gb rollout restart deploy/gb`. When moving to or from `--policy` on the args, apply the
ConfigMap first, or the pod that rolls reads the old one.

`random` and `deterministic` need no API key and spend nothing, and both exercise the whole stack.
`deterministic` starts in Red's bedroom, so it wants a game at the beginning: apply, restart, then
`POST /api/new-run`. Resumed onto a mid-game save it replays a route the world has already moved past.

## The image

`ghcr.io/axle-h/poke-agent:latest`, published on every push to main after a smoke test that proves the
image serves the SPA, decodes the cartridge and emulates. Every build is also tagged with its commit,
which is the tag to pin or roll back to. `imagePullPolicy: Always` means a `rollout restart` picks up
the newest build; nothing watches the registry, because a rollout interrupts a live playthrough.

GHCR creates a package private regardless of the repository's visibility, so the first CI push
succeeds and the cluster then fails to pull with `denied`. Make it public once, in the package's own
settings.
