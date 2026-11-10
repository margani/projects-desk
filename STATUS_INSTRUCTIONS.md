# Project Status Instructions

These are the rules for writing project status files that feed the projects
dashboard. Read this file at the end of every work session before touching a
status file — the schema and rules may have changed since last time.

**Current schema version: 5**

## Where status files go

Each project has one status file inside this repo:

```
status/<project-name>.json
```

- `<project-name>` is the project's folder name (e.g. `blog`, `shop`).
- The `project` field inside the file must equal `<project-name>` exactly.
- One file per project. Never put multiple projects in one file.

## Schema (version 5)

The file is a single JSON object with exactly these fields. All fields are
always present; a nullable field whose value is unknown is set to `null`, not
omitted. Arrays are never `null` — use `[]` when empty.

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `schema_version` | integer | no | Always `5` for this schema. |
| `project` | string | no | Project name; same as the file name without `.json`. |
| `repo_url` | string | yes | Clickable HTTPS web URL of the repo (e.g. `https://github.com/Owner/repo`). Never an SSH `git@` remote. |
| `urls.sandbox` | string | yes | Public URL of the sandbox deployment. `null` if no sandbox. |
| `urls.production` | string | yes | Public URL of the production deployment. `null` if not deployed. |
| `version.sandbox` | string | yes | Version currently on the `sandbox` branch / sandbox deploy. `null` if no sandbox. |
| `version.production` | string | yes | Version currently live in production (on `main`). |
| `pending_release.merged_prs` | integer (≥ 0) | yes | Number of PRs merged into `sandbox` that are not yet in `main`. `null` if no sandbox. |
| `pending_release.release_pr_url` | string | yes | URL of the open `sandbox` → `main` release PR, if one exists; otherwise `null`. |
| `open_issues` | integer (≥ 0) | yes | Real count of open GitHub issues (exclude pull requests). |
| `closed_issues` | integer (≥ 0) | yes | Real count of closed GitHub issues (exclude pull requests). |
| `owner_tasks` | array of `{title, url}` | no | Every open issue assigned to the owner. Title and URL, nothing else. `[]` if none. |
| `next_steps` | array of strings | no | What is actually left to do, most important first. Max 10 items, one line each. `[]` if none. |
| `health` | string (enum) | no | One of `ok`, `attention`, `blocked`. |
| `health_reason` | string | yes | One line explaining the health value. Required (not `null`) when health is `attention` or `blocked`. |
| `last_session` | string (ISO-8601 datetime) | no | Date and time of the last work session, with timezone, e.g. `2026-10-06T21:30:00+01:00`. |
| `summary` | string | yes | One or two lines: what changed in the last session. Not a list of next steps. |
| `links` | array of `{label, url}` | no | The project's own extra links, shown as buttons after Repo / Sandbox / Production, in this order. You choose which links and their labels. At most 10. `[]` if none. See "Links" below. |
| `apps` | array of `{name, url, icon?}` | optional field | The project's apps on the dashboard's Desktop. Leave the field out to get one icon from `urls.production`. At most 10. See "Desktop apps" below. |
| `activity` | object | yes | Daily commits, closed issues and changed lines, and recent build/deploy runs. Written once a day by the laptop timer, never by hand. `null` if the project has no repo to measure. See "Activity" below. |

`health` values:
- `ok` — nothing needs the owner's attention.
- `attention` — something needs a decision or follow-up, but work is not stopped
  (e.g. a release is waiting for owner testing, owner tasks are piling up).
- `blocked` — work cannot continue until something is resolved.

## Where the data comes from

Use the real sources, not memory:

- `open_issues`:
  `gh issue list --state open --limit 1000 --json number --jq length`
- `closed_issues` (replace `OWNER/REPO`):
  `gh api -X GET search/issues -f q='repo:OWNER/REPO is:issue is:closed' --jq .total_count`
- `owner_tasks`:
  `gh issue list --state open --assignee @me --limit 100 --json title,url`
- `version.production`: the version file (`package.json`, `pyproject.toml`,
  etc.) or latest tag on `main` — read from `origin/main`, not the local
  working copy.
