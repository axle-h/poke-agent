# poke-agent

A platform for an LLM to play Pokémon Red on a Game Boy emulator written in Rust — entirely
through text, with no screenshots required.

The emulator half is [`gbc`](https://github.com/axle-h/gbc), a real one in its own repository and
on crates.io: DMG, Game Boy Color and Super Game Boy, accurate enough to pass the standard
hardware-compatibility test ROMs. The other half reads the game's own memory — party, bag, map, battle state, on-screen text — using
symbols lifted from the [pokered](https://github.com/pret/pokered) disassembly, and drives the game
by synthesising joypad input. What the model sees is a description of where it is and what it can
do; what it sends back is an action, not a button press.

It runs headless, serves its own web UI, and keeps a run going across restarts.

```
docker run -d -p 8080:8080 -v gb-runs:/runs \
  -e OPENAI_API_KEY=sk-… -e GB_MODEL=gpt-5 ghcr.io/axle-h/poke-agent:latest
```

Then open <http://localhost:8080> and watch it play.

## What works

**The game.** The agent layer plays Pokémon Red from a fresh save to the credits, because the
emulator runs at roughly 50× real time with the agent on top: the scripted route reaches eight badges
in about four minutes of wall clock and the Hall of Fame in about twenty-six.

**The LLM layer** drives that same agent over any OpenAI-compatible API, or Anthropic's own. Its
end-to-end tests run against a mock server, so what is proven here is the plumbing rather than any
particular model's ability to finish the game.

## Quick start

The container is the shortest path and needs nothing installed — see above. To build it yourself you
need a Rust toolchain, [rgbds](https://rgbds.gbdev.io) ≥ 1.0.0 to assemble the cartridge, Node with
pnpm for the browser UI, and SDL2 if you want the desktop window.

```shell
git clone --recursive https://github.com/axle-h/poke-agent.git && cd poke-agent

# 1. The cartridge. `pokered.gbc` is embedded into the binary at compile time and `pokered.sym` is
#    parsed by build.rs, and neither is in git. `pokered` and `pokered-sdl` need neither.
make -C vendor/pokered pokered.gbc

# 2. The browser UI. `web/dist` is baked into the binary, so this comes before cargo.
cd poke-agent-web/web && pnpm install && pnpm run build && cd ../..

# 3. The binaries.
cargo build --release --workspace
```

```shell
# The web UI, played at random — no API key, no spend. http://localhost:8080
cargo run --release -p poke-agent-web -- --policy random

# The web UI, playing the scripted route the full playthrough test plays, at 1x. Also free.
cargo run --release -p poke-agent-web -- --policy deterministic --new-run

# The web UI, played by a model.
OPENAI_API_KEY=sk-… GB_MODEL=gpt-5 cargo run --release -p poke-agent-web

# The SDL desktop window: the cartridge and the recreation side by side, from your keyboard, or
# both playing the grand tour together (`T`).
cargo run --release -p poke-agent-sdl
```

`poke-agent-web` **resumes** by default: the newest run under `$GB_RUN_DIR` (`./runs`) is continued
in place, plan and all. `--new-run` starts the game over in a directory of its own — or, on something
already running, opening `/reset-game` does the same without a restart.

A new game names its trainer after whoever is about to play it, in the seven characters Gen 1 allows:
`AI` for any model, `HUMAN` at the desktop, something drawn from a list under `--policy random`. The
full model id lives in `meta.json` and the hall-of-fame ledger, where it is unambiguous.

## How the model plays

`PokemonAgent` advances the emulator 20 ms at a time, works out from the game's memory what kind of
decision is on the table, and asks a `Policy`. The trait is non-blocking — every method returns
`Option` — so the emulator keeps running while the model thinks, which is the property everything
else is built around.

`LlmPolicy` turns each decision into a conversation turn ended by one action tool, `choose_action`,
whose id comes from the menu that kind of decision carries. Everything else is a small virtual
filesystem behind `read_file`, `write_file` and `edit_file` — the party, the bag, the map picture,
the walkthrough, the way to any map walked, the plan, the battle script — so the four tools are the
same on every request and a prompt cache keyed on them never breaks. The turn is built to make
reading unnecessary: location, party, money, badges, what is on screen and the menu of what can be
done are all in the request. An action the game would refuse is not in that menu, because the
cartridge refuses a missing badge by dropping back to the menu it came from and the agent has no
exit condition for that — but the turn says once that the trees and boulders are there and what
would move them, since a model shown no way forward invents reasons why.

Three things cut what a run spends. On an overworld or mart turn one reply may carry up to four
`choose_action` calls from the same menu, each re-resolved against the live game when its turn
comes, so anything that stops one stops the rest. A walk an interrupting battle stopped is taken up
again once it is over, unless a party member fainted in it. And `battle-script.rhai` lets the model
write the mechanical part of a battle down once, as a short [Rhai](https://rhai.rs) program
evaluated on the emulator thread inside `pick_battle_action` — no request, no round trip, no
latency — which can hand any one turn back with `battle.ask()`. The sandbox has no file, process or
network API, the engine caps operations, time, sizes and depth, a new script is put through seven
made-up battles before it is armed, and one failure disarms it for the run. After every scripted
battle the model gets a report, because a scripted battle is otherwise invisible.

Where a decision is genuinely one decision it costs one: `cut down the tree at (5, 8)` walks up and
cuts, and a boulder row is the whole goal — `the boulder at (5, 15), to push it onto the switch at
(17, 13)` arms Strength, walks, shoves, walks round and keeps going. The row names the boulder as
well as the target, because a floor with two holes has exactly one boulder that can reach each.

The model keeps a **plan**, `plan.md`, free text it writes and edits itself, drawn on the page with
every earlier version a step back. It is the only thing it writes that survives a compaction, and it
is not sent with the turn: each turn ends on a one-line reminder that it is there, louder on the
turn after a compaction, a restart or a clear. The conversation survives a restart too:
`history.json` is rewritten each turn, and `conversation.jsonl` is appended to and never rewritten,
so it keeps every message a compaction replaced.

Every tool that ends a turn takes a required `summary` in the model's own words, because nothing
else it says about a turn survives the turn. A file written under `issues/` is where a wrong menu
goes and deliberately does **not** end the turn: the earlier escape hatch was over-used precisely
because it was the one way to finish a turn without choosing. `map.png` answers with a **picture** —
the whole map from the cartridge's own tile graphics, NPCs where they stand and facing where they
face, warps and edges labelled, unreachable ground dimmed, a coordinate ruler — rendered on the
worker thread.

Anything the model does not decide, the agent handles: dialogue advanced, menus navigated, paths
computed from a graph of all 248 maps built out of the ROM's own headers. A **watchdog** covers the
one failure nothing else can see, the agent reaching no decision point at all. And when the quota
runs out the run **pauses rather than fails**: a dated 429 is not something to retry, so `gb` stops
asking and stops the emulator with it, and the same question is put again to a world that has not
moved. An endpoint that refuses outright three times running, a spent credit or a dead key, is
paused the same way, for longer each time.

The other policies are `RandomPolicy`, `ConsolePolicy` (stdin) and `DeterministicPolicy`.
`--policy deterministic` is the last one served rather than tested, on the same queue, seed and fresh
save `full_playthrough` runs — the only way to watch the game being *played well* rather than felt
out. It reaches the Hall of Fame with one Squirtle doing all the fighting and two Pokémon that never
fight, because an HM is a permanent move slot and experience is cubic: one fighter at lv85 is a third
of the experience of three at lv75 and wins more comfortably.

## The run directory

Everything a run needs is one directory, `$GB_RUN_DIR/<run-id>/`:

| | |
|---|---|
| `meta.json` | run id, which game, model, when it started |
| `state.gbst` | the save state — the emulator, exactly as it was |
| `sram.bin` | the cartridge's battery-backed save |
| `transcript.jsonl` | every event, appended; what `/api/history` replays into a page that just loaded |
| `plan-history.jsonl` | every version of the model's own plan, the last being the plan — what outlives a compaction |
| `battle-script-history.jsonl` | every version of the program deciding its battle turns, the last being the one in use |
| `battle-script-state.json` | whether that program is still armed, why it stopped, and how many turns it decided |
| `scripted-progress.json` | how far along the scripted route this run is — `--policy deterministic` only |
| `history.json` | the live conversation, signed thinking and all, rewritten each turn — what a restart resumes on |
| `conversation.jsonl` | every message ever sent, appended; what a compaction replaced |
| `moments.jsonl` | the run's turning points — badges, bosses, new species, evolutions, black-outs, the Hall of Fame — each naming its save state |
| `moments/` | those save states, each carrying the screen it was taken on |
| `issues/` | one directory per issue the model writes: its file name and message, the screen, a save state, the conversation |
| `press-buttons/` | the same, for the watchdog turn's escape hatch |

Copy that directory and the run moves with it. `gb` checkpoints periodically and on the way out, so
a restart, a rollout or a reboot resumes rather than starts over.

Beside the runs is `$GB_RUN_DIR/hall-of-fame/`: a copy of every run that has finished the game and an
append-only `ledger.jsonl`. A win is one byte — `wNumHoFTeams`, incremented on the ceremony's **first
frame**, before the parade, the credits and the game's own soft reset — so that is where the record
is taken, with the winning party still in memory. `/api/leaderboard` ranks it **fastest by in-game
time**, the one figure that survives a resume without bookkeeping.

## The web UI

`poke-agent-web/web/` is a Vite + React + TypeScript SPA, embedded into the binary by `rust-embed`
and served by the same process that runs the emulator. Sixteen read-only endpoints and three that are
not:

| | |
|---|---|
| `/api/events` | SSE: status heartbeat, published on change, plus agent events as they happen |
| `/api/video` | binary: a keyframe, then 8×8 block deltas, deflated per connection — about 21 kbit/s |
| `/api/audio` | binary: a header, then raw Opus packets — 24 kbit/s, and nothing until a viewer asks |
| `/api/history?since=` | the transcript backlog, so a page that just loaded is not empty |
| `/api/plan-history?limit=&before=` | the plan's versions, a page at a time back from the newest, for the plan panel |
| `/api/battle-script-history?limit=&before=` | the same for the battle script |
| `/api/leaderboard?limit=` | the runs that have finished the game, fastest first |
| `/api/moments` | the run's turning points, for the Highlights pane |
| `/api/moments/{n}/screen.png` | the screen a moment was taken on, read out of its save state |
| `/api/badges.png` | the eight gym badges, decoded from the cartridge's trainer-card graphics |
| `/api/pokemon/{dex}/front.png` | one Pokémon's battle sprite, from the disassembly's picture |
| `/api/tool-image/{seq}/image.png` | the picture a tool answered with, while it is still held |
| `/favicon.png` | the overworld Poké Ball, ditto |
| `/icon.png` | the same ball at 192 px, for a phone's home screen |
| `/api/healthz` | liveness |
| `/version` | which build is running: crate version, build date, branch, short commit |
| `/reset-game` | start the game over, in place — HTTP Basic, off unless `GB_ADMIN_TOKEN` is set |
| `POST /api/new-run` | the same thing for a script, with an `X-GB-Token` header |
| `POST /api/clear` | keep the run, wipe what the model remembers of it — same header |

The log is a card per turn: the model's own sentence first, then what it did, then what the game
said. Story shows that and the run's moments; Everything adds each file it read and each thought,
opening onto what was asked and what came back. A party slot opens onto the mon's moves and stats. Under the plan is the battle script, because `armed` is a live
fact and a scripted battle is otherwise invisible from outside.

**No graphics are committed to this repo.** The badges, the sprites, the favicon and every tile,
person and letter in the map pictures come from the disassembly: its `.png` sources, converted at
build time as its Makefile would, or the ROM assembled from them.

The screen is 8×8 block deltas deflated once across the connection, about 21 kbit/s against the 565
the first SSE version cost; the sound is Opus at 48 kHz, off until you press the speaker, and not
compressed on top. Both are measured rather than assumed — [`docs/web-streams.md`](docs/web-streams.md)
has the numbers and every alternative they beat.

The three admin endpoints are **off unless `GB_ADMIN_TOKEN` is set** and 404 rather than 403 when it
is not: an endpoint that resets the game should not advertise itself to whoever scans for it. Nothing
links to `/reset-game`, and a Basic challenge is the browser's own dialog, so the SPA holds no token.
`POST /api/clear` is the opposite trade, for a run that has talked itself into a corner: the game,
the save, the transcript and the battle script carry on, and only what the model remembers goes.

For a hot-reload loop, run `poke-agent-web` on :8080 and `pnpm run dev` in `poke-agent-web/web/`,
which proxies `/api` to it. `GB_WEB_DEV=1` reads `web/dist` from disk instead of the embedded copy.

## Configuration

All environment variables, never flags — the API key has to be one, so the rest followed it.
`poke-agent-web --help` lists them and `poke-agent/src/llm/config.rs` documents them.

| | |
|---|---|
| `OPENAI_API_KEY`, `GB_MODEL` | required for `--policy llm` |
| `OPENAI_BASE_URL` | any OpenAI-compatible endpoint |
| `GB_PROVIDER` | `openai` (default), or `anthropic` for the Messages API, which reads `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` instead |
| `GB_CONTEXT_LIMIT` | the context window, in tokens — set it to the model's, not the default 128 k |
| `GB_COMPACT_ABOVE` | how full it gets before the turn loop compacts (`0.85`) |
| `GB_TEMPERATURE` | sent when set; unset leaves it to the model |
| `GB_MAX_TOOL_STEPS` | the most completions one turn may take (`12`) |
| `GB_REQUEST_TIMEOUT_SECS` | how long an endpoint may take to answer (`180`) |
| `GB_MAX_TOKENS` | ceiling on one completion (`8192`); `0` removes it |
| `GB_REASONING_EFFORT` | sent as `reasoning_effort`, or Anthropic's `output_config.effort`, when set — `none` turns thinking off entirely |
| `GB_REASONING_MAX_TOKENS` | sent as OpenRouter's `reasoning.max_tokens` instead, where a model still thinking at twice it is cut off, or as Anthropic's `budget_tokens` |
| `GB_STUCK_TIMEOUT_SECS` | the watchdog (`300`); `0` turns it off |
| `GB_POLICY` | what plays the game: `llm` (default), `random` or `deterministic`; `--policy` wins |
| `GB_RUN_DIR` | where runs live (default `./runs`) |
| `GB_PORT`, `GB_STATUS_HZ` | the server |
| `GB_AUDIO_BITRATE` | the Opus stream's target, bits/s (`24000`); `0` turns sound off entirely |
| `GB_HARDWARE` | which Game Boy the cartridge runs on: `dmg` (default) or `cgb` |
| `GB_GAME` | what is played: `emulated` (default), or `native`, the recreation, whose run keeps `game.pkrd` and its save slots in `slots/` in place of `state.gbst` and `sram.bin` |
| `GB_RESTORE_HISTORY` | resume a run's conversation as well as its save (`1`); `0` starts it over |
| `GB_ADMIN_TOKEN` | enables the three admin endpoints; unset means all three 404 |
| `GB_REGEN_FIXTURES` | let a test overwrite the fixture it snapshots; off by default |

The game's own OPTION menu is held by the host rather than configured: a served run plays fast text
and SET style with battle animations on, a headless test the same with them off.

## Deployment

The `Dockerfile` builds everything from a bare checkout in four stages — rgbds and the cartridge, the
SPA, the crate, then a small image of which the binary is under 7 MB. `ghcr.io/axle-h/poke-agent` is
published by CI on every push to main, after a smoke test that proves the image serves and emulates.

```shell
OPENAI_API_KEY=sk-… GB_MODEL=… docker compose up -d
docker compose run --rm --service-ports gb poke-agent-web --policy random   # no API key, no spend
curl -s https://your-host/version
# → {"version":"1.0.0","build_date":"2026-08-12T14:22:33Z","branch":"main","commit":"a1b2c3d"}
```

The crate version comes from `Cargo.toml`; the other three are stamped in by CI as build args and
read from the environment rather than compiled in, because the timestamp changes on every build and
an `env!()` would put it in the cargo layer's inputs. `k8s/` has manifests for k3s — see
[`k8s/README.md`](k8s/README.md).

## The crates

```
poke-core/        Pokémon Red as data: species, moves, items, maps, pictures and text, from its source
pokered/          Pokémon Red recreated natively, on `poke-core` alone; in progress
poke-agent/       the Pokémon layer — agent, policies, LLM turn loop, the run directory
poke-agent-web/   the axum server, the video and audio codecs, and the SPA
poke-agent-sdl/   the desktop window
pokered-sdl/      the native game in a window, from the keyboard
vendor/           pokered, the disassembly, as a submodule
```

`gbc` (from crates.io), `poke-core` and `pokered` ← `poke-agent` ← the two binaries, `poke-core` ← `pokered` ←
`pokered-sdl`, and nothing else: neither `poke-core` nor `pokered` knows about `gbc`. `poke-agent` holds
the lockstep tests and harvesters that run the two side by side. Each crate has one feature, `slow-tests`.

| Concern | Choice | Reason |
|---|---|---|
| Symbol codegen | `poke-agent/build.rs` + `pokered.sym` | Every RAM/ROM symbol becomes a typed pointer constant, so an address that moves upstream is a compile error |
| Audio transport | raw Opus over chunked binary framing | No container and no muxer: WebCodecs takes bare packets, and an `OpusHead` would put the decoder into Ogg mode. Not deflated either, at +16.6% measured |
| Video transport | chunked binary + `flate2` | Not a WebSocket: nothing is bidirectional, and a plain response needs no upgrade, no ping/pong and no second reconnection story. The compression is the protocol rather than a `Content-Encoding`, so no proxy can buffer and re-encode it |

## Tests

```shell
cargo test --release --workspace                        # the default tier, ~30 s
cargo test --release --workspace --features slow-tests   # everything, about an hour
```

Always `--release`: these tests emulate every frame. The suite is tiered by how much *game time* a
test costs, since that is the only thing that matters to its wall clock. Four runs are pre-push
gates and none replaces another: `full_playthrough`, the scripted route through the whole of Kanto;
`grand_tour`, a fresh save walked through the whole game — every door, every map edge, every story
gate — through the deployed `LlmPolicy`; and the recreation's slow tier and its lockstep against the
cartridge.
[`docs/test-suite.md`](docs/test-suite.md) has the commands, the fixture chain and the regeneration
recipe.

## A note on licences

There is no top-level `LICENSE` here yet.

Three dependencies are worth naming, and none constrains anything: `gbc` is MIT OR Apache-2.0, `opus-rs` is BSD-3-Clause, a
Rust port of libopus, which is BSD-3 itself, and `rhai` is MIT OR Apache-2.0. Both are named because this paragraph is the list, and a
dependency absent from it is one nobody checked. Nor does the desktop window's
`AdwaitaMono-Symbols.ttf`, five glyphs Roboto lacks cut from Adwaita Mono, which is SIL OFL 1.1 with
no reserved name; its licence sits beside it.

The ROM is not distributed and cannot be — `vendor/pokered/` is a submodule of the disassembly
project, and the cartridge is assembled locally from it.
