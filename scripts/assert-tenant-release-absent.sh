#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
[[ "$RELEASE_TAG" =~ ^3\.86\.0-fh\.(0|[1-9][0-9]*)$ ]]

status=$(curl --silent --show-error --max-time 30 \
  --output "$RUNNER_TEMP/existing-release.json" --write-out '%{http_code}' \
  --header "Authorization: Bearer $GH_TOKEN" \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  "https://api.github.com/repos/tonyawino/ghostfolio/releases/tags/$RELEASE_TAG")
case "$status" in
  404) echo 'GitHub release is absent; initial publication is allowed.' ;;
  200) echo 'GitHub release already exists; refusing image publication.' >&2; exit 1 ;;
  *) echo "Cannot establish release absence (GitHub API status $status)." >&2; exit 1 ;;
esac