- `version.sandbox`: the same version file read from `origin/sandbox`.
- `pending_release.merged_prs`: count of PRs merged into `sandbox` whose
  commits are not in `main`. Use `gh pr list --base sandbox --state merged`
  and compare against `git log origin/main..origin/sandbox`. If the repo uses
  squash merges, count squash commits in that range instead of merge commits.
- `pending_release.release_pr_url`:
  `gh pr list --base main --head sandbox --state open --json url`
- Run `git fetch` first so `origin/*` refs are current.

Projects with no sandbox environment: set `urls.sandbox`, `version.sandbox`,
`pending_release.merged_prs` and `pending_release.release_pr_url` to `null`.

### Links

`links` is yours to fill: add whatever the owner would otherwise have to look
up, with a short label (one to three words) that says where it goes. For
example the Cloudflare Worker's page in the dashboard (`Worker`), the app's
F-Droid page once it is published there (`F-Droid`), a store listing, the
docs site, or the CI runs.

- Each entry is exactly `{"label": "...", "url": "https://..."}`.
- Take every URL from a real source: CLI or API output, the project's own
  config, or a page you actually opened. Never assemble one from a guessed
  pattern.
- A public page must load: `curl -sIL -o /dev/null -w '%{http_code}' <url>`
  prints `200`. Drop a link that no longer works.
- Do not repeat `repo_url`, `urls.sandbox` or `urls.production`; the dashboard
  already shows those.
- Never a URL that carries a token, a key or embedded credentials.

**Cloudflare projects always link their Worker and their domain.** If the
project runs on Cloudflare, `links` includes:

| Label | When | URL |
|---|---|---|
| `Worker` | always | `https://dash.cloudflare.com/<account_id>/workers/services/view/<worker>/production` |
| `Worker (sandbox)` | if the sandbox is a separate Worker | the same, with the sandbox Worker's name |
| `Domain` | if production is on a custom domain | `https://dash.cloudflare.com/<account_id>/<zone>` |

- These are the one exception to "never assemble a URL": the dashboard has no
  command that prints them, so build them from real values only. `account_id`
  and the Worker name come from the project's `wrangler.jsonc`/`wrangler.toml`
  (or `wrangler whoami` for the account), checked against the account the
  Worker really lives on; `zone` is the registrable domain the production URL
  sits on, as `cfapi GET /zones` lists it on that account.
- The dashboard pages need a sign-in, so `curl` cannot check them. Check the
  parts instead: the Worker exists
  (`npx wrangler deployments list --name <worker>` succeeds) and the zone is on
  that account (`cfapi GET "/zones?name=<zone>"` returns it).
- A Worker on `*.workers.dev` only has no `Domain` link.
- Both URL shapes were checked on 2026-10-12 by opening them signed in: the
  first opens the Worker's own page, the second the zone's overview.

### Desktop apps

The dashboard's first page, the Desktop, shows the projects' apps as icons the
owner opens like a user would. By default a project gets one icon, named after
the project, for `urls.production`. A project with several apps (for example
Photos, Music, Player and Download) lists them in `apps` instead:

```json
"apps": [
  { "name": "Photos", "url": "https://photos.example.dev/" },
  { "name": "Music", "url": "https://music.example.dev/app/", "icon": "https://music.example.dev/icon.png" }
]
```

- `name`: the label under the icon, at most 40 characters, unique within the
  project.
- `url`: the http(s) address the icon opens.
- `icon` (optional): an https image. Leave it out and the dashboard uses the
  app's own icon (its apple-touch-icon or favicon), or a letter tile.
- When `apps` is present it is the full list: include the production app too
  if it should stay. `"apps": []` hides the project from the Desktop.
- Each icon opens its app in a new browser tab.

### Activity

`activity` feeds the dashboard's charts (commits, closed issues, lines written
or changed, build and deploy times, per project and in total). **You do not
write it.** A systemd timer on the owner's laptop
(`projects-dashboard-activity.timer`) runs `scripts/activity-all.mjs` once a
day: it finds every project's checkout from `repo_url`, collects the numbers
and writes only this field (moving a v3 or v4 file to the current version);
the status watcher then publishes it. Leave the field as you find it when you
update the rest of the file.

