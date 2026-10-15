import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkNodeBase,
  createManifest,
  validateRelease
} from './tenant-release.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const release = {
  tag: '3.86.0-fh.1',
  commit: 'a'.repeat(40),
  indexDigest: digest('b'),
  repository: 'tonyawino/ghostfolio'
};

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'tenant-release-'));
  try {
    for (const directory of [
      '.config',
      '.github/workflows',
      'docker',
      'scripts'
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    for (const path of [
      'Dockerfile',
      '.config/tenant-node-base.json',
      '.github/workflows/tenant-image.yml',
      '.github/workflows/docker-image.yml',
      '.github/workflows/build-code.yml',
      'docker/entrypoint.sh',
      'scripts/assert-tenant-image-tag-absent.sh'
    ]) {
      writeFileSync(
        join(root, path),
        readFileSync(new URL(`../${path}`, import.meta.url))
      );
    }
    writeFileSync(join(root, 'package-lock.json'), '{}');
    const archivePath = join(root, `ghostfolio-${release.tag}-source.tar.gz`);
    writeFileSync(archivePath, 'exact source archive');
    const manifests = [
      { os: 'linux', architecture: 'amd64' },
      { os: 'linux', architecture: 'arm', variant: 'v7' },
      { os: 'linux', architecture: 'arm64' }
    ].flatMap((platform, i) => {
      const childDigest = digest(String(i + 1));
      return [
        { platform, digest: childDigest },
        {
          platform: { os: 'unknown', architecture: 'unknown' },
          digest: digest(String(i + 4)),
          annotations: {
            'vnd.docker.reference.type': 'attestation-manifest',
            'vnd.docker.reference.digest': childDigest
          }
        }
      ];
    });
    return callback({
      ...release,
      root,
      archivePath,
      runUrl: 'https://github.com/tonyawino/ghostfolio/actions/runs/1',
      index: {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('accepts only explicit derivative release versions and full identities', () => {
  validateRelease(release);
  for (const tag of ['latest', '3.86.0', '3.86.0-fh.01', '3.86.0-fh.1\n']) {
    assert.throws(() => validateRelease({ ...release, tag }));
  }
  assert.throws(() =>
    validateRelease({ ...release, repository: 'other/fork' })
  );
  assert.throws(() => validateRelease({ ...release, commit: 'abc' }));
  assert.throws(() =>
    validateRelease({ ...release, indexDigest: 'sha256:abc' })
  );
});

test('maps each runnable digest and attestation to checksummed source and inputs', () =>
  fixture((input) => {
    const manifest = createManifest(input);
    assert.equal(manifest.image.indexDigest, release.indexDigest);
    assert.equal(manifest.image.platforms.length, 3);
    assert.equal(manifest.image.attestations.length, 3);
    assert.match(manifest.source.archiveSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.source.derivativeCommit, release.commit);
    assert.equal(
      manifest.source.archiveUrl,
      'https://github.com/tonyawino/ghostfolio/releases/download/3.86.0-fh.1/ghostfolio-3.86.0-fh.1-source.tar.gz'
    );
    for (const platform of manifest.image.platforms) {
      assert.deepEqual(platform.source, manifest.source);
      assert.equal(
        platform.nodeRuntimeBaseDigest,
        manifest.build.nodeBase.platforms[platform.platform]
      );
    }
    assert.match(manifest.build.files.Dockerfile.sha256, /^[a-f0-9]{64}$/);
  }));

test('refuses missing, duplicate, and unexpected runtime architectures', () =>
  fixture((input) => {
    for (const manifests of [
      input.index.manifests.slice(2),
      [...input.index.manifests, input.index.manifests[0]],
      [
        ...input.index.manifests,
        {
          digest: digest('9'),
          platform: { os: 'linux', architecture: 's390x' }
        }
      ]
    ]) {
      assert.throws(() =>
        createManifest({ ...input, index: { ...input.index, manifests } })
      );
    }
  }));

test('refuses a release without per-platform attestations or with an unrelated archive name', () =>
  fixture((input) => {
    assert.throws(() =>
      createManifest({
        ...input,
        index: {
          ...input.index,
          manifests: input.index.manifests.filter((x) => !x.annotations)
        }
      })
    );
    assert.throws(() =>
      createManifest({
        ...input,
        archivePath: join(input.root, 'other.tar.gz')
      })
    );
  }));

test('refuses drift between Dockerfile stages and the Node registry evidence', () =>
  fixture(({ root }) => {
    checkNodeBase(root);
    const dockerfile = join(root, 'Dockerfile');
    writeFileSync(
      dockerfile,
      readFileSync(dockerfile, 'utf8').replace('FROM node:', 'FROM node:other-')
    );
    assert.throws(() => checkNodeBase(root));
  }));

test('publication preflight allows only a confirmed absent version tag', () =>
  fixture(({ root }) => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh
case "$*" in
  *ghcr.io/token*)
    if [ "$MOCK_TOKEN_FAILURE" = true ]; then exit 22; fi
    printf '{"token":"synthetic-registry-token"}' ;;
  *) printf '%s' "$MOCK_REGISTRY_STATUS" ;;
esac
`
    );
    writeFileSync(
      join(bin, 'jq'),
      '#!/bin/sh\ncat >/dev/null\nprintf synthetic-registry-token\n'
    );
    chmodSync(join(bin, 'curl'), 0o755);
    chmodSync(join(bin, 'jq'), 0o755);
    const run = (status, extra = {}) =>
      spawnSync(
        '/bin/bash',
        [
          fileURLToPath(
            new URL('./assert-tenant-image-tag-absent.sh', import.meta.url)
          )
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GITHUB_ACTOR: 'synthetic-actor',
            GH_TOKEN: 'synthetic-github-token',
            RELEASE_TAG: release.tag,
            RUNNER_TEMP: root,
            MOCK_REGISTRY_STATUS: status,
            ...extra
          }
        }
      );
    assert.equal(run('404').status, 0);
    for (const status of ['200', '401', '403', '429', '500', '000']) {
      assert.notEqual(
        run(status).status,
        0,
        `must reject registry status ${status}`
      );
    }
    assert.notEqual(run('404', { MOCK_TOKEN_FAILURE: 'true' }).status, 0);
    assert.notEqual(run('404', { RELEASE_TAG: '3.86.0-fh.1/other' }).status, 0);
  }));
