#!/usr/bin/env bash
set -euo pipefail

resource_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_dir=$(cd -- "$resource_dir/../.." && pwd)
source_dir="$project_dir/.runtime/codex-source-0.156.1-lossless"
cargo_cache="$project_dir/.runtime/cargo-lossless"
upstream_commit=b412ff32c417f855c2b2d1581b77058eed87c84b

mkdir -p "$project_dir/.runtime" "$cargo_cache"
if [[ ! -d "$source_dir/.git" ]]; then
    git clone --depth 1 --filter=blob:none --sparse --branch rust-v0.156.1 https://github.com/openai/codex.git "$source_dir"
    git -C "$source_dir" sparse-checkout set codex-rs
fi
if [[ $(git -C "$source_dir" rev-parse HEAD) != "$upstream_commit" ]]; then
    printf '%s\n' 'Unexpected upstream commit; refusing to modify the checkout.' >&2
    exit 65
fi
for patch in codex-0.156.1-lossless.patch codex-0.156.1-workspace-lock.patch; do
    if git -C "$source_dir" apply --reverse --check "$resource_dir/$patch" 2>/dev/null; then
        continue
    fi
    git -C "$source_dir" apply --check "$resource_dir/$patch"
    git -C "$source_dir" apply "$resource_dir/$patch"
done
rustup toolchain install 1.95.0 --profile minimal

# Stay outside ancestor Cargo configuration and do not reuse the active target.
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/hapla-codex-0.156.1-build.XXXXXX")
trap 'rmdir "$build_dir"' EXIT
cd -- "$build_dir"
CARGO_HOME="$cargo_cache" cargo +1.95.0 build --locked \
    --manifest-path "$source_dir/codex-rs/Cargo.toml" \
    -p codex-app-server --bin codex-app-server -j "${HAPLA_CODEX_BUILD_JOBS:-16}"

# A helper from another release may speak a different protocol. Look only in a
# verified 0.156.1 npm installation, otherwise compile the matching source.
official_host=$(node "$resource_dir/find-official-host.mjs" "${HAPLA_CODEX_OFFICIAL_CLI:-$(command -v codex || true)}" 0.156.1 || true)
if [[ -n "$official_host" && -x "$official_host" ]]; then
    cp -- "$official_host" "$source_dir/codex-rs/target/debug/codex-code-mode-host"
else
    CARGO_HOME="$cargo_cache" cargo +1.95.0 build --locked \
        --manifest-path "$source_dir/codex-rs/Cargo.toml" \
        -p codex-code-mode-host --bin codex-code-mode-host -j "${HAPLA_CODEX_BUILD_JOBS:-16}"
fi
node "$resource_dir/write-manifest-0.156.1.mjs"
printf '%s\n' 'Codex 0.156.1 is prepared. The active runtime and manifest were not changed.'
