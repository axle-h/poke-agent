# CLAUDE.md

@README.md

**The README is imported above; do not re-read it and do not repeat it here.** It has what the
project is, the crate map, the policy/agent model, the run directory, the endpoints, the environment
block, the build and the deployment.

What it leaves out — the invariants and the traps, nearly every one learned by breaking something —
is in seven short documents under `docs/`, one per area. **They are not loaded automatically.** Read
the one for the area you are about to touch, before touching it. Each is a list of rules, and each
rule names the comment in the code that carries the argument, so the code stays the source of truth.

## Rules of the road

- **Always `--release`.** The integration tests emulate every frame. `cargo test --release
  --workspace` is the default tier, about 30 s warm; every other command is in
  [test-suite](docs/test-suite.md).
- Agent and policy tracing goes to stdout, so add `--nocapture` when you want it.
- **The emulator is `gbc`, from crates.io**; its source and its docs live in `axle-h/gbc`. To change
  both at once, put `[patch.crates-io] gbc = { path = "../gbc/gbc" }` in `.cargo/config.toml`, which is
  gitignored, and release `gbc` before pushing anything here that needs the change.
- **Run the four pre-push gates after every major work item and before pushing**: `full_playthrough`,
  `grand_tour`, `pokered`'s slow tier and `poke-agent`'s `lockstep::`/`harvest::` tier, commands in
  [test-suite](docs/test-suite.md). They gate different things — the scripted route through the whole
  of Kanto, the deployed `LlmPolicy` walking the whole game from a fresh save with every story gate
  live, and the recreation against the cartridge — and the leg tier substitutes for none of them.
- **No em dashes in the strings the *agent* generates**: `AgentEvent`'s `Display`, `MetaTile`'s, a
  `Notice`, `learnset::teach_refusal`. Those go to the page as well as to the model and are assembled
  a fragment at a time, where a dash reads as punctuation the writer did not choose. The rule is
  deliberately this narrow: the prompt, the tool descriptions and every action-menu row use em dashes
  by design.
## Keeping it tidy

The repository was cleaned up deliberately and it is worth keeping that way. Five rules.

- **A plan lives in `docs/PLAN-<name>.md` and nowhere else.** It is a scratchpad: excluded from git
  by `.git/info/exclude`, and deleted when its last task is done. Nothing outside it may refer to it
  or to anything in it — **not a task id, not a phase number, not a section number, not a workstream
  letter**. A comment reading "W6b" or "§9" or "Phase C" names a file nobody can open, and every one
  of those had to be hunted down and deleted once already.
- **Let the code say it, and say the rest once.** Prefer a name that needs no comment. A comment
  earns its place by carrying a constraint the code below obeys and nothing else pins — and then it
  is one or two sentences, in plain words, where the constraint is. No history, no dates, no
  measurements, no "used to", no argument for a decision already taken. A block over a dozen lines is
  a design document in the wrong place; the exception is a wire or file-format table.
- **A new invariant goes first into a comment on the code it constrains, then as one line in the doc
  for its area pointing at it.** The docs are indexes, not the argument — and a rule a test already
  pins does not need a line at all.
- **`README.md` and `CLAUDE.md` stay slim.** The README is for someone who has not seen the project;
  this file is the map. Neither is the place for a design essay. If something permanent genuinely
  does not fit either, make a document for it under `docs/` and add one row to the table below — but
  reach for that last, after "delete it" and "one line where the code is".
- **Terse wins.** When a paragraph and a sentence say the same thing, the sentence is correct.

## Where the rest of it lives

| Doc | Read before |
|---|---|
| [pokemon-agent](docs/pokemon-agent.md) | `poke-agent/src/pokemon/{agent,policy,text,tile_map,actions}.rs`, `AgentEvent` or any `Display` it goes through, the SPA's `useEventStream.ts` |
| [llm-turn-loop](docs/llm-turn-loop.md) | anything under `poke-agent/src/llm/`, `poke-agent/src/pokemon/llm_policy.rs`, any change to what the model is sent |
| [web-streams](docs/web-streams.md) | `poke-agent-web/src/web/{video,audio}*`, the SPA's `{stream,video,audio}.ts` |
| [rom-graphics](docs/rom-graphics.md) | `poke-core/src/{gfx,rom_gfx,badge_gfx,mon_gfx,map_gfx,font}.rs`, `poke-core/build/gfx.rs`, `poke-agent-web/src/web/sprites.rs`, `poke-agent/src/llm/map_image.rs` |
| [run-lifecycle](docs/run-lifecycle.md) | `poke-agent/src/run/`, `poke-agent-web/src/host.rs`'s new-run and completion seams, the three admin endpoints |
| [test-suite](docs/test-suite.md) | running anything but the default tier, regenerating a fixture, adding a test |
| [build-and-ship](docs/build-and-ship.md) | a build that fails before it reaches Rust, the `Dockerfile`, `.dockerignore`, `.github/workflows`, `k8s/` |
