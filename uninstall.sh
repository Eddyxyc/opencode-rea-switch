#!/usr/bin/env sh
# Removes the plugin symlink. It never deletes the checkout itself.
set -eu

link="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-rea-switch"

if [ ! -L "$link" ]; then
  echo "Not installed as a symlink: $link"
  exit 0
fi

rm "$link"
echo "Removed: $link"
echo "Restart OpenCode to unload the plugin."
