# Telling Claude Code about the dashboard

Add the section below to your global `~/.claude/CLAUDE.md`, so that every
project's session keeps its status file current. Replace the path with where
you cloned this repository. On Windows, `~` is your user folder.

````markdown
## Project status JSON (for my dashboard)
- Dashboard project: ~/projects/projects-desk
- Central instructions file (single source of truth for the schema):
  ~/projects/projects-desk/STATUS_INSTRUCTIONS.md
- Never define or guess the schema yourself. It lives only in that file.

### When to update
Update the status file as soon as any of these happens, without waiting for the
session to end:
- A version changes or a release is cut.
- A PR is merged into a main or sandbox branch.
- An issue is opened, closed, or assigned to me.
- Project health changes (something becomes blocked or needs my attention).
- The file's `schema_version` is older than the "Current schema version" in the
  central instructions file. Check this at the start of a session.
Update it once more before your final summary.

### How to update
1. Read the central instructions file first, every time.
2. Open status/<project-name>.json in the dashboard project (create it if
   missing).
3. If `schema_version` is older than the current schema, migrate first.
4. Update only the fields that changed. Never rewrite from memory.
5. Validate the JSON before moving on.
- Data must reflect reality. Unknown values are null.
- Do not commit status files: they are ignored by git, and the watcher copies
  them to the dashboard.
- Never write secrets, tokens, or private data into the status file.
````

To check one project by hand, ask a session in that project to update its status
file, then watch it arrive:

```sh
journalctl --user -u projects-dashboard-publish -f
```

`node scripts/check-status.mjs` lists any status file that does not match the
schema. A broken file never fails a build: it shows as a warning card on the
page.
