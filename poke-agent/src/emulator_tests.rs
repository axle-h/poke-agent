//! `gbc` against the one commercial cartridge this workspace builds: what its own test ROMs can
//! only approximate.

use gbc::cycles::MachineCycles;
use gbc::game_boy::GameBoy;
use gbc::lcd_palette::{DMGColor, LcdColor};
use gbc::ppu::{LCD_HEIGHT, LCD_WIDTH};
use crate::pokemon::roms::POKERED;

const AT_CELADON: &[u8] = include_bytes!("pokemon/data/at-celadon.bin");

/// Every committed fixture must decode with the *current* section layout.
#[test]
fn every_committed_fixture_decodes() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src/pokemon/data");
    let mut checked = 0;
    let mut failures = Vec::new();

    for entry in std::fs::read_dir(dir).expect("fixture directory") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let bytes = std::fs::read(&path).expect("read fixture");
        let mut gb = GameBoy::dmg(POKERED);
        match gb.load_state(&bytes) {
            Ok(()) => checked += 1,
            Err(e) => failures.push(format!("{}: {e}", path.display())),
        }
    }

    assert!(
        failures.is_empty(),
        "{} fixture(s) failed to decode. If you changed a serialised struct, see the rules at the \
         top of gbc's savestate module; appending within a section should never do this.\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(checked >= 91, "expected at least 91 fixtures, found {checked}");
}

/// Pokémon Red finds the SGB, uploads its palettes and paints the title screen with them.
#[test]
fn pokemon_red_finds_the_sgb_and_paints_its_title_screen() {
    use gbc::ram::ROM;
    const W_ON_SGB: u16 = 0xCF1B;
    let mut gb = GameBoy::sgb(POKERED);
    gb.run(MachineCycles::PER_FRAME * 60 * 12);
    assert_eq!(gb.core().mmu().read(W_ON_SGB), 1);
    let greys: Vec<_> = [DMGColor::White, DMGColor::LightGray, DMGColor::DarkGray, DMGColor::Black].map(DMGColor::to_lcd).into();
    let coloured = gb.core().mmu().display().iter().filter(|pixel| !greys.contains(pixel)).count();
    assert!(coloured > LCD_WIDTH * LCD_HEIGHT / 2, "{coloured} coloured pixels");

    let state = gb.save_state().unwrap();
    let mut restored = GameBoy::sgb(POKERED);
    restored.load_state(&state).unwrap();
    let cells = |gb: &GameBoy| -> Vec<[u16; 4]> {
        let sgb = gb.core().mmu().sgb().unwrap();
        (0..LCD_HEIGHT / 8).flat_map(|row| (0..LCD_WIDTH / 8).map(move |column| sgb.cell_palette(column, row))).collect()
    };
    assert_eq!(cells(&restored), cells(&gb));
}

/// Pokémon Red is a DMG-only cartridge, so on a Game Boy Color the boot ROM picks its palette from
/// the title checksum.
#[test]
fn pokemon_red_boots_in_colour_on_a_cgb() {
    use gbc::model::ColorMode;

    fn ramp(colors: [u16; 4]) -> [image::Rgb<u8>; 4] {
        colors.map(LcdColor::from_rgb555).map(|c| c.to_rgb())
    }
    // Combination 13: BG and OBJ1 from pool palette 4 (red), OBJ0 from palette 3 (green).
    let background = ramp([0x7FFF, 0x421F, 0x1CF2, 0x0000]);
    let object0 = ramp([0x7FFF, 0x1BEF, 0x0200, 0x0000]);
    let shades = [0xFFu8, 0xAA, 0x55, 0x00];

    let mut cgb = GameBoy::cgb(POKERED);
    let mut dmg = GameBoy::dmg(POKERED);
    assert_eq!(cgb.core().mmu().color_mode(), ColorMode::CgbCompat);
    assert_eq!(dmg.core().mmu().color_mode(), ColorMode::Dmg);

    let mut saw_colour = false;
    let mut elapsed = 0;
    // The copyright screen, the Game Freak logo, and the Nidorino/Gengar intro.
    for checkpoint in [3_000_000u64, 8_000_000, 12_000_000] {
        let step = MachineCycles::from_m(checkpoint - elapsed);
        elapsed = checkpoint;
        cgb.run(step);
        dmg.run(step);
        let colour = cgb.core().mmu().ppu().screenshot();
        let grey = dmg.core().mmu().ppu().screenshot();

        for (x, y, pixel) in grey.enumerate_pixels() {
            assert_eq!(pixel.0[0], pixel.0[1], "DMG pixel ({x},{y}) is not grey");
            let shade = shades.iter().position(|&s| s == pixel.0[0])
                .unwrap_or_else(|| panic!("DMG pixel ({x},{y}) = {pixel:?} is not a DMG shade"));
            let actual = *colour.get_pixel(x, y);
            assert!(
                actual == background[shade] || actual == object0[shade],
                "pixel ({x},{y}) at {checkpoint}M: shade {shade} rendered as {actual:?}, \
                 expected {:?} (BG) or {:?} (OBJ0)", background[shade], object0[shade]
            );
            saw_colour |= actual.0[0] != actual.0[1];
        }
    }
    assert!(saw_colour, "test is vacuous unless some CGB frame is actually coloured");
}

/// Throughput of the emulator on a real game standing mid-play, which profiles the same as one
/// being played. `gbc`'s own `bench_core_throughput` has the synthetic workloads.
/// ```text
/// cargo test --release -p poke-agent --features slow-tests --lib -- \
///   emulator_tests::bench_pokemon_red_throughput --exact --nocapture
/// ```
#[cfg(feature = "slow-tests")]
#[test]
fn bench_pokemon_red_throughput() {
    use gbc::ram::ROM;
    use std::time::Instant;

    const W_CUR_MAP: u16 = 0xd35e;
    const W_IS_IN_BATTLE: u16 = 0xd057;
    const CELADON_CITY: u8 = 6;
    const WARM_UP_FRAMES: usize = 60;
    let measured_frames: usize = std::env::var("BENCH_FRAMES").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
    let audio_output = std::env::var("BENCH_AUDIO").unwrap_or_default() != "off";

    let mut gb = GameBoy::dmg(POKERED);
    gb.load_state(AT_CELADON).expect("load fixture");
    let mmu = gb.core().mmu();
    assert_eq!(
        (mmu.read(W_CUR_MAP), mmu.read(W_IS_IN_BATTLE)),
        (CELADON_CITY, 0),
        "the benchmark fixture is no longer standing in the Celadon overworld"
    );
    gb.core_mut().mmu_mut().audio_mut().set_output_enabled(audio_output);
    for _ in 0..WARM_UP_FRAMES {
        gb.run(MachineCycles::PER_FRAME);
    }

    let start = Instant::now();
    let mut cycles = MachineCycles::ZERO;
    for _ in 0..measured_frames {
        cycles += gb.run(MachineCycles::PER_FRAME);
    }
    let t_cycles_per_sec = cycles.t_cycles() as f64 / start.elapsed().as_secs_f64();
    println!(
        "\npokemon-red (fixture), audio output {}: {:.1}x realtime, {t_cycles_per_sec:.0} t-cycles/s over {measured_frames} frames\n",
        if audio_output { "on" } else { "gated" },
        t_cycles_per_sec / MachineCycles::CPU_FREQ as f64,
    );
}
