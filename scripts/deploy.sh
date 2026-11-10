#!/usr/bin/env bash
# Deploy command for Cloudflare Workers Builds. scripts/lib/deploy.mjs does the
# work, so that a deploy from PowerShell runs the same checks.
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/deploy.mjs" "$@"
