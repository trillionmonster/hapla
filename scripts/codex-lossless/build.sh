#!/usr/bin/env bash
set -euo pipefail

resource_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_dir=$(cd -- "$resource_dir/../.." && pwd)
source_dir="$project_dir/.runtime/codex-source-reliability"
cargo_cache="$project_dir/.runtime/cargo-lossless"
upstream_commit=3d2ee51ca2d5db578f328aa75e20aa22c0197c9a

mkdir -p "$project_dir/.runtime" "$cargo_cache"
if [[ ! -d "$source_dir/.git" ]]; then
    git clone --depth 1 --filter=blob:none --sparse --branch rust-v0.153.4 https://github.com/openai/codex.git "$source_dir"
    git -C "$source_dir" sparse-checkout set codex-rs
fi
if [[ $(git -C "$source_dir" rev-parse HEAD) != "$upstream_commit" ]]; then
    printf '%s\n' 'Unexpected upstream commit; refusing to modify the checkout.' >&2
    exit 65
fi
for patch in codex-0.153.4-lossless.patch codex-0.153.4-workspace-lock.patch; do
    if git -C "$source_dir" apply --reverse --check "$resource_dir/$patch" 2>/dev/null; then
        continue
    fi
    git -C "$source_dir" apply --check "$resource_dir/$patch"
    git -C "$source_dir" apply "$resource_dir/$patch"
done
rustup toolchain install 1.95.0 --profile minimal

# Starting outside the workspace avoids inheriting a developer's ancestor Cargo
# registry overrides. No global Cargo config, Codex config or executable changes.
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/hapla-codex-build.XXXXXX")
trap 'rmdir "$build_dir"' EXIT
cd -- "$build_dir"
CARGO_HOME="$cargo_cache" cargo +1.95.0 build --locked \
    --manifest-path "$source_dir/codex-rs/Cargo.toml" \
    -p codex-app-server --bin codex-app-server -j "${HAPLA_CODEX_BUILD_JOBS:-24}"

# The model's JavaScript tool host is a separate official executable. Reuse a
# byte-identical helper from the matching installed npm release when available.
installed_codex=$(command -v codex || true)
official_host=$(node "$resource_dir/find-official-host.mjs" "$installed_codex" || true)
if [[ -n "$official_host" && -x "$official_host" ]]; then
    cp -- "$official_host" "$source_dir/codex-rs/target/debug/codex-code-mode-host"
else
    CARGO_HOME="$cargo_cache" cargo +1.95.0 build --locked \
        --manifest-path "$source_dir/codex-rs/Cargo.toml" \
        -p codex-code-mode-host --bin codex-code-mode-host -j "${HAPLA_CODEX_BUILD_JOBS:-24}"
fi
node "$resource_dir/write-manifest.mjs"
printf '%s\n' 'New Hapla runtimes from this checkout now select the prepared, verified App Server automatically.'
