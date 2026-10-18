#!/usr/bin/env sh
# Links this checkout into the OpenCode plugin directory so both halves load.
set -eu

target=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
plugins="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
link="$plugins/opencode-rea-switch"

mkdir -p "$plugins"

if [ -L "$link" ]; then
  rm "$link"
elif [ -e "$link" ]; then
  echo "Refusing to replace a non-link path: $link" >&2
  exit 1
fi

ln -s "$target" "$link"

echo "Installed: $link"
echo "        -> $target"
echo
echo "Restart OpenCode once so the server half loads."
echo "After that, /rea opens the switch panel; edits to tui.tsx hot-reload."
