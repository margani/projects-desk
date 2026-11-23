#!/usr/bin/env bash
# Opens and closes the projects' Remote Control sessions one at a time,
# so only the projects in use hold memory. Each project is a window of the
# tmux session `claude-rc`, running scripts/rc-session.sh, which starts a new
# conversation (`open --resume` resumes the last one); closing is a
# normal /exit, so nothing is lost.
# The coordinator session `hub` (in RC_HUB_DIR, instructions in hub/CLAUDE.md)
# is always open: a systemd unit opens it at login and it runs this script
# when the owner asks from the phone.
#
#   rc.sh list                    every project: open/closed, status, idle time
#   rc.sh open <project>          open a new session for one project (or the hub)
#   rc.sh open --resume <project> resume its last conversation instead
#   rc.sh open --agent agy <project>
#                                 open it with agy (Google Antigravity CLI)
#                                 instead; Claude Code stays the default. It
#                                 runs in its own tmux session `agy-rc`, and
#                                 the model is `agy.model` in desk.config.json.
#                                 agy must be installed and signed in already
#                                 (README, "Sessions with agy"); idle-close
#                                 never touches it, as agy has no session file.
#   rc.sh close <project>         /exit it; refuses while it is working
#   rc.sh close --force <project> close it even while it is working
#   rc.sh close --agent agy <project>
#                                 close its agy session (needs --force); without
#                                 --agent a project's Claude session wins
#   rc.sh ... --on <machine>      run any of the above on another machine
#                                 (desk.config.json `machines`); `claude` is
#                                 this machine and the default
#   rc.sh where <project>         prints open or closed on this machine
#   rc.sh boot                    open the hub and every project in RC_KEEP_OPEN
#                                 (what the login/boot unit runs)
#   rc.sh close-idle              close every project idle RC_IDLE_HOURS (24),
#                                 except those in RC_KEEP_OPEN
#
# Other machines: `open` and `close` act on this machine unless --on says
# otherwise. Any project can run on any machine; keeping two sessions of one
# project from running in parallel is left to the owner. A remote run is the same script over ssh, from that machine's own
# copy of these scripts, streamed over the same ssh connection, so nothing has
# to be cloned there.
# `list` shows every machine.
#
# A project is a folder directly under PROJECTS_DIR with a status file or
# earlier Claude Code conversations; `open` also takes a new git repo or
# a folder with a CLAUDE.md. A session already open in claude-rc is always
# listed. Folders like _backup or scratch-test match none of these.
#
# "Working" comes from Claude Code's own session file
# (~/.claude/sessions/<pid>.json, `status`): busy (a turn is running), shell
# (a background command is running) or anything other than idle. A prompt
# with typed but unsent text also counts, since /exit would be appended to it.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECTS_DIR="${PROJECTS_DIR:-$(dirname "$REPO")}"
HUB_DIR="${RC_HUB_DIR:-$PROJECTS_DIR/hub}"
SESSION="${RC_SESSION:-claude-rc}"
# agy sessions live in their own tmux session so close-idle and `projects`,
# which only know Claude's session files, never see them.
AGY_SESSION="${RC_AGY_SESSION:-agy-rc}"
MODE="${RC_PERMISSION_MODE:-auto}"
# 24 hours: with 3 days, 9 sessions idle for 41 h held about 7 GB while
# swap was full.
IDLE_HOURS="${RC_IDLE_HOURS:-24}"
# Never closed for being idle, only on request (space-separated), for sessions
# running long watches that must outlive a quiet day.
KEEP_OPEN="${RC_KEEP_OPEN:-}"
STATUS_DIR="${RC_STATUS_DIR:-$REPO/status}"
SESSIONS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"
# This machine's name in desk.config.json, and the file that lists the others.
LOCAL_MACHINE="${RC_MACHINE:-claude}"
CONFIG="${RC_CONFIG:-$REPO/desk.config.json}"

die() { echo "rc: $*" >&2; exit 1; }
command -v tmux >/dev/null || die "tmux is not installed"
command -v jq >/dev/null || die "jq is not installed"

