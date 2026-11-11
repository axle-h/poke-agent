# The test suite

Read before running anything but `cargo test --release --workspace`, before regenerating a fixture,
and before adding a test. Two tiers: the default one, and `slow-tests`. Everything else is a name
filter or an environment variable.

## Commands

```bash
cargo test --release --workspace                        # the default tier, ~30 s
cargo test --workspace                                  # the same, dev profile, ~95 s
cargo test --release --workspace --features slow-tests   # everything, about an hour

# The pre-push gates. Run all four after every major work item.
cargo test --release -p poke-agent --features slow-tests --lib -- full_playthrough
cargo test --release -p poke-agent --features slow-tests --lib -- grand_tour --nocapture
cargo test --release -p pokered --features slow-tests
cargo test --release -p poke-agent --features slow-tests --lib -- lockstep:: harvest::

cargo test --release -p poke-agent --features slow-tests --lib -- hall_of_fame
cargo test --release -p poke-agent --features slow-tests --lib -- soak --nocapture
cargo test --release -p poke-agent --features slow-tests --lib -- coverage_walk --nocapture
cargo test --release --workspace --features slow-tests -- probe_ --ignored --nocapture
```

- Always `--release`: these tests emulate every frame. The dev profile works — `Cargo.toml` gives
  `gbc` and `poke-agent` `opt-level = 3` and every dependency `opt-level = 2`, without which the
  agent's frames overflow the harness's stack and the mock endpoint is slow enough to change what
  the emulator has done by the time a turn is answered.
- Agent and policy tracing goes to stdout, so add `--nocapture` when you want it.
- A filter that matches nothing prints `0 passed` and exits 0. Check the count.

## The gates

- `full_playthrough` (~235 s) is the scripted route walking the whole of Kanto to eight badges. It
  is the only test that proves the `PolicyStep` legs compose, and it is what keeps
  `--policy deterministic` honest.
- `grand_tour` (~20 min) walks a fresh save through the whole game through the deployed
  `LlmPolicy`, the worker and the wire, against an in-process mock endpoint, with every story gate
  live, a god party and a battle script so no battle costs a request. It asserts the completion
  ledger, every door and every map edge included, and never touches `PolicyStep`.
- `pokered --features slow-tests` (~15 s) is the recreation's own suite plus every harvested audio
  trace.
- `lockstep:: harvest::` (~7 min, bounded by `lockstep::synth::every_harvested_trace_matches_the_apu`)
  runs the recreation beside the cartridge: a lockstep feeds both the same buttons and compares, a
  harvest check calls a cartridge routine and compares answers. The filter takes both modules whole;
  their `#[ignore]`d harvesters, probes and cutters are not gates. `action_for_action_tour` is a
  lockstep outside the filter and in no gate.
- None replaces another, and the leg tier is not a substitute for any of them.
- `full_playthrough` also matches an animated twin, `full_playthrough_animated` (the route to Brock,
  ~25 s): battle animations on is what is served, and it spends the RNG differently.
- `native_full_playthrough` (~3 s, default tier) is `full_playthrough`'s route on the recreation,
  from a new game through the native agent; a stall saves the game for `probe_native_stall`.
- `native_grand_tour` (~200 s, slow tier, matched by the `grand_tour` filter) is `grand_tour` on the
  recreation at a served game's pace: the same brain and ledger through `NativeLlmRun`. The mock
  endpoint's latency moves the RNG, so it is not deterministic; a stall saves
  `target/test-artifacts/native-completion-run-stuck.pkrd` for `probe_native_stall` (`NATIVE_STALL`).
- A battle cell runs in both animation modes through `in_both_animation_modes!`.

## Fixtures

- Every leg snapshots its end state for the next leg to start from, and the write is a no-op unless
  `GB_REGEN_FIXTURES=1` — otherwise every run silently rewrites the next run's inputs. Regenerate in
  chain order, one leg at a time:
  `GB_REGEN_FIXTURES=1 cargo test --release -p poke-agent --features slow-tests --lib -- can_clear_ss_anne --exact`.
