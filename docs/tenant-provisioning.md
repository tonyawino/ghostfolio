# Tenant provisioning derivative releases

This public derivative starts from upstream Ghostfolio **3.86.0**, commit
`ef47c0d1b2c48fa4e97fb381561b514e657928cf`. Its source branch is
`finance-hub/3.86.0` in [tonyawino/ghostfolio](https://github.com/tonyawino/ghostfolio).
The upstream AGPL-3.0 license and source are included in every release archive.

## Exact image to source mapping

Each `3.86.0-fh.N` GitHub release carries these downloadable assets:

- `ghostfolio-3.86.0-fh.N-source.tar.gz`: `git archive` of the exact tagged commit,
  compressed with `gzip -n`, including migrations, tests, lockfile, Dockerfile,
  entrypoint, workflow, license, and this document.
- `ghostfolio-3.86.0-fh.N-source.tar.gz.sha256`: SHA256 of that archive.
- `ghostfolio-3.86.0-fh.N-manifest.json`: the OCI index digest and each published
  architecture's manifest digest mapped to the source archive URL/checksum,
  upstream commit, derivative commit, build workflow run, build input hashes,
  and pinned Node index/platform digests.
- `oci-index.json`: the published registry index, including descriptors for
  BuildKit provenance and SBOM attestations.

The image name is `ghcr.io/tonyawino/ghostfolio:3.86.0-fh.N`. Use the index digest
from the release manifest for deployment, for example
`ghcr.io/tonyawino/ghostfolio@sha256:<index-digest>`. The image labels also contain
its derivative commit, source archive URL, and source checksum. No floating image
tag is produced, and the authenticated registry preflight refuses an existing
version tag or an indeterminate registry response. Source archive links use this exact form:

```text
https://github.com/tonyawino/ghostfolio/releases/download/3.86.0-fh.N/ghostfolio-3.86.0-fh.N-source.tar.gz
```

To verify a specific release, replace the example version with the chosen one:

```sh
version=3.86.0-fh.1
mkdir release-source
cd release-source
gh release download "$version" --repo tonyawino/ghostfolio \
  --pattern '*-source.tar.gz' --pattern '*-source.tar.gz.sha256' \
  --pattern '*-manifest.json' --pattern 'oci-index.json'
sha256sum -c "ghostfolio-$version-source.tar.gz.sha256"
jq '.source, .image, .build' "ghostfolio-$version-manifest.json"
index=$(jq -r '.image.indexDigest' "ghostfolio-$version-manifest.json")
docker buildx imagetools inspect "ghcr.io/tonyawino/ghostfolio@$index"
```

Check that the registry platform digests match the manifest. Attestation
manifests use `unknown/unknown` descriptors and are recorded separately from the
three runnable platforms. The generated JSON requires an attestation descriptor
for every runnable platform; `provenance: mode=max` and `sbom: true` are enabled
for the release build.

## Build inputs and rebuild

Both Dockerfile stages are pinned to the official multiarch Node image:

```text
docker.io/library/node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
```

This index was verified from Docker Hub registry metadata on the Dell development
server on 2026-10-15 with `docker buildx imagetools inspect`. Its official source
is [nodejs/docker-node at 81f419144a1251854c6d9afb09eaa39928e724e8](https://github.com/nodejs/docker-node/tree/81f419144a1251854c6d9afb09eaa39928e724e8/22/bookworm-slim).
`.config/tenant-node-base.json` records the index, selected platform digests,
verification command, and source. The release JSON includes that record and the
SHA256 of the Dockerfile, entrypoint, release workflows, Node record, and npm
lockfile. The builder runs on `linux/amd64`; runtime images target `linux/amd64`,
`linux/arm/v7`, and `linux/arm64/v8`.

Rebuild the exact source without publishing:

```sh
tar -xzf "ghostfolio-$version-source.tar.gz"
cd "ghostfolio-$version"
node scripts/tenant-release.mjs check
docker buildx build --platform linux/amd64,linux/arm/v7,linux/arm64 \
  --provenance=mode=max --sbom=true --output type=oci,dest=ghostfolio-rebuild.oci .
```

The archived source and pinned base/lockfile reproduce the build recipe. Exact
image digest reproducibility is not promised: the Dockerfile still installs
Debian packages from live repositories, and build tools, timestamps, generated
assets, and attestation metadata can differ. Compare the recorded inputs and
provenance rather than assuming a fresh build has identical bytes.

## Checks and release gate

`.github/workflows/tenant-image.yml` runs focused guard, service, controller,
user initialization/deletion, route authentication, and release metadata tests.
Pull requests targeting the derivative branch also build the production Docker
image without pushing it. Jobs have explicit timeouts, cancel superseded runs,
and pin every action to its upstream commit. No complete upstream suite runs in
this workflow.

The optional `workflow_dispatch` input `integration=true` runs only the disposable
Compose integration suite with synthetic credentials, an internal network, and
a fresh project name. Its cleanup always removes the test database volume. To
run it locally on a Docker host:

```sh
export COMPOSE_PROJECT_NAME="tenant-it-$(date +%s)-$$"
trap 'docker compose -f docker/compose.tenant-provisioning-test.yaml down --volumes --remove-orphans --timeout 20' EXIT
timeout 35m docker compose -f docker/compose.tenant-provisioning-test.yaml up \
  --build --abort-on-container-exit --exit-code-from integration-tests integration-tests
```

Publication requires a pushed tag matching `3.86.0-fh.N`, the exact official
repository, a public repository, and a tag commit reachable from the fetched
`finance-hub/3.86.0` branch and descended from the recorded upstream commit.
Focused checks must pass before the publishing job starts. GitHub release
preflight requires a confirmed API 404; an existing release, authentication
error, rate limit, or other uncertain response stops image publication. Manual runs cannot
publish. The upstream Docker Hub workflow excludes derivative tags. The only
credential is `GITHUB_TOKEN`; only the image job has `packages: write`, and only the dependent source-release
job has `contents: write`. The image job publishes the three platform images
with provenance and SBOM, then outputs its immutable digest, source commit, and
archive checksum. The separate source-release job reads that digest and creates
the public GitHub release with the source and manifest assets. Assets are uploaded to a draft first; only a complete draft becomes public.
Retries may finish the same draft, and existing public releases are not replaced.
Derivative PRs are excluded from the upstream full-suite workflow.

GitHub initially publishes Container registry packages as private, even when the
source repository is public. Before the first release completes, the owner must
set the `ghostfolio` container package to public in its GitHub package settings;
see [GitHub's visibility instructions](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).
The source-release job runs on a fresh runner with no registry login and reads
the already-published index by digest before creating the release. This proves
anonymous access before a release digest is offered for Coolify. If the first
run stops at this check, change package visibility and use **Re-run failed jobs**.
The successful image job is retained; the source-release job reuses its digest
and verifies the regenerated source archive against its original checksum.
Do not rerun all jobs: the image preflight intentionally refuses to overwrite
an existing version tag. If tag preflight finds an image but there is no
successful image job to reuse, preserve its digest and provenance, stop that
release, and reconcile its source evidence before choosing a new version. Never
move or overwrite the existing version tag. No additional publishing secret is
required.

Creating a release tag is a separate operator action. If publishing succeeds
but a later source/release upload fails, the workflow run is failed; do not deploy
that digest until its exact source assets and manifest are available. Use **Re-run failed jobs** to retry source publication against the completed
image job's original digest and source checksum; this never rebuilds or retags
the image. Repository billing or package permissions can block hosted
jobs; a local build alone does not establish that GHCR publication succeeded.