To refresh one project by hand (for example right after a release):

```
node <projects-desk checkout>/scripts/activity.mjs \
  --repo <your repo checkout> \
  --status <projects-desk checkout>/status/<project-name>.json
```

- It counts the last 12 whole weeks plus the current one, per day (UTC), on
  `origin/main` and `origin/sandbox` when it exists, without merge commits.
  Lockfiles, `dist/`, `build/`, `vendor/` and minified files are not counted
  as written lines; a commit that only touches those does not count.
  Per-project extras (more excluded paths, Workers, branches) go in
  `activity.config.json` in the dashboard repo, not in your status file.
- Builds: the last 40 completed runs from GitHub Actions (`gh run list`) and
  from Cloudflare Workers Builds for every Worker in the repo's wrangler
  config, through `cfapi` (the saved read token).
- If a source is unreachable it warns and leaves that part empty; it never
  invents numbers. A project with no repo sets `"activity": null`.

Shape (for reading; the script writes it):

```json
"activity": {
  "generated_at": "2026-10-13T06:30:00Z",
  "days": [
    { "date": "2026-10-12", "commits": 4, "issues_closed": 1, "lines_added": 220, "lines_deleted": 35 }
  ],
  "builds": [
    { "system": "cloudflare", "name": "atlas", "started_at": "2026-10-12T09:00:00Z", "duration_s": 95, "conclusion": "success" }
  ]
}
```

`date` is `YYYY-MM-DD`; counts are integers ≥ 0; `system` is `github` or
`cloudflare`; `conclusion` is `success`, `failure`, `cancelled` or `other`; at
most 98 days and 50 builds. (Schema v4 had weekly `weeks` instead of `days`;
the dashboard still reads those.)

## Rules

1. **Check the schema version first.** If the file's `schema_version` is
   missing or lower than the current version, migrate it (see Migration) before
   doing anything else.
2. **Update only what changed.** Read the existing file first and change only
   the fields whose values actually changed. Keep every other field as it is.
3. **Never rewrite the file from memory.** Always start from the file's current
   contents on disk. If the file does not exist yet, create it with all fields.
4. **Unknown means `null`, never a guess.** If a value cannot be determined from
   the real project state (e.g. GitHub is unreachable, no version is defined),
   set it to `null` and mention it in the session summary.
5. **Data must reflect reality.** Counts and task lists come from GitHub,
   versions from the project itself, checked at the end of the session.
6. **The JSON must parse and match the schema.** Validate before finishing:
```
   jq . status/<project-name>.json > /dev/null
```
   Then check every field in the table above is present with the right type.
7. **Issue and PR references in text are `#N`.** In `next_steps`, `summary`
   and `health_reason`, write `#304` for this repo's issue or PR, and
   `Owner/repo#12` for another repo's. The dashboard links them against
   `repo_url`. Never put markdown or a URL inside these strings, and only cite
   numbers that exist.
8. **No secrets or private data.** Never write tokens, passwords, API keys,
   credentials, private URLs with embedded auth, or personal data into a
   status file.

## Publishing

Claude Code sessions **only write the JSON file**. Do not run `git add`,
`git commit` or `git push` in this repo, and do not open PRs against it.

A watcher on the owner's laptop notices the changed file. It waits about
30 seconds after the last write, checks that it is JSON, then copies it into
the dashboard's database; the page shows it on the next load. Status files
are not in git, so there is nothing to commit. An invalid file is not
published; the owner is notified instead. So after writing the file, run the
validation step in rule 6, and you are done.

## Migration

### From unversioned files (no `schema_version`) to version 1

- Add `"schema_version": 1`.
- `repo` → `repo_url`: convert SSH remotes to the HTTPS web URL
  (`git@github.com:Owner/repo.git` → `https://github.com/Owner/repo`).
- `version` (single string) → `version.sandbox` and `version.production`:
  re-read both from the real branches; do not copy the old value blindly.
- `my_open_tasks` (count) → `owner_tasks` (list): fetch the real list from
  GitHub.
