# Setup

## Let Claude Code do it

Paste this prompt into [Claude Code](https://code.claude.com/docs). It does the
install and stops only for the few things that need you in a browser: signing
in to Cloudflare, creating the Access application, and creating two API tokens.

```text
Install projects-desk for me on this computer, a private dashboard of my
projects.

If this folder is not already a clone of it, clone
https://github.com/margani/projects-desk into ~/projects/projects-desk and work
there. Read docs/SETUP.md and README.md first, and follow docs/SETUP.md in
order. Those files are the source of truth, so do not rely on memory for any
step.

Before you start:
- Find out which system this is: Windows, macOS or Linux. On Windows use
  PowerShell, not WSL or bash. Check that node (22 or newer), git and gh (logged
  in) are installed, and install what is missing with the commands in step 1.
- On Windows always write npm.cmd and npx.cmd, because plain npm and npx start
  .ps1 scripts that Windows blocks by default. Do not change the execution
  policy.
- Ask me once for everything you need: the hostname to use, which must be on a
  domain in my Cloudflare account, and the email address allowed to sign in.
- Ask which optional features I want: GitHub usage, the Storage tab, user
  numbers, deploying on every push, and on Linux only, Claude Code sessions on
  demand. Leave the Claude usage tab off unless I ask for it, and if I do, show me the warning
  about it in README.md first.

Do every step you can yourself. Stop and give me exact instructions, from
docs/SETUP.md, only for what needs me: logging in with wrangler, creating the
Access application, and creating the API tokens.

Rules:
- The Access application must exist before the first deploy. Confirm with me
  that it is saved before you deploy (step 5).
- Never ask me to paste a token into this chat, and never print one. I save
  tokens myself, in a separate terminal, with the commands in step 6.
- Never turn on workers_dev or preview_urls.
- Before you add the section from docs/CLAUDE_CODE.md to my ~/.claude/CLAUDE.md,
  show me the text you will add, with the real path to this clone.

When you finish, prove it worked, and tell me about anything that failed:
- npm run deploy passed its check that the domain redirects to Access.
- node bin/cfapi.mjs GET /user/tokens/verify succeeds.
- The watcher runs: node scripts/watch.mjs --status on Windows and macOS, or
  systemctl --user list-timers showing the projects-dashboard timers on Linux.
- A status file you write for this project reaches D1. It should be on the page
  about half a minute later, and I will sign in and confirm that I can see it.
```

If you would rather do it yourself, carry on below.

## Do it yourself

This takes you from a fresh clone to a private dashboard on your own domain. Do
the steps in order: the domain is protected by Access **before** the Worker
answers on it.

The Cloudflare steps below were checked against Cloudflare's documentation in
November 2026. Dashboard labels change, so each step links its source.

The commands work on Windows, macOS and Linux. Where they differ there is a
PowerShell block for Windows and a shell block for the others. Windows needs no
WSL, no bash and no change to the execution policy. PowerShell blocks `.ps1`
scripts by default, and plain `npm` is one, so on Windows always write `npm.cmd`
and `npx.cmd`.

## 1. Install

First install Node.js 22 or newer, Git and the GitHub CLI.

On Windows, in PowerShell:

```powershell
winget install --id OpenJS.NodeJS.LTS -e --source winget
winget install --id Git.Git -e --source winget
winget install --id GitHub.cli --source winget
```

Then close PowerShell and open a new window, because a new tab does not see the
updated `PATH`.

On macOS, with [Homebrew](https://brew.sh/):

```sh
brew install node git gh
```

On Linux, use your distribution's packages. The watcher also needs `curl`, `jq`,
`flock` and a systemd user session.

Log in to GitHub with `gh auth login`. Then, in the clone:

```powershell
npm.cmd install
npx.cmd wrangler login
npx.cmd wrangler whoami   # shows your account id
```

```sh
npm install
npx wrangler login
npx wrangler whoami   # shows your account id
```

Your domain must be an active zone on this Cloudflare account, because
[Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
require one. Use a hostname with no existing CNAME record, for example
`desk.example.com`. Cloudflare creates the DNS record and certificate itself.

## 2. Create the database

```powershell
npx.cmd wrangler d1 create projects-desk
npx.cmd wrangler d1 execute projects-desk --remote --file=./schema.sql
```

```sh
npx wrangler d1 create projects-desk
npx wrangler d1 execute projects-desk --remote --file=./schema.sql
```

The first command prints the database id. `wrangler d1 list` shows it again.
See [Getting started with D1](https://developers.cloudflare.com/d1/get-started/).

## 3. Write your config

```powershell
Copy-Item desk.config.example.json desk.config.json
```

```sh
cp desk.config.example.json desk.config.json
```

| Field | Value |
|---|---|
| `worker_name` | The Worker's name, for example `projects-desk`. |
| `d1.account` | Your Cloudflare account id. |
| `d1.database` | The database id from step 2. |
| `d1.name` | The database name from step 2. |
| `domains` | The hostnames the page answers on. |
| `claude` | `true` turns on the Claude usage tab. See the README first. |

`desk.config.json` is ignored by git, and so is the `wrangler.jsonc` generated
from it. Check the result with `node scripts/write-wrangler.mjs`.

## 4. Protect the domain with Cloudflare Access

Access is deny by default, so create the application and an Allow policy first.
From [Publish a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/):

1. In the Cloudflare dashboard go to **Zero Trust** > **Access controls** >
   **Applications** and select **Create new application**.
2. Choose **Self-hosted and private**.
3. Select **Add public hostname** and enter each hostname from `domains`.
4. Add an **Access policy** with the action Allow and a rule for your own email.
5. Save the application.

The generated Wrangler config sets `workers_dev` and `preview_urls` to `false`
so that no `*.workers.dev` address can bypass Access, as
[Cloudflare recommends](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
Do not turn them on.

## 5. Deploy

```powershell
npm.cmd run deploy
```

```sh
npm run deploy
```

This builds the page, runs `wrangler deploy`, and then checks that an anonymous
request to every domain is redirected to Access. The deploy **fails** if one is
not. A new domain's certificate can take a few minutes, and the check waits up
to 10 minutes for the host to connect.

Open your domain and sign in. You should see an empty dashboard.

### Optional: deploy on every push

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) can
replace `npm run deploy`. In the dashboard go to **Workers & Pages**, select the
Worker, then **Settings** > **Builds** > **Connect**, and follow the prompts.
Use these [build settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/):

| Setting | Value |
|---|---|
| Build command | `npm run ci` |
| Deploy command | `bash scripts/deploy.sh` |
| Build variables and secrets | `DESK_CONFIG_JSON` = the full contents of `desk.config.json` |

The build has no `desk.config.json`, so it reads that variable instead. The
Worker's name on the dashboard must equal `worker_name`. `scripts/deploy.sh`
refuses to deploy any branch other than `main`.

## 6. Create the API tokens

The laptop writes to D1 through the Cloudflare API. It uses two tokens, so the
frequent reads never hold write access. From
[Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/):

1. Go to **My Profile** > [**API Tokens**](https://dash.cloudflare.com/profile/api-tokens)
   and select **Create Token**, then **Create Custom Token**.
2. Name it, and add the **Permissions** below under Account.
3. Select **Continue to summary**, then **Create Token**. The value is shown once.

| Token | File | Permissions |
|---|---|---|
| Edit | `~/.config/cloudflare/edit.token` | D1 Edit |
| Read | `~/.config/cloudflare/read.token` | D1 Read |

Add these to the read token only if you use the feature
([permission names](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)):

| Feature | Extra permissions on the read token |
|---|---|
| Build times on Activity and Builds | Account Settings Read, Workers Scripts Read, Workers CI Read (the [Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/) page calls this one Workers Builds Configuration, and needs a user token, which these steps create). |
| R2 sizes on Storage | Workers R2 Storage Read, Account Analytics Read |
| D1 limits on Storage | Billing Read. Without it the D1 row shows sizes and the note "plan unknown, so no limit to compare with". |

Save each token without leaving it in your shell history. This is the same on
every system: run a command, paste the token, press Enter.

```text
node bin/cfapi.mjs --save edit
node bin/cfapi.mjs --save read
node bin/cfapi.mjs GET /user/tokens/verify
```

On Windows the files are in `%USERPROFILE%\.config\cloudflare\`. `bin/cfapi.mjs`
is the helper every script uses. It never prints a token. Without the files it
falls back to the `CLOUDFLARE_API_TOKEN` environment variable.

## 7. Install the watcher and timers

On Windows and macOS:

```text
node scripts/install-autostart.mjs
node scripts/watch.mjs --status
```

This starts one small background program, now and at every login: a `.cmd` file
in your Startup folder on Windows, a LaunchAgent on macOS. Neither needs an
administrator. It does the jobs in the table below, and catches up on a daily
job when the computer was off at its time. A failed publish loses nothing, and
you get one desktop notice per outage, after about 30 minutes.

| Command | What it does |
|---|---|
| `node scripts/watch.mjs --status` | Says whether it is running, and when each job last ran. |
| `node scripts/watch.mjs --stop` | Stops it until the next login. |
| `node scripts/watch.mjs --once` | Publishes the status files now, and shows the result. |
| `node scripts/install-autostart.mjs --remove` | Stops it and removes it from login. |

Its log is `watch.log` in `~/.local/state/projects-dashboard`, or on Windows
`%USERPROFILE%\.local\state\projects-dashboard`.

On Linux:

```sh
scripts/install-watcher.sh
```

This installs systemd user units:

| Unit | What it does |
|---|---|
| `projects-dashboard-publish.path` and `.timer` | Copies changed `status/*.json` into D1, on a change and every 2 minutes. |
| `projects-dashboard-usage.timer` | Collects GitHub usage, storage and app icons every 10 minutes. |
| `projects-dashboard-activity.timer` | Collects each project's daily activity. |
| `projects-dashboard-users.timer` | Reads each project's user numbers once a day. |

A failed publish loses nothing, and you get one desktop notice per outage, after
about 30 minutes. Logs: `journalctl --user -u projects-dashboard-publish -f`.
`scripts/install-watcher.sh --uninstall` removes everything.

To keep the timers running while you are logged out, enable lingering with
`loginctl enable-linger "$USER"`.

## 8. Tell Claude Code about it

Add the text in [CLAUDE_CODE.md](CLAUDE_CODE.md) to your `~/.claude/CLAUDE.md`.
The next session that works on a project writes that project's status file, and
it shows on the page about half a minute later.

## Optional features

Each one has a tracked example. Copy it without `.example`, and edit the copy,
which git ignores.

| File | Feature |
|---|---|
| `github-usage.config.example.json` | GitHub Actions minutes and storage per account. A personal account needs `gh auth refresh -h github.com -s user`. |
| `storage-usage.config.example.json` | The Storage tab: local disks, ssh hosts, rclone remotes, D1 and R2. |
| `users.config.example.json` | Each project's user numbers, read from its own D1 database. |
| `activity.config.example.json` | Per-project exclusions for the activity numbers. |

The activity job finds each project's checkout under `~/projects`. Set
`ACTIVITY_ROOTS` for other locations, separated by `;` on Windows and `:`
elsewhere.

On Windows and macOS, the Storage tab's `local` source shows the disk holding
each path you list, read through Node. An `ssh` or `rclone` source needs that
program installed.

### Claude Code sessions on demand

This one is Linux only, because it is built on tmux and systemd. Everything else
works on all three systems.

```sh
scripts/install-watcher.sh --with-sessions   # also needs tmux and claude
scripts/rc.sh list
scripts/rc.sh open my-project
scripts/rc.sh close my-project
```

Each project becomes a window of the tmux session `claude-rc`, reachable from
your phone over Remote Control. Sessions idle for 24 hours are closed, except
those named in `RC_KEEP_OPEN`. Projects are the folders next to this repository
unless you set `PROJECTS_DIR`. A coordinator session, `hub`, opens at login and
hands work to the project sessions. Its instructions are in `hub/CLAUDE.md`.
