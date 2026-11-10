#!/usr/bin/env bash
# Copies changed status/*.json into the dashboard database, so the page
# shows them on the next load. Run by the systemd user path unit
# projects-dashboard-publish.path (and every 2 minutes by its timer); logs go
# to the user journal:  journalctl --user -u projects-dashboard-publish -f
#
# - Waits until status/ has been quiet for DEBOUNCE_SECONDS (default 30).
# - scripts/sync-status.mjs upserts the files whose content changed and
#   deletes projects whose file is gone. A file that is not JSON is left out
#   (the page keeps its last good copy), logged and reported with notify-send.
# - Nothing is committed: status files are not in git any more.
set -uo pipefail

REPO="${STATUS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEBOUNCE_SECONDS="${DEBOUNCE_SECONDS:-30}"
FAILURES_BEFORE_NOTICE=15
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/projects-dashboard"

log() { echo "$*"; }
notify() { # notify <message> [urgency]
  notify-send --app-name="Projects dashboard" --urgency="${2:-normal}" "Status publish" "$1" 2>/dev/null || true
}

# Newest mtime of status/ itself (changes on create/delete/rename) and its JSON files.
newest_mtime() {
  local m
  m=$(stat -c %Y "$REPO/status" "$REPO"/status/*.json 2>/dev/null | sort -n | tail -1)
  echo "${m:-0}"
}

# Waits until DEBOUNCE_SECONDS have passed since the last change was seen. A
# file time in the future counts as a change seen now: the wait used to
# be computed from that time, so one such file made the run sleep until it,
# holding the lock, and nothing was published. Clamping it to now is not
# enough either: every pass would then look like a fresh change.
debounce() {
  local last="" seen_at=0 m now
  while :; do
    now=$(date +%s); m=$(newest_mtime)
    if [[ $m != "$last" ]]; then
      last=$m
      if (( m > now )); then seen_at=$now; else seen_at=$m; fi
    fi
    (( now - seen_at >= DEBOUNCE_SECONDS )) && return
    sleep $(( DEBOUNCE_SECONDS - (now - seen_at) ))
  done
}

# One pass. Returns 0 when D1 holds every valid file.
publish_once() {
  local out rc
  out=$(timeout 120 node "$REPO/scripts/sync-status.mjs" 2>&1); rc=$?
  log "$out"
  # Notify once per broken file version, not on every run: other projects'
  # updates re-trigger this script while a broken file is still sitting there.
  mkdir -p "$STATE_DIR"
  local seen_file="$STATE_DIR/invalid" now_seen="" fresh=() name sha
  while read -r _ name sha _; do
    sha=${sha%:}
    now_seen+="$name $sha"$'\n'
    grep -qxF "$name $sha" "$seen_file" 2>/dev/null || fresh+=("$name")
  done < <(grep '^INVALID ' <<<"$out")
  printf '%s' "$now_seen" > "$seen_file"
  if (( ${#fresh[@]} )); then
    notify "Invalid JSON, not published: ${fresh[*]}. See journalctl --user -u projects-dashboard-publish" critical
  fi
  note_result "$rc" "$out"
  # Exit 2 is the sync refusing an empty status/ folder: nothing to publish yet.
  return "$(( rc != 0 && rc != 2 ))"
}

# A failed sync loses nothing: the next good pass copies every change. But the
# timer retries every 2 minutes, and a notice per failure put 51 on the desktop
# during one morning's DNS outage. So an outage gets one notice, once it
# has lasted FAILURES_BEFORE_NOTICE passes in a row (about 30 minutes).
note_result() { # note_result <exit code> <sync output>
  local file="$STATE_DIR/sync-failures" failures reason
  if (( $1 == 0 || $1 == 2 )); then
    rm -f "$file"
    return
  fi
  failures=$(cat "$file" 2>/dev/null)
  [[ $failures =~ ^[0-9]+$ ]] || failures=0
  failures=$(( failures + 1 ))
  echo "$failures" > "$file"
  log "sync failed ($failures in a row)"
  if (( failures == FAILURES_BEFORE_NOTICE )); then
    reason=$(grep -m1 -E '^(curl: |Error: D1)' <<<"$2")
    notify "Status has not reached the dashboard for about 30 minutes${reason:+ ($reason)}. Still retrying; no more notices until it works again." critical
  fi
}

main() {
  mkdir -p "$STATE_DIR"
  exec 9>"$STATE_DIR/publish.lock"
  if ! flock -n 9; then
    log "another publish run is active; it will pick up this change"
    exit 0
  fi

  local rc=0 started before after
  # Changes made while we are running don't re-trigger the path unit,
  # so keep going until a pass finds nothing new.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    debounce
    before=$(newest_mtime)
    started=$(date +%s)
    publish_once; rc=$?
    after=$(newest_mtime)
    (( after < started )) && break
    # A future file time that did not change during the pass is nothing new.
    (( after > started && after == before )) && break
    log "status/ changed during this run; going again"
  done
  exit "$rc"
}

main "$@"
