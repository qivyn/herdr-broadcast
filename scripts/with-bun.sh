#!/bin/sh
# herdr runs plugin commands with the environment herdr itself started with, which can be a
# GUI app's bare PATH without ~/.bun/bin. Look in the usual install places, then hand over.
if ! command -v bun >/dev/null 2>&1; then
  for dir in "${BUN_INSTALL:-$HOME/.bun}/bin" "$HOME/.local/bin" "$HOME/.local/share/mise/shims" /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$dir/bun" ]; then
      PATH="$dir:$PATH"
      export PATH
      break
    fi
  done
fi
if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' "herdr-broadcast: bun not found on PATH or in ~/.bun/bin, ~/.local/bin, mise shims, Homebrew or /usr/local/bin. Install it: curl -fsSL https://bun.sh/install | bash" >&2
  exit 127
fi
exec bun "$@"
