# syntax=docker/dockerfile:1.7
# The ROM and `web/dist` are baked into the binary and neither is in git, so stages 1 and 2 build them.

# ── 1. the cartridge ─────────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS rom
# pokered needs rgbds ≥ 1.0.0 and names 1.0.3; bump the version and checksum together.
ARG RGBDS_VERSION=1.0.3
ARG RGBDS_SHA256=97b523435f7da0b6d2a58daff447bb2c8280895c3f49eb4e63e5df8da63dd64d

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential bison libpng-dev pkg-config make curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# From source, because the prebuilt release is x86-64 only.
WORKDIR /rgbds
RUN curl -fsSL -o rgbds.tar.gz \
        "https://github.com/gbdev/rgbds/releases/download/v${RGBDS_VERSION}/rgbds-source.tar.gz" \
    && echo "${RGBDS_SHA256}  rgbds.tar.gz" | sha256sum -c - \
    && tar xzf rgbds.tar.gz --strip-components=1 \
    && make -j"$(nproc)" \
    && make install \
    && rgbasm --version

WORKDIR /pokered
COPY vendor/pokered/ ./
RUN test -f main.asm || { \
        echo "the pokered submodule is empty — run: git submodule update --init --recursive" >&2; \
        exit 1; \
    }

# Every fixture and generated symbol is pinned to these bytes, hence the sha1 check.
RUN make -j"$(nproc)" pokered.gbc \
    && grep ' \*pokered\.gbc$' roms.sha1 | sha1sum -c - \
    && test -s pokered.sym

# ── 2. the SPA ───────────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS web
# pnpm's version comes from `packageManager` via corepack, which Node 25 and later do not bundle.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /web
# `pnpm-workspace.yaml` carries the `minimumReleaseAge` cooldown, so it must be here for the install.
COPY poke-agent-web/web/package.json poke-agent-web/web/pnpm-lock.yaml poke-agent-web/web/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY poke-agent-web/web/ ./
RUN pnpm run build

# ── 3. the binary ────────────────────────────────────────────────────────────────────────────────
FROM rust:1-bookworm AS build
WORKDIR /src

# Only what the compile reads, so a doc edit does not invalidate this layer. The two SDL crates are
# never built, but their real manifests keep `Cargo.lock` exact and stub `main.rs`es give them targets.
COPY Cargo.toml Cargo.lock ./
COPY poke-core/Cargo.toml poke-core/build.rs ./poke-core/
COPY poke-core/build/ ./poke-core/build/
COPY poke-core/src/ ./poke-core/src/
COPY pokered/Cargo.toml ./pokered/
COPY pokered/src/ ./pokered/src/
COPY poke-agent/Cargo.toml poke-agent/build.rs ./poke-agent/
COPY poke-agent/src/ ./poke-agent/src/
COPY poke-agent-web/Cargo.toml ./poke-agent-web/
COPY poke-agent-web/src/ ./poke-agent-web/src/
COPY poke-agent-sdl/Cargo.toml ./poke-agent-sdl/
COPY pokered-sdl/Cargo.toml ./pokered-sdl/
RUN for crate in poke-agent-sdl pokered-sdl; do mkdir -p $crate/src && echo 'fn main() {}' > $crate/src/main.rs; done
# `poke-core/build.rs` reads the submodule's source, and `poke-agent` the two files stage 1 assembles.
COPY vendor/pokered/ ./vendor/pokered/
COPY --from=rom /pokered/pokered.gbc /pokered/pokered.sym ./vendor/pokered/
COPY --from=web /web/dist ./poke-agent-web/web/dist

# The binary is copied out inside this RUN because `target/` is a cache mount, absent from the image.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release --locked -p poke-agent-web \
    && cp target/release/poke-agent-web /usr/local/bin/poke-agent-web

# ── 4. the image ─────────────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# `image.source` links the GHCR package to the repo. No `image.licenses`: the repo has no LICENSE.
LABEL org.opencontainers.image.source="https://github.com/axle-h/poke-agent" \
      org.opencontainers.image.description="A Game Boy emulator playing Pokémon Red, driven by an LLM over text"

# curl is for the HEALTHCHECK; the binary carries its own TLS roots. `k8s/` relies on uid 10001.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /home/gb --uid 10001 gb \
    && mkdir -p /runs && chown gb:gb /runs

COPY --from=build /usr/local/bin/poke-agent-web /usr/local/bin/poke-agent-web

# The build stamp `GET /version` serves, filled in by CI. It must stay below the binary's COPY: the
# date changes every build, and consumed any earlier it would force a cold cargo build every run.
ARG GB_BUILD_DATE=""
ARG GB_GIT_BRANCH=""
ARG GB_GIT_SHA=""
ENV GB_BUILD_DATE=$GB_BUILD_DATE \
    GB_GIT_BRANCH=$GB_GIT_BRANCH \
    GB_GIT_SHA=$GB_GIT_SHA
# The full commit, not the short one in GB_GIT_SHA.
ARG GB_GIT_REVISION=""
LABEL org.opencontainers.image.revision="$GB_GIT_REVISION" \
      org.opencontainers.image.created="$GB_BUILD_DATE"

ENV GB_RUN_DIR=/runs \
    GB_PORT=8080
VOLUME /runs
EXPOSE 8080

USER gb
WORKDIR /runs

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${GB_PORT}/api/healthz" >/dev/null || exit 1

# Exec form, so the binary is PID 1 and gets SIGTERM, which is what checkpoints the run.
CMD ["poke-agent-web"]