- `at-cerulean.bin` is the root every leg fixture descends from; `regen_at_cerulean_fixture` re-cuts
  it from a fresh save. A `PartyRef` that does not resolve waits for ever rather than failing, so a
  party change on the mainline shows up as a row of legs going red at once.
- Cut a fixture where the mainline stands — a leg that opens with `enter(X)` needs a root saved
  *inside* the previous building, not in the street — and where the party is healed.
- A fixture's name says where it is cut; a leg that walks further than its name is two tests and two
  fixtures (`vr1f-strength`, `vr2f-ladder`).
- The mid-leg cuts (`seafoam-b3f`, `vr3f-strength`) and the terrace cuts (`split-cerulean`,
  `split-celadon`, `pocket-route14`, `route21-islands`, `safari-west-shelf`) are not in the chain, so
  they are free to re-cut — but each carries *which tile*, and one re-cut somewhere tidier is a test
  of nothing. Each cutter asserts the property it has to keep.
- The four `branch-*.bin` are cut one decision before a choice that is exclusive per save, by the
  `regen_*` tests in `integration_tests::branch_points`. None may be cut inside a trainer's line of
  sight: a trainer walks up on the map's own tick, so such a state restores straight into a battle.
- The four battle fixtures are read twice over — by `stalls` for the jam each was cut in and by
  `battle_refusals` for the refusal each one contains — so a re-cut has to keep *which battle* as
  well as which jam.
- The `completion-*.bin` are a chain of their own, one per `completion_phase_*` test, each cut where
  the phase before it ended: re-cutting an early one invalidates every later one. `grand_tour`
  reads none of them; it plays every phase's steps from the fresh save.
- `soak-*.bin` are not in the chain and are re-cut wholesale by `regen_soak_checkpoints`.
- A phase that sticks saves where it stuck to `$TMPDIR/<name>-stuck.bin`, and `dump_fixture_states`
  reads any state named in `GB_DUMP_STATES` (`:`-separated) instead of the committed chain: map,
  party, bag, dex count and the current box, which is where a re-ordered route's answers are.
- `every_committed_fixture_decodes` (default tier, in `poke-agent`) loads all of them, so a save-state layout
  break fails in two seconds rather than an hour into `slow-tests`. Every `.bin` in
  `poke-agent/src/pokemon/data/` must therefore be a save state; other binary fixtures go elsewhere.
- Every fixture is a DMG capture. On an SGB it reads `wOnSGB` and `wDefaultPaletteCommand` clear, so
  a lockstep boots to `LoadSGB` first and sets both (`lockstep/mod.rs` `on_sgb`).
- `emulator_tests::bench_pokemon_red_throughput` is the yardstick for `gbc`'s speed; how to profile
  it is in `gbc`'s `docs/emulator-performance.md`.

## Writing a test

- A leg's game-time budget is sized to encounters, not walking. An `enter_at` naming the wrong
  landing only fails from a cold fixture, because the mainline re-routes over a world graph the
  leg's fresh agent has never observed.
- A helper that reads published events after a `pump_*` must use `events_until`, not `try_iter`:
  `try_iter` returns what has arrived, which is a race.
- `soak` is gated as a module rather than with `#[ignore]`, so it never appears in the ignored list —
  that list is a backlog of blocked tests and a fuzzer is not one.
- Every `#[ignore]` names its reason in a few words. The probes, the fixture cutters and the
  benchmarks are all `#[ignore]`d under `slow-tests`, because their pass/fail is not a signal.
- A test whose pass/fail *is* a signal must never be `#[ignore]`d, whatever it costs: the attribute
  hides it from the slow tier as well as the default one, and from the pre-push gates, which are
  name filters. The thirteen `completion_phase_*` tests were ignored on the grounds that they are
  slow, and three of them sat red on main for days with every gate green. Gate on the module's
  feature instead, as `completion_run` and `soak` do.
- `gbc`'s tests, in its own repository, run on its own test ROMs, never Pokémon Red; a test of the
  emulator against the cartridge goes in `poke-agent/src/emulator_tests.rs`.
