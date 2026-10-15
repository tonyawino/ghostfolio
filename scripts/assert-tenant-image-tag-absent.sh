#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_ACTOR:?GITHUB_ACTOR is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
[[ "$RELEASE_TAG" =~ ^3\.86\.0-fh\.(0|[1-9][0-9]*)$ ]]

registry_token=$(curl --fail-with-body --silent --show-error --max-time 30 \
  --user "$GITHUB_ACTOR:$GH_TOKEN" \
  'https://ghcr.io/token?service=ghcr.io&scope=repository:tonyawino/ghostfolio:pull' | jq -er .token)
status=$(curl --silent --show-error --max-time 30 \
  --output "$RUNNER_TEMP/existing-manifest.json" --write-out '%{http_code}' \
  --header "Authorization: Bearer $registry_token" \
  --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json' \
  "https://ghcr.io/v2/tonyawino/ghostfolio/manifests/$RELEASE_TAG")
case "$status" in
  404) echo 'Version tag is absent; initial publication is allowed.' ;;
  200) echo 'Version tag already exists; refusing to overwrite it.' >&2; exit 1 ;;
  *) echo "Cannot establish tag absence (registry status $status)." >&2; exit 1 ;;
esac
