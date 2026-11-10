#!/usr/bin/env bash
# Deploy command for Cloudflare Workers Builds: deploys the Worker (it
# renders the page from D1) and the app files in dist/, then fails the
# build if any of its custom domains answers without an Access login.
set -euo pipefail
cd "$(dirname "$0")/.."

# Only main is production. A preview trigger or a manual build of another
# branch must never reach the live page.
branch="${WORKERS_CI_BRANCH:-}"
if [ -n "$branch" ] && [ "$branch" != "main" ]; then
  echo "Refusing to deploy branch '$branch'; only main deploys the live page." >&2
  exit 1
fi

[ -f dist/inline.mjs ] || { echo "dist/inline.mjs is missing; run the build command first." >&2; exit 1; }

node scripts/write-wrangler.mjs
npx wrangler deploy

# Every custom domain must answer with the Access login (a second domain
# added without Access would otherwise have passed). A brand-new custom domain
# can take several minutes to get its certificate (one
# needed more than 3), so retry connection errors for up to 10 minutes.
hosts=$(node scripts/custom-domains.mjs)
checked=0
for host in $hosts; do
  out=""
  for i in $(seq 1 60); do
    if out=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "https://$host/"); then
      break
    fi
    echo "$host not reachable yet (try $i), waiting 10s"; out=""; sleep 10
  done
  code=${out%% *}; location=${out#* }
  echo "$host: HTTP ${code:-none} -> ${location%%\?*}"
  [ -n "$out" ] || { echo "ERROR: $host did not respond after 10 minutes." >&2; exit 1; }
  case "$location" in
    https://*.cloudflareaccess.com/*) echo "OK: an unauthenticated request to $host is redirected to Cloudflare Access." ;;
    *) echo "ERROR: $host answered HTTP $code without an Access login. The page may be public — fix the Access application now." >&2; exit 1 ;;
  esac
  checked=$((checked + 1))
done
[ "$checked" -gt 0 ] || { echo "ERROR: no custom domain was checked." >&2; exit 1; }
echo "Checked $checked custom domain(s)."
