#!/bin/sh
# dsh-remote-tunnel bootstrap
# bootstrap-remote.sh — prepare a remote Linux server ACCOUNT for
# dsh-remote-tunnel. Runs against whatever account you log in with (the
# plugin's `bootstrap <host>` subcommand streams this script to `sh -s` over
# ssh; it can equally be run manually):
#
#   curl -fsSL <this file> | sh          # or: ssh <host> 'sh -s' < this-file
#
# It is idempotent and installs everything into the ACCOUNT's own home (no
# root needed when Node is already installed), so every labmate runs it once
# for their own user:
#   1. checks Node >= 22.19 (dsh requirement)
#   2. installs @deepseek-ai/dsh into ~/.npm-global (npm prefix); with
#      DSHRT_UPGRADE=1 it reinstalls even when dsh is already present
#   3. adds ~/.npm-global/bin to the account's PATH (bash/zsh/profile rc
#      files, idempotent) so `dsh` works in interactive shells too
#   4. creates $HOME/.dsh and enables systemd lingering for the login user
#      (so the systemd --user unit the plugin provisions survives logout)
#
# It does NOT create /etc/dsh-ports.tsv. That shared registry needs a one-time
# admin setup — see README.md "多用户共享服务器" / "Sharing one server".
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

say "== dsh-remote-tunnel bootstrap =="
say "account: $(id -un) home=$HOME"

# --- 0. npm prefix (all accounts install into their own ~/.npm-global) ------
NPM_PREFIX="$HOME/.npm-global"
mkdir -p "$NPM_PREFIX"
npm config set prefix "$NPM_PREFIX" >/dev/null 2>&1 || true
export PATH="$NPM_PREFIX/bin:$PATH"

# --- 1. Node ----------------------------------------------------------------
NODE_MAJOR=0
NODE_MINOR=0
if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node --version 2>/dev/null || echo v0.0.0)
  NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | sed -E 's/^v([0-9]+).*/\1/')
  NODE_MINOR=$(printf '%s' "$NODE_VERSION" | sed -E 's/^v[0-9]+\.([0-9]+).*/\1/')
  say "node: $NODE_VERSION"
fi
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  if command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    say "node too old/missing — installing via NodeSource (needs sudo)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    die "node >= 22.19 is required but not found. Install it first, e.g.:
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  nvm install 22
then re-run this script."
  fi
fi

# --- 2. dsh ------------------------------------------------------------------
if [ "${DSHRT_UPGRADE:-0}" = "1" ]; then
  say "upgrading @deepseek-ai/dsh to the latest version in $NPM_PREFIX ..."
  npm install -g @deepseek-ai/dsh@latest >/dev/null 2>&1 || npm install -g @deepseek-ai/dsh@latest
  say "dsh upgraded: $(command -v dsh >/dev/null 2>&1 && dsh --version 2>/dev/null || echo '?')"
elif ! command -v dsh >/dev/null 2>&1; then
  say "installing @deepseek-ai/dsh into $NPM_PREFIX ..."
  npm install -g @deepseek-ai/dsh >/dev/null 2>&1 || npm install -g @deepseek-ai/dsh
  say "dsh installed: $(command -v dsh >/dev/null 2>&1 && dsh --version 2>/dev/null || echo '?')"
else
  say "dsh already installed: $(dsh --version 2>/dev/null || echo '?')"
fi
DSH_BIN=$(command -v dsh || printf '%s\n' "$NPM_PREFIX/bin/dsh")
say "dsh: $DSH_BIN"

# --- 3. PATH persistence (idempotent) ---------------------------------------
# npm-global is a per-account install location that login shells do not
# usually have on PATH; add it once to the common rc files.
for RC in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshrc"; do
  if [ "$RC" = "$HOME/.zshrc" ] && [ ! -f "$RC" ]; then continue; fi
  [ -f "$RC" ] || touch "$RC"
  if ! grep -qF 'HOME/.npm-global/bin:$PATH' "$RC" 2>/dev/null; then
    printf '\n# dsh-remote-tunnel: expose npm global bin\n[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"\n' >> "$RC"
    say "PATH: added ~/.npm-global/bin to $RC"
  fi
done

# --- 4. home + lingering ----------------------------------------------------
mkdir -p "$HOME/.dsh"
if command -v loginctl >/dev/null 2>&1; then
  LINGER=$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null | cut -d= -f2)
  if [ "$LINGER" != "yes" ]; then
    loginctl enable-linger "$(id -un)" 2>/dev/null \
      && say "linger enabled for $(id -un)" \
      || say "warning: could not enable linger (systemd --user services may stop at logout)"
  else
    say "linger already enabled"
  fi
fi

# --- 5. shared registry (admin, optional) ------------------------------------
REGISTRY=${DSH_REGISTRY_PATH:-/etc/dsh-ports.tsv}
if [ -r "$REGISTRY" ]; then
  say "shared registry present: $REGISTRY"
else
  say ""
  say "NOTE: shared registry $REGISTRY does not exist."
  say "Without it each account falls back to ~/.dsh-ports.tsv (cross-user audit unavailable)."
  say "An admin creates BOTH files once (members must not create the lock in a"
  say "root-only directory) — see README.md 'Sharing one server (multi-user)':"
  say "    # A: members have passwordless sudo"
  say "    sudo install -m 0644 -o root -g root /dev/null $REGISTRY"
  say "    sudo install -m 0644 -o root -g root /dev/null ${REGISTRY}.lock"
  say "    # B: no sudo, shared group (chgrp dshports, chmod 0664) on BOTH files"
fi

say ""
say "== bootstrap done =="
say "On your LOCAL machine:"
say "    dsh --profile remote check <host>"
say "    dsh --profile remote up <host> --open"
say "Configure the API key on the remote web UI (Settings → Models), or set"
say "DEEPSEEK_API_KEY in the unit (see README)."
