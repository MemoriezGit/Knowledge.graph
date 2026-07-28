#!/usr/bin/env bash
#
# Puts the second brain on this computer and gets it running.
#
#   bash install.sh              # installs to ~/Knowledge.graph
#   bash install.sh ~/somewhere  # or wherever you like
#
# Safe to re-run: if it's already there, this updates it instead of complaining.

set -euo pipefail

REPO="https://github.com/MemoriezGit/Knowledge.graph.git"
DEST="${1:-$HOME/Knowledge.graph}"
PORT="${PORT:-8787}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() {
  printf '\n  \033[31m✗\033[0m %s\n\n' "$1" >&2
  exit 1
}

echo
bold "Installing your second brain"
echo

# ── what we need ─────────────────────────────────────────────────────────────

command -v git >/dev/null 2>&1 || die "git isn't installed. Get it from https://git-scm.com/downloads"

command -v node >/dev/null 2>&1 ||
  die "Node.js isn't installed. Get version 20.11 or newer from https://nodejs.org"

NODE_RAW="$(node -v)"          # e.g. v22.22.2
NODE_NUM="${NODE_RAW#v}"
NODE_MAJOR="${NODE_NUM%%.*}"
NODE_REST="${NODE_NUM#*.}"
NODE_MINOR="${NODE_REST%%.*}"
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 11 ]; }; then
  die "Node $NODE_RAW is too old — this needs 20.11 or newer. Update at https://nodejs.org"
fi
ok "Node $NODE_RAW"

# ── get the code ─────────────────────────────────────────────────────────────

if [ -d "$DEST/.git" ]; then
  # Already installed. Update rather than fail, so this doubles as an updater.
  git -C "$DEST" remote get-url origin | grep -qi "Knowledge.graph" ||
    die "$DEST is a different git repository. Pass another path: bash install.sh ~/somewhere-else"
  git -C "$DEST" pull --ff-only >/dev/null 2>&1 ||
    dim "  (couldn't fast-forward — you have local changes, keeping them)"
  ok "Updated $DEST"
elif [ -e "$DEST" ]; then
  die "$DEST already exists and isn't this project. Pass another path: bash install.sh ~/somewhere-else"
else
  git clone --quiet "$REPO" "$DEST"
  ok "Downloaded to $DEST"
fi

cd "$DEST"

# ── dependencies ─────────────────────────────────────────────────────────────

echo "  · installing dependencies (a minute or so)…"
# Not --silent: an install that prints nothing for two minutes looks hung, and
# when it fails the reason is the only thing worth having.
if ! npm install --no-fund --no-audit; then
  die "Installing dependencies failed — the reason is just above this line."
fi
ok "Dependencies installed"

# ── the brain ────────────────────────────────────────────────────────────────

echo
if ! command -v claude >/dev/null 2>&1; then
  bold "One thing left: pick a brain"
  echo
  echo "  You already pay for Claude? Use that — no API bill:"
  dim "      npm install -g @anthropic-ai/claude-code"
  dim "      claude                 # sign in with your Pro/Max plan, once"
  echo
  echo "  Prefer an API key? Put ANTHROPIC_API_KEY or OPENAI_API_KEY in:"
  dim "      $DEST/.env"
  echo
  echo "  Then run:"
  dim "      cd \"$DEST\" && npm run setup && npm start"
  echo
  exit 0
fi

npm run setup

# ── go ───────────────────────────────────────────────────────────────────────

echo
bold "Starting it up…"
dim "  Press Ctrl-C to stop. Next time, just: cd \"$DEST\" && npm start"
echo

# Give the server a moment to build and bind, then open a browser at it.
(
  sleep 12
  URL="http://localhost:$PORT"
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi
) >/dev/null 2>&1 &

exec npm start
