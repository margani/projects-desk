# projects-desk

A private dashboard of a person's projects. Claude Code sessions write one JSON
file per project into `status/`. A watcher copies them into D1, and a Worker
renders the page from D1 on every request. `README.md` is the user's view and
`docs/SETUP.md` the install; this file is for working on the code.

## Commands

```sh
npm install
npm test          # unit tests (node:test)
npm run build     # app files + dist/inline.mjs; dist/index.html from local status/*.json
npm run dev       # http://localhost:8787 from local files, rebuilds on every reload
npm run ci        # tests + build
npm run deploy    # build + scripts/deploy.sh
node scripts/sync-status.mjs   # copy status/*.json into D1 now
node scripts/usage-sync.mjs    # collect usage into D1 now
node scripts/users-sync.mjs    # read user numbers into D1 now (--dry: print only)
```

## Layout

- `status/<project>.json`: status files, ignored by git. The schema is in
  `STATUS_INSTRUCTIONS.md`, whose "Current schema version" line is the only place
  that names the version.
- `desk.config.json` (from `desk.config.example.json`), or the environment
  variable `DESK_CONFIG_JSON` on a hosted build: Worker name, D1 ids, domains,
  the Claude tab. Read by `scripts/lib/config.mjs`.
  `scripts/write-wrangler.mjs` generates `wrangler.jsonc` from it.
- `schema.sql`: D1 tables `status` (project, body, sha, updated_at) and `usage`
  (key, body, updated_at; keys `github`, `storage`, `apps`, `claude`, `users`).
- `src/worker.mjs` and `scripts/lib/worker.mjs`: the Worker. `/`, `/index.html`
  and `/version.json` read D1 and render; everything else is a static asset. A
  D1 failure answers 503 with the reason, never an empty page.
- `scripts/lib/site.mjs`: `renderSite()`, shared by the Worker and the local
  build so both give the same page. Open pages poll `version.json` and show an
  update notice.
- `scripts/lib/render.mjs`, `desktop-render.mjs`, `activity-render.mjs`,
  `storage-render.mjs`, `claude-render.mjs`: HTML. `src/styles.css` and
  `src/client.js` are inlined. One HTML file, split into views by the URL hash.
- `scripts/build.mjs`: app files and `dist/inline.mjs`. PWA manifest and
  `src/sw.js` too. The manifest link needs `crossorigin="use-credentials"`, or
  Access answers the manifest request with its login redirect.
- `scripts/lib/schema.mjs`: validator, mirrors `STATUS_INSTRUCTIONS.md`.
- `scripts/lib/d1.mjs`: the computer's D1 client, through `bin/cfapi`.
- `scripts/sync-status.mjs`, `usage-sync.mjs`, `users-sync.mjs`,
  `activity-all.mjs`: collectors run by the timers in `scripts/systemd/`.
  Each failed source keeps its last good numbers and shows a problem.
- `bin/cfapi`: Cloudflare API helper with the saved tokens, never prints one.
- `scripts/lib/claude-usage.mjs`, `claude-advice.mjs`: the optional Claude tab.
  The endpoint is undocumented, so every field is optional and a changed shape
  becomes a `problem`.
- `scripts/rc.sh`, `scripts/rc-session.sh`, `hub/CLAUDE.md`: optional Claude Code
  sessions in tmux.
- `scripts/deploy.sh`: deploys, then fails if a custom domain answers without an
  Access login.

## Rules

- **Nothing reachable from `src/worker.mjs` may compute a path from
  `import.meta.url` at load time.** It is undefined in the Worker bundle, and the
  Worker crashes at startup. `scripts/lib/config.mjs` and `repo-bin.mjs` must stay
  out of that import graph; pass values in instead. A test covers this.
- The page makes no API calls. The Worker reads D1 and nothing else at request
  time. External sources are read on the computer by the timers.
- No framework. `wrangler` is the only dependency.
- `workers_dev` and `preview_urls` stay `false`, so no address can bypass Access.
  A new domain goes into the Access app first, then into the config. Removing one
  goes the other way.
- A broken status file must never fail the build. It renders as a warning card.
- Null fields are hidden, never shown as "null".
- A schema change goes in `STATUS_INSTRUCTIONS.md` first (bump `schema_version`,
  add a migration), then `scripts/lib/schema.mjs` and the renderer. Keep the
  previous version readable (`OLDEST_RENDERED_VERSION`, `FIELDS_BY_VERSION`),
  because projects migrate one session at a time. A change that keeps every
  existing file valid is not a bump.
- Tests use their own fixtures and never read the real `status/` or the private
  config files. A new test must fail on the old code first.
- The systemd units keep the name `projects-dashboard-*`, and `usage` and `status`
  keep their columns, so an existing install can move over without a data
  migration.
- Never commit private data: account ids, real project names, email addresses,
  screenshots of real status. Screenshots use demo data only.

## Checking a UI change

Run the page locally and look at it at 1280 px and 390 px, light and dark, with
Playwright or a browser. To run the real Worker, keep its database outside the
repository:

```sh
node scripts/write-wrangler.mjs && npm run build
npx wrangler d1 execute <name> --local --persist-to /tmp/desk-d1 --file=./schema.sql
npx wrangler dev --local --persist-to /tmp/desk-d1
```

## Lessons

- Anything run by a timer notifies once per outage, not once per failure. A
  notice per retry put dozens on the desktop during one DNS outage.
- `df` hangs on a stuck rclone FUSE mount, so the storage collector skips
  `fuse.rclone` (`skip_types`) and counts those remotes with `rclone about`.
- A new domain's certificate can take minutes. The deploy check waits up to 10
  minutes for a host to connect, so read the domain's real state before treating
  a timeout as a broken deploy.
- `.gitignore` says `node_modules`, not `node_modules/`, because the slash form
  misses a worktree's symlink. Stage files by name in worktrees.
- Overrides for a display mode go through a variable (`--titlebar-h`) that the
  main rule reads. A second rule in a media query can lose to a later `top: 0`.
- The path unit needs an inotify instance and fails when the user's are all
  taken. The 2-minute timer is the fallback. Check
  `systemctl --user status projects-dashboard-publish.path` when changes stop.
- Use interactive `claude --remote-control`, never server mode
  (`claude remote-control`). With "Require trusted devices" on, server mode cannot
  create a session.
