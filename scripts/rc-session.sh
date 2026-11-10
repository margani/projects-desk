#!/usr/bin/env bash
# Opens a Claude Code conversation in the current folder with Remote Control
# on, so the phone shows it. A new conversation by default: resumed
# sessions with long histories re-read hundreds of thousands of cached tokens
# on every turn, and a project's
# CLAUDE.md, memory and status file give a fresh one its context.
# RC_RESUME=1 resumes the folder's last conversation instead (`rc.sh open
# --resume`); with none, it starts a new one.
#
# Why interactive `claude --remote-control` and not `claude remote-control`
# (server mode):
# - With "Require trusted devices" on, server mode could not create a session
#   at all ("Session creation failed with status 403: elevated session requires
#   a trusted device"), in any permission mode. The interactive CLI enrolls this
#   computer itself after a fresh sign-in and connects, the same way the VS Code
#   extension always did.
# - Server mode left the folder registered on Anthropic's server after a
#   suspend ("This folder is already served by a terminal `claude
#   remote-control`").
# - Server mode could not resume a conversation at all.
#
#   rc-session.sh <name> [more claude options...]   e.g. --permission-mode auto
#   RC_RESUME=1 rc-session.sh <name> ...            resume the last conversation
#   RC_DRY_RUN=1 rc-session.sh <name>               print the command only
set -uo pipefail

name="${1:?usage: rc-session.sh <name> [claude options...]}"
shift

# Claude Code keeps each folder's transcripts under ~/.claude/projects/<folder
# path with every non-alphanumeric character turned into "-">.
transcripts="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(pwd -P | sed 's/[^A-Za-z0-9]/-/g')"

# Conversations open in another Claude Code process right now (VS Code, another
# terminal) must not be resumed twice.
open_ids=$(for f in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/sessions/*.json; do
  [ -e "$f" ] || continue
  pid=$(basename "$f" .json)
  kill -0 "$pid" 2>/dev/null && jq -r '.sessionId // empty' "$f" 2>/dev/null
done)

latest=""
if [ -n "${RC_RESUME:-}" ] && [ -d "$transcripts" ]; then
  while IFS= read -r f; do
    id=$(basename "$f" .jsonl)
    grep -qxF "$id" <<<"$open_ids" && continue
    grep -q '"type":"user"' "$f" || continue   # empty conversation
    latest=$id
    break
  done < <(ls -1t "$transcripts"/*.jsonl 2>/dev/null)
fi

# The name is bound to its option: --remote-control takes an optional value,
# so a separate name starting with '-' was parsed as another claude option.
case "$name" in -*) echo "rc-session: '$name' is not a project name" >&2; exit 64 ;; esac
if [ -n "$latest" ]; then
  cmd=(claude --resume "$latest" "--remote-control=$name" "$@")
  echo "rc-session: resuming $name conversation $latest" >&2
else
  cmd=(claude "--remote-control=$name" "$@")
  if [ -n "${RC_RESUME:-}" ]; then
    echo "rc-session: no earlier conversation for $name; starting a new one" >&2
  else
    echo "rc-session: starting a new conversation for $name" >&2
  fi
fi
# RC_DRY_RUN=1 prints the command instead of running it.
if [ -n "${RC_DRY_RUN:-}" ]; then printf '%q ' "${cmd[@]}"; echo; exit 0; fi
exec "${cmd[@]}"
