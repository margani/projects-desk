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
- Check that this is Linux with a systemd user session, and that node, git, gh
  (logged in), curl, jq and flock are installed.
- Ask me once for everything you need: the hostname to use, which must be on a
  domain in my Cloudflare account, and the email address allowed to sign in.
- Ask which optional features I want: GitHub usage, the Storage tab, user
  numbers, Claude Code sessions on demand, deploying on every push. Leave the
  Claude usage tab off unless I ask for it, and if I do, show me the warning
  about it in README.md first.

Do every step you can yourself. Stop and give me exact instructions, from
docs/SETUP.md, only for what needs me: logging in with wrangler, creating the
Access application, and creating the API tokens.

Rules:
- The Access application must exist before the first deploy. Confirm with me
  that it is saved before you run npm run deploy.
- Never ask me to paste a token into this chat, and never print one. I save
  tokens myself, in a separate terminal, with the commands in step 6.
- Never turn on workers_dev or preview_urls.
- Before you add the section from docs/CLAUDE_CODE.md to my ~/.claude/CLAUDE.md,
  show me the text you will add, with the real path to this clone.

When you finish, prove it worked, and tell me about anything that failed:
- npm run deploy passed its check that the domain redirects to Access.
- bin/cfapi GET /user/tokens/verify succeeds.
- systemctl --user list-timers shows the projects-dashboard timers.
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

## 1. Install

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

```sh
npx wrangler d1 create projects-desk
npx wrangler d1 execute projects-desk --remote --file=./schema.sql
```

The first command prints the database id. `npx wrangler d1 list` shows it again.
See [Getting started with D1](https://developers.cloudflare.com/d1/get-started/).

## 3. Write your config

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

Save each token without leaving it in your shell history:

```sh
mkdir -p ~/.config/cloudflare
( umask 077; cat > ~/.config/cloudflare/edit.token )   # paste, Enter, Ctrl-D
( umask 077; cat > ~/.config/cloudflare/read.token )   # paste, Enter, Ctrl-D
bin/cfapi GET /user/tokens/verify
```

`bin/cfapi` is the helper every script uses. It never prints a token. Without
the files it falls back to the `CLOUDFLARE_API_TOKEN` environment variable.

## 7. Install the watcher and timers

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

The activity timer finds each project's checkout under `~/projects`. Set
`ACTIVITY_ROOTS` (colon-separated) for other locations.

### Claude Code sessions on demand

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
