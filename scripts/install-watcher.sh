#!/usr/bin/env bash
# Installs and starts the systemd user units that copy status/ changes into
# the dashboard database, collect usage every 10 minutes and every project's
# activity once a day. With --with-sessions, also the Claude Code sessions: the
# coordinator (hub) at login and the hourly close of idle ones (scripts/rc.sh).
# Usage: scripts/install-watcher.sh                  install / update
#        scripts/install-watcher.sh --with-sessions  also the tmux Remote Control sessions
#        scripts/install-watcher.sh --uninstall
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS=(projects-dashboard-publish.path projects-dashboard-publish.service projects-dashboard-publish.timer
       projects-dashboard-activity.service projects-dashboard-activity.timer
       projects-dashboard-usage.service projects-dashboard-usage.timer
       projects-dashboard-users.service projects-dashboard-users.timer
)
SESSION_UNITS=(claude-hub.service claude-rc-idle.service claude-rc-idle.timer)

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now projects-dashboard-publish.path || true
  systemctl --user disable --now projects-dashboard-publish.timer || true
  systemctl --user disable --now projects-dashboard-activity.timer || true
  systemctl --user disable --now projects-dashboard-usage.timer || true
  systemctl --user disable --now projects-dashboard-users.timer || true
  systemctl --user disable --now claude-rc-idle.timer || true
  # Not --now: stopping it must not close the hub (KillMode=process anyway).
  systemctl --user disable claude-hub.service || true
  for u in "${UNITS[@]}" "${SESSION_UNITS[@]}"; do rm -f "$UNIT_DIR/$u"; done
  systemctl --user daemon-reload
  echo "Watcher removed."
  exit 0
fi

WITH_SESSIONS=0
if [[ "${1:-}" == "--with-sessions" ]]; then WITH_SESSIONS=1; UNITS+=("${SESSION_UNITS[@]}"); fi

required=(git flock systemctl node gh curl jq)
(( WITH_SESSIONS )) && required+=(tmux claude)
for cmd in "${required[@]}"; do
  command -v "$cmd" >/dev/null || { echo "Missing required command: $cmd" >&2; exit 1; }
done
[[ -f "$REPO/desk.config.json" ]] || { echo "desk.config.json is missing: see docs/SETUP.md" >&2; exit 1; }
for cmd in notify-send rclone ssh; do
  command -v "$cmd" >/dev/null || echo "Note: $cmd is not installed; the features that use it stay off."
done

mkdir -p "$UNIT_DIR"
for u in "${UNITS[@]}"; do
  sed -e "s|@REPO@|$REPO|g" -e "s|@NODE@|$(command -v node)|g" -e "s|@PATH@|$PATH|g" \
    "$REPO/scripts/systemd/$u" > "$UNIT_DIR/$u"
  echo "Installed $UNIT_DIR/$u"
done
chmod +x "$REPO/scripts/publish-status.sh" "$REPO/scripts/rc.sh"

systemctl --user daemon-reload
# The path unit needs an inotify instance; when the user's are all taken it
# fails, and the 2-minute timer keeps publishing. Neither stops the install.
systemctl --user enable projects-dashboard-publish.path
if ! systemctl --user restart projects-dashboard-publish.path; then
  echo "WARNING: the path unit could not start (often: inotify instances exhausted," >&2
  echo "  see fs.inotify.max_user_instances). The 2-minute timer publishes instead." >&2
fi
systemctl --user enable --now projects-dashboard-publish.timer
systemctl --user enable --now projects-dashboard-activity.timer
systemctl --user enable --now projects-dashboard-usage.timer
systemctl --user enable --now projects-dashboard-users.timer
if (( WITH_SESSIONS )); then
systemctl --user enable --now claude-rc-idle.timer
# Enabled for the next login or boot; started now only if the hub is not open.
systemctl --user enable claude-hub.service
systemctl --user start claude-hub.service || echo "WARNING: the hub did not open; journalctl --user -u claude-hub" >&2
fi
systemctl --user --no-pager status projects-dashboard-publish.path | head -5 || true
systemctl --user list-timers --no-pager projects-dashboard-publish.timer | head -3
echo
echo "Watching $REPO/status (copied into D1). Logs: journalctl --user -u projects-dashboard-publish -f"
systemctl --user list-timers --no-pager projects-dashboard-activity.timer | head -3
echo "Daily activity logs: journalctl --user -u projects-dashboard-activity"
systemctl --user list-timers --no-pager projects-dashboard-usage.timer | head -3
echo "Usage logs (every 10 minutes): journalctl --user -u projects-dashboard-usage"
systemctl --user list-timers --no-pager projects-dashboard-users.timer | head -3
echo "User numbers (daily): journalctl --user -u projects-dashboard-users"
if (( WITH_SESSIONS )); then
  systemctl --user list-timers --no-pager claude-rc-idle.timer | head -3
  echo "Sessions: scripts/rc.sh list; idle closes: journalctl --user -u claude-rc-idle"
fi
