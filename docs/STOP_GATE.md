# Stop gate

An optional Claude Code [`Stop` hook](https://code.claude.com/docs/en/hooks#stop).
When a session ends with a closing such as "Task done; start the next one in a
fresh session (/clear)." while its project still has open issues, the stop is
blocked and the session gets the list.

## Set up

It needs Node 22, `git` and a logged-in `gh`. Add this to `~/.claude/settings.json`,
next to any `Stop` hooks already there, with the real path of this checkout:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node \"/path/to/projects-desk/scripts/stop-gate.mjs\"", "timeout": 90 }
        ]
      }
    ]
  }
}
```

To turn it off, remove that entry.

## What does not block

- Any reply that is not a closing. GitHub is not even read.
- Issues assigned to the account `gh` is logged in as (or `STOP_GATE_OWNER`).
- Issues labelled `needs-owner`, `awaiting-release` or `other-session`.
- Issues listed in `owner_tasks` of the project's status file.
- Repositories you can only read.

## Which repository

The `origin` of the project folder. If the folder is not a checkout: `repo_url`
of its status file, else the child checkout with the folder's name, else every
child checkout (at most 6).

## Limits

- After 3 blocks with no issue closed or marked, or 15 blocks in a row, the
  session may stop and you see a warning with what is left.
- If GitHub cannot be read, the session may stop and you see a warning.
- The block counts are kept in `~/.local/state/claude-stop-gate/`.
- Only the English closings are recognised.