- Remove `branch`.
- Add `urls`, `pending_release`, `next_steps`, `health_reason` and fill them
  from the real project state.
- Convert `last_session` to a full datetime with timezone.

### From version 1 to version 2

- Set `"schema_version": 2`.
- Add `"links": []`, then fill it with the project's real links as described
  in "Links". Everything else stays as it is.

### From version 2 to version 3

- Set `"schema_version": 3`.
- Add `"closed_issues"` with the real count from the command in "Where the data
  comes from". Everything else stays as it is.

### From version 3 to version 4

- Run the collector command in "Activity" with `--status`: it sets
  `"schema_version": 4` and adds `"activity"`. A project with no repo sets
  `"schema_version": 4` and `"activity": null` itself. Everything else stays as
  it is.

### From version 4 to version 5

- Nothing to do by hand: the daily timer rewrites `activity` with daily `days`
  and sets `"schema_version": 5`. If your file is still on v4 a day later, run
  the hand command in "Activity" once. A project with no repo sets
  `"schema_version": 5` and keeps `"activity": null`.

### When this schema changes in future

Bump the version number at the top of this file, add a new migration section
here describing exactly what to add, rename or remove, and record it in the
changelog below.

## Example

A complete, valid status file (`status/example-project.json`). This is a
fictional project: every value below is illustrative, not real data.

```json
{
  "schema_version": 5,
  "project": "example-project",
  "repo_url": "https://github.com/example-owner/example-project",
  "urls": {
    "sandbox": "https://sandbox.example-project.example.com",
    "production": "https://example-project.example.com"
  },
  "version": {
    "sandbox": "1.3.0",
    "production": "1.2.0"
  },
  "pending_release": {
    "merged_prs": 6,
    "release_pr_url": null
  },
  "open_issues": 3,
  "closed_issues": 41,
  "owner_tasks": [
    {
      "title": "Add the production API key in the Cloudflare dashboard",
      "url": "https://github.com/example-owner/example-project/issues/42"
    }
  ],
  "next_steps": [
    "Owner to test sandbox and approve the 1.3.0 release",
    "Fix offline sync edge case (#39)"
  ],
  "health": "attention",
  "health_reason": "6 merged PRs waiting on sandbox for owner testing before release",
  "last_session": "2026-10-06T21:30:00+01:00",
  "summary": "Fixed login redirect loop and added CSV export; both merged to sandbox.",
  "links": [
    {
      "label": "Worker",
      "url": "https://dash.example.com/workers/example-project"
    },
    {
      "label": "F-Droid",
      "url": "https://f-droid.org/packages/com.example.project/"
    }
  ],
  "activity": null
}
```

## Changelog

- **v5, 2026-10-31** — No version change: optional `apps` for the Desktop
  (see "Desktop apps"). Files without it stay valid; nothing to migrate.

- **v5, 2026-10-20** — No field change: `next_steps` may hold up to 10
  items (was 5), as each project now has its own page. Files stay on v5;
  nothing to migrate.

- **v5** — `activity` is daily (`days`) instead of weekly (`weeks`), and a
  laptop timer writes it for every project once a day; sessions no longer run
  the collector. v4 files still render, with weekly data.

- **v4** — Added `activity` (weekly commits, closed issues, changed lines and
  recent build runs), written by `scripts/activity.mjs`. The dashboard draws
  activity charts from it; v1–v3 files still render, with a note.

- **v3, 2026-10-12** — No field change: Cloudflare projects now always link
  their Worker and their domain in `links` (see "Links").

- **v3** — Added `closed_issues`. The dashboard shows totals of open and closed
  issues and the owner's tasks; v1 and v2 files still render, with a note.
- **v2** — Added `links`: the project's own extra links as `{label, url}`.
  The dashboard still shows v1 files, with a note that they need migrating.
- **v1** — Split version into sandbox/production, added URLs, pending release,
  owner task list (replaces count), next steps, health reason, schema version.
  Removed `branch`. `repo` renamed to `repo_url` (HTTPS).
- **v0** — Original unversioned flat schema.