# Where Claude Code keeps a folder's conversations (as in rc-session.sh).
transcripts_of() { echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(cd "$1" && pwd -P | sed 's/[^A-Za-z0-9]/-/g')"; }
has_status() { [ -f "$STATUS_DIR/$1.json" ]; }
# Project names become tmux window names, a shell command for the new window
# and claude's session name, so only plain folder names are accepted: a
# name with a quote broke out of the window command, and one starting with
# '-' was read by claude as an option.
plain_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [ "$1" != hub ]; }
# A folder worked on before: a status file or at least one conversation.
known() {
  local d="$PROJECTS_DIR/$1"
  plain_name "$1" || return 1
  [ -d "$d" ] || return 1
  has_status "$1" && return 0
  compgen -G "$(transcripts_of "$d")/*.jsonl" >/dev/null
}
# Every known project, plus the sessions already open in claude-rc.
projects() {
  {
    for d in "$PROJECTS_DIR"/*/; do
      p="$(basename "$d")"
      if known "$p"; then echo "$p"; fi
    done
    tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null |
      while read -r p; do
        if plain_name "$p" && [ -d "$PROJECTS_DIR/$p" ]; then echo "$p"; fi
      done
  } | sort -fu
}
# What `open` accepts: a known project, or a new git repo or CLAUDE.md folder.
openable() {
  known "$1" && return 0
  plain_name "$1" || return 1
  [ -e "$PROJECTS_DIR/$1/.git" ] || [ -f "$PROJECTS_DIR/$1/CLAUDE.md" ]
}
keep_open() { grep -qxF "$1" <<<"$(tr ' ' '\n' <<<"$KEEP_OPEN")"; }
dir_of() { if [ "$1" = hub ]; then echo "$HUB_DIR"; else echo "$PROJECTS_DIR/$1"; fi; }

# The tmux window id of a project, by exact name ("" when there is none).
window_of() {
  tmux list-windows -t "$SESSION" -F '#{window_id} #{window_name}' 2>/dev/null |
    awk -v n="$1" '$2 == n { print $1; exit }'
}
# The claude process in that window ("" when it has exited to the shell).
claude_pid() {
  local win pane
  win="$(window_of "$1")"; [ -n "$win" ] || return 0
  pane="$(tmux list-panes -t "$win" -F '#{pane_pid}' | head -n1)"
  pgrep -P "$pane" -x claude | head -n1
}
info() { jq -r "$2" "$SESSIONS_DIR/$1.json" 2>/dev/null; }
# Text typed in the prompt but not sent: the last line starting with ❯. A
# fresh session shows a dim placeholder there (Try "refactor <filepath>"),
# which is not a draft, so dim runs (ESC[2m … ESC[0m/ESC[22m) are dropped.
draft() {
  tmux capture-pane -e -p -t "$(window_of "$1")" 2>/dev/null |
    sed 's/\x1b\[2m[^\x1b]*\x1b\[\(0\|22\)m//g; s/\x1b\[[0-9;]*m//g' |
    grep '^❯' | tail -n1 | sed 's/^❯//; s/[[:space:]\xc2\xa0]//g'
}
# Claude Code gives up for good when its first Remote Control connection fails
# ("Session creation failed ... run /remote-control to reconnect"). Right after
# a boot the network is often not usable yet although network-online.target
# was reached, and the hub then stayed disconnected until someone typed
# /remote-control by hand (2026-11-10).
rc_disconnected() { tmux capture-pane -p -t "$(window_of "$1")" 2>/dev/null | grep -q 'run /remote-control to reconnect'; }
trust_prompt() { tmux capture-pane -p -t "$(window_of "$1")" 2>/dev/null | grep -q 'trust this folder'; }

# Why a session must not be closed now ("" when it may be).
working() {
  local pid="$1" name="$2" status
  status="$(info "$pid" '.status // empty')"
  status="${status:-unknown}"   # no session file: cannot tell, so not idle
  case "$status" in
    idle) ;;
    busy) echo "busy: a turn is running"; return ;;
    shell) echo "a background command is running"; return ;;
    *) echo "status $status"; return ;;
  esac
  if [ -n "$(draft "$name")" ]; then echo "there is unsent text in its prompt"; fi
}
idle_hours() {
  local at; at="$(info "$1" '.statusUpdatedAt // empty')"
  [ -n "$at" ] || { echo 0; return; }
  echo $(( ($(date +%s) - at / 1000) / 3600 ))
}

# --- agy (Google Antigravity CLI) -------------------------------------------
agy_window_of() {
  tmux list-windows -t "$AGY_SESSION" -F '#{window_id} #{window_name}' 2>/dev/null |
    awk -v n="$1" '$2 == n { print $1; exit }'
}
agy_pid() {
  local win pane
  win="$(agy_window_of "$1")"; [ -n "$win" ] || return 0
  pane="$(tmux list-panes -t "$win" -F '#{pane_pid}' | head -n1)"
  pgrep -P "$pane" -x agy | head -n1
}
agy_link() {
  tmux capture-pane -p -t "$(agy_window_of "$1")" 2>/dev/null |
    { grep -oE 'https://antigravity\.google\.com/r/[A-Za-z0-9-]+' || true; } | tail -n1
}
agy_trust_prompt() { tmux capture-pane -p -t "$(agy_window_of "$1")" 2>/dev/null | grep -q 'trust this folder'; }
agy_model() { jq -r '.agy.model // empty' "$CONFIG" 2>/dev/null; }
# agy is a prerequisite, like Claude Code: never installed or signed in here.
# `agy models` needs a sign-in and sends no prompt: it exits 1 when signed out
# (tested 2026-11-23 with an empty HOME), 0 when signed in.
agy_ready() {
  command -v agy >/dev/null ||
    die "agy is not installed. rc.sh does not install it: see README.md, \"Sessions with agy\""
  agy models >/dev/null 2>&1 ||
    die "agy is not signed in (or cannot reach its service). rc.sh does not sign in: see README.md, \"Sessions with agy\""
}

# --- other machines ---------------------------------------------------------
machine_field() { jq -r --arg m "$1" --arg f "$2" '.machines[$m][$f] // empty' "$CONFIG" 2>/dev/null; }
remote_machines() { jq -r '.machines // {} | keys[]' "$CONFIG" 2>/dev/null | grep -vxF "$LOCAL_MACHINE"; }

# Runs rc.sh on another machine. ssh gets a short connect timeout and no
# password prompt: a laptop that is off or asleep must fail in seconds with a
# message, not hang the caller (exit 4). Names from the config go into a remote
# shell command, so they are checked first.
remote_run() {
  local m="$1" alias pdir rc; shift
  [[ "$m" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "'$m' is not a machine name"
  jq -e --arg m "$m" '.machines[$m]' "$CONFIG" >/dev/null 2>&1 ||
    die "machine '$m' is not in $CONFIG (machines: $LOCAL_MACHINE $(remote_machines | tr '\n' ' '))"
  alias="$(machine_field "$m" ssh)"; alias="${alias:-$m}"
  pdir="$(machine_field "$m" projects_dir)"; pdir="${pdir:-projects/personal}"
  [[ "$alias" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]] || die "machine $m: ssh alias '$alias' is not plain"
  [[ "$pdir" =~ ^[A-Za-z0-9._/-]+$ ]] || die "machine $m: projects_dir '$pdir' must be a path under the home folder"
  # ssh runs a non-interactive shell, whose PATH lacks ~/.local/bin, where the
  # native Claude Code installer puts `claude` (found missing on the first laptop).
  # The two scripts travel over the same ssh connection into a cache folder on
  # that machine, so nothing has to be cloned there and it always runs the
  # version from this machine. The remote paths are its own projects folder
  # and the status folder its sessions write to.
  tar -C "$REPO" -cf - scripts/rc.sh scripts/rc-session.sh |
    ssh -o BatchMode=yes -o ConnectTimeout="${RC_SSH_TIMEOUT:-5}" -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -- "$alias" "PATH=\"\$HOME/.local/bin:\$PATH\"; d=\"\$HOME/.cache/projects-desk-rc\"; mkdir -p \"\$d\" && tar -xf - -C \"\$d\" && RC_MACHINE=$(printf %q "$m") PROJECTS_DIR=\"\$HOME\"/$(printf %q "$pdir") RC_STATUS_DIR=\"\$HOME\"/$(printf %q "$pdir")/projects-dashboard/status \"\$d\"/scripts/rc.sh $(printf '%q ' "$@")"
  rc=${PIPESTATUS[1]}
  if [ "$rc" -eq 255 ]; then
    echo "rc: machine $m ($alias) is unreachable: off, asleep, or ssh refused" >&2
    return 4
  fi
  return "$rc"
}

cmd_list() {
  printf '%-10s %-6s %-18s %-8s %-8s %-6s %s\n' MACHINE AGENT PROJECT STATE STATUS IDLE SESSION
  for p in hub $(projects); do
    local pid st
    pid="$(claude_pid "$p")"
    if [ -z "$pid" ]; then
      printf '%-10s %-6s %-18s %-8s %-8s %-6s %s\n' "$LOCAL_MACHINE" claude "$p" closed "" "" "$(has_status "$p" || echo "(no status file yet)")"
      continue
    fi
    st="$(info "$pid" '.status // "starting"')"
    trust_prompt "$p" && st="needs-trust"
    printf '%-10s %-6s %-18s %-8s %-8s %-6s %s%s\n' "$LOCAL_MACHINE" claude "$p" open "$st" "$(idle_hours "$pid")h" "$(info "$pid" '.name // "-"')" \
      "$(if [ "$p" != hub ] && ! has_status "$p"; then echo "  (no status file yet)"; fi)"
  done
  local w
  for w in $(tmux list-windows -t "$AGY_SESSION" -F '#{window_name}' 2>/dev/null); do
    local st=open
    [ -n "$(agy_pid "$w")" ] || st=exited
    agy_trust_prompt "$w" && st=needs-trust
    printf '%-10s %-6s %-18s %-8s %-8s %-6s %s\n' "$LOCAL_MACHINE" agy "$w" "$st" "" "" "$(agy_link "$w")"
  done
  # Every configured machine, minus its header; one that is off is one row.
  local m out
  for m in $(remote_machines); do
    if out="$(remote_run "$m" list 2>&1)"; then
      echo "$out" | tail -n +2
    else
      printf '%-10s %s\n' "$m" "unreachable: $(echo "$out" | tail -n1 | sed "s/^rc: //")"
    fi
  done
}

cmd_where() {
  local p="${1:?usage: rc.sh where <project>}"
  { [ -n "$(claude_pid "$p")" ] || [ -n "$(agy_pid "$p")" ]; } && echo open || echo closed
}

# The window's command. Every part is shell-quoted: tmux runs this string
# through the shell. A non-empty second argument resumes.
session_cmd() {
  local p="$1" resume="${2:-}" shown="$1"
  # On another machine the session is "<project> on <machine>", so the Remote
  # Control list tells apart the same project on two computers. The tmux window
  # keeps the plain project name, which every lookup here relies on.
  [ "$LOCAL_MACHINE" != claude ] && shown="$p on $LOCAL_MACHINE"
  printf '%s%s' "${resume:+RC_RESUME=1 }" "$(printf '%q ' "$REPO/scripts/rc-session.sh" "$shown" --permission-mode "$MODE")"
  printf '; exec "${SHELL:-bash}"'
}

# Opens a project with agy: its own tmux session, the model from the config,
# and the Remote Control link printed once agy shows it. A new folder waits
# at agy's trust prompt, exit code 3 as for Claude Code.
cmd_open_agy() {
  local p="$1" dir model win link
  { openable "$p" && [ "$p" != hub ]; } || die "no project folder '$p' in $PROJECTS_DIR for agy (a project has a status file, a git repo or a CLAUDE.md)"
  agy_ready
  model="$(agy_model)"
  [ -n "$model" ] || die "no model for agy: set \"agy\": {\"model\": \"<id>\"} in $CONFIG (ids: agy models)"
  [[ "$model" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "agy.model '$model' is not a plain model id"
  dir="$(dir_of "$p")"
  if [ -n "$(agy_pid "$p")" ]; then
    echo "$p is already open with agy: $(agy_link "$p")"
    return 0
  fi
  win="$(agy_window_of "$p")"; [ -n "$win" ] && tmux kill-window -t "$win"
  local run
  run="$(printf '%q ' agy --remote-control --model "$model"; printf '; exec "${SHELL:-bash}"')"
  if tmux has-session -t "$AGY_SESSION" 2>/dev/null; then
    tmux new-window -d -t "$AGY_SESSION" -n "$p" -c "$dir" "$run"
  else
    tmux new-session -d -s "$AGY_SESSION" -n "$p" -c "$dir" "$run"
  fi
  for _ in $(seq 60); do
    sleep 1
    if agy_trust_prompt "$p"; then
      echo "$p is waiting at agy's \"trust this folder\" prompt; answer it in tmux window $AGY_SESSION:$p" >&2
      return 3
    fi
    link="$(agy_link "$p")"
    if [ -n "$link" ]; then
      echo "$p is open with agy: $link"
      return 0
    fi
  done
  echo "$p did not print an agy Remote Control link within 60 s; see tmux window $AGY_SESSION:$p" >&2
  return 1
}

cmd_open() {
  local resume="" agent=claude
  while [ $# -gt 0 ]; do
    case "$1" in
      --resume) resume=1; shift ;;
      --agent) [ -n "${2:-}" ] || die "--agent needs a name (claude or agy)"; agent="$2"; shift 2 ;;
      *) break ;;
    esac
  done
  case "$agent" in
    claude) ;;
    agy) [ -z "$resume" ] || die "--resume is for Claude Code only"
         cmd_open_agy "${1:?usage: rc.sh open --agent agy <project>}"; return ;;
    *) die "unknown agent '$agent' (claude or agy)" ;;
  esac
  local p="${1:?usage: rc.sh open [--resume] <project>}" dir win pid
  if [ "$p" != hub ] && ! openable "$p"; then
    die "no project folder '$p' in $PROJECTS_DIR (a project has a status file, earlier Claude conversations, a git repo or a CLAUDE.md; known: $(projects | tr '\n' ' '))"
  fi
  if [ "$p" != hub ] && ! has_status "$p"; then
    echo "note: $p has no status file yet; its own session writes it (see STATUS_INSTRUCTIONS.md)"
  fi
  dir="$(dir_of "$p")"
  if [ "$p" = hub ]; then
    # The hub's instructions live in this repo, so they are versioned.
    mkdir -p "$dir" && ln -sfn "$REPO/hub/CLAUDE.md" "$dir/CLAUDE.md"
  fi
  pid="$(claude_pid "$p")"
  if [ -n "$pid" ]; then
    echo "$p is already open: $(info "$pid" '.name // "-"')"
    return 0
  fi
  # A window left with only a shell after an exit is replaced.
  win="$(window_of "$p")"; [ -n "$win" ] && tmux kill-window -t "$win"
  local run
  run="$(session_cmd "$p" "$resume")"
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux new-window -d -t "$SESSION" -n "$p" -c "$dir" "$run"
  else
    tmux new-session -d -s "$SESSION" -n "$p" -c "$dir" "$run"
  fi
  local retried=-20
  for t in $(seq 150); do
    sleep 1
    if trust_prompt "$p"; then
      echo "$p is waiting at Claude Code's \"trust this folder\" prompt; answer it in tmux window $SESSION:$p" >&2
      return 3
    fi
    pid="$(claude_pid "$p")"
    if [ -n "$pid" ] && [ "$(info "$pid" '.bridgeSessionId // empty')" != "" ]; then
      echo "$p is open: $(info "$pid" '.name // "-"') (Remote Control connected)"
      return 0
    fi
    # Reconnect at most every 20 s, while the screen says the connection failed.
    if [ $((t - retried)) -ge 20 ] && rc_disconnected "$p"; then
      retried=$t
      echo "$p: Remote Control failed to connect; asking it to reconnect" >&2
      tmux send-keys -t "$(window_of "$p")" '/remote-control' Enter
    fi
  done
  echo "$p did not connect to Remote Control within 150 s; see tmux window $SESSION:$p" >&2
  return 1
}

# agy has no session file, so "working" cannot be read: closing needs --force.
# /exit ends it cleanly (tested 2026-11-23); unsent text would swallow it, so
# the line is cleared first.
close_agy() {
  local p="$1" force="$2" pid win
  win="$(agy_window_of "$p")"; pid="$(agy_pid "$p")"
  if [ -z "$pid" ]; then tmux kill-window -t "$win"; echo "$p is not open"; return 0; fi
  if [ -z "$force" ]; then
    echo "$p runs agy, which does not report whether it is working; rc.sh close --force $p closes it." >&2
    return 2
  fi
  tmux send-keys -t "$win" Escape C-u
  tmux send-keys -t "$win" -l '/exit'; sleep 0.5
  tmux send-keys -t "$win" Enter
  for _ in $(seq 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then
    echo "$p did not exit within 30 s; see tmux window $AGY_SESSION:$p" >&2
    return 1
  fi
  tmux kill-window -t "$win"
  echo "$p closed"
}

cmd_close() {
  local force="" agent=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1; shift ;;
      --agent) [ -n "${2:-}" ] || die "--agent needs a name (claude or agy)"; agent="$2"; shift 2 ;;
      *) break ;;
    esac
  done
  local p="${1:?usage: rc.sh close [--force] [--agent claude|agy] <project>}" pid why
  case "$agent" in ""|claude|agy) ;; *) die "unknown agent '$agent' (claude or agy)" ;; esac
  # A project may run under both agents; --agent picks one, and without it
  # Claude Code wins (2026-11-23: a test close --force of an agy window named
  # like this very session would have closed the Claude session).
  pid=""; [ "$agent" = agy ] || pid="$(claude_pid "$p")"
  if [ -z "$pid" ] && [ "$agent" != claude ] && [ -n "$(agy_window_of "$p")" ]; then
    close_agy "$p" "$force"; return
  fi
  if [ -z "$pid" ]; then
    local win; win="$(window_of "$p")"; [ -n "$win" ] && tmux kill-window -t "$win"
    echo "$p is not open"
    return 0
  fi
  why="$(working "$pid" "$p")"
  if [ -n "$why" ] && [ -z "$force" ]; then
    echo "$p is still working ($why); not closed. rc.sh close --force $p closes it anyway." >&2
    return 2
  fi
  # A draft would swallow /exit; clear the line first when forcing.
  [ -n "$(draft "$p")" ] && tmux send-keys -t "$(window_of "$p")" C-u
  if [ "$(info "$pid" '.status')" = busy ]; then
    # Interrupt the running turn first, as Esc does in the terminal.
    tmux send-keys -t "$(window_of "$p")" Escape; sleep 2
  fi
  tmux send-keys -t "$(window_of "$p")" -l '/exit'; sleep 0.5
  tmux send-keys -t "$(window_of "$p")" Enter
  for _ in $(seq 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "$p did not exit within 30 s; see tmux window $SESSION:$p" >&2
    return 1
  fi
  tmux kill-window -t "$(window_of "$p")"
  echo "$p closed"
}

cmd_close_idle() {
  local closed=0 kept=0
  for p in $(projects); do
    local pid h why
    pid="$(claude_pid "$p")"; [ -n "$pid" ] || continue
    why="$(working "$pid" "$p")"
    h="$(idle_hours "$pid")"
    if keep_open "$p"; then
      echo "keep $p: in RC_KEEP_OPEN"; kept=$((kept + 1))
    elif [ -n "$why" ]; then
      echo "keep $p: $why"; kept=$((kept + 1))
    elif [ "$h" -lt "$IDLE_HOURS" ]; then
      echo "keep $p: idle ${h}h"; kept=$((kept + 1))
    elif cmd_close "$p"; then
      echo "  (idle ${h}h)"; closed=$((closed + 1))
    fi
  done
  echo "closed $closed, kept $kept (limit ${IDLE_HOURS}h)"
}

# After a restart every session is gone, and the projects in RC_KEEP_OPEN are
# the ones that must not be closed, so they come back with the hub. One failing
# does not stop the others (2026-11-10: only the hub came back).
cmd_boot() {
  local rc=0 p
  cmd_open hub || rc=1
  for p in $KEEP_OPEN; do cmd_open "$p" || rc=1; done
  return $rc
}

# --on <machine> may stand anywhere after the command. open and close go to
# the project's own machine unless it is given; everything else stays here.
if [ $# -gt 0 ]; then
  cmd="$1"; shift
  ON=""; rest=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --on) [ -n "${2:-}" ] || die "--on needs a machine name"; ON="$2"; shift 2 ;;
      --agent) [ -n "${2:-}" ] || die "--agent needs a name (claude or agy)"; rest+=("$1" "$2"); shift 2 ;;
      *) rest+=("$1"); shift ;;
    esac
  done
  proj=""
  prev=""
  for a in "${rest[@]+"${rest[@]}"}"; do case "$a" in -*) ;; *) [ "$prev" = --agent ] || proj="$a" ;; esac; prev="$a"; done
  if [ -n "$ON" ] && [ "$ON" != "$LOCAL_MACHINE" ]; then
    remote_run "$ON" "$cmd" "${rest[@]+"${rest[@]}"}"
    exit $?
  fi
  set -- "$cmd" "${rest[@]+"${rest[@]}"}"
fi

case "${1:-}" in
  boot) cmd_boot ;;
  list) cmd_list ;;
  where) shift; cmd_where "$@" ;;
  open) shift; cmd_open "$@" ;;
  close) shift; cmd_close "$@" ;;
  close-idle) cmd_close_idle ;;
  *) sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'; exit 64 ;;
esac
