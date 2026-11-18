#!/bin/sh
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '请先安装 Node.js 22+，以及 Docker（含 Compose v2），然后重新运行 ./deploy.sh。' >&2
  exit 1
fi
exec node "$repo_dir/scripts/selfhost.cjs" "$@"
