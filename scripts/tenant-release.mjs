import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPSTREAM_COMMIT = 'ef47c0d1b2c48fa4e97fb381561b514e657928cf';
export const REPOSITORY = 'tonyawino/ghostfolio';
export const IMAGE = `ghcr.io/${REPOSITORY}`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const platforms = ['linux/amd64', 'linux/arm/v7', 'linux/arm64/v8'];

export function validateRelease({ tag, commit, indexDigest, repository }) {
  if (!/^3\.86\.0-fh\.(0|[1-9][0-9]*)$/.test(tag ?? '')) {
    throw new Error('Expected a versioned 3.86.0-fh.N release tag');
  }
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) {
    throw new Error('Expected the complete derivative Git commit');
  }
  if (!digestPattern.test(indexDigest ?? '')) {
    throw new Error('Expected the published OCI index SHA256 digest');
  }
  if (repository !== REPOSITORY) {
    throw new Error(
      'Releases are restricted to the public derivative repository'
    );
  }
}

export function checkNodeBase(root) {
  const nodeBase = JSON.parse(
    readFileSync(join(root, '.config/tenant-node-base.json'), 'utf8')
  );
  if (!digestPattern.test(nodeBase.indexDigest)) {
    throw new Error('Node base index digest is invalid');
  }
  const expected = `${nodeBase.reference.replace('docker.io/library/', '')}@${nodeBase.indexDigest}`;
  const stages = readFileSync(join(root, 'Dockerfile'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('FROM '));
  if (
    stages.length !== 2 ||
    stages.some((line) => !line.split(/\s+/).includes(expected))
  ) {
    throw new Error('Both Dockerfile stages must use the recorded Node base');
  }
  for (const platform of platforms) {
    if (!digestPattern.test(nodeBase.platforms[platform] ?? '')) {
      throw new Error(`Missing Node base digest for ${platform}`);
    }
  }
  return nodeBase;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function createManifest({
  root,
  tag,
  commit,
  indexDigest,
  repository,
  index,
  archivePath,
  runUrl
}) {
  validateRelease({ tag, commit, indexDigest, repository });
  const nodeBase = checkNodeBase(root);
  const archiveName = `ghostfolio-${tag}-source.tar.gz`;
  if (basename(archivePath) !== archiveName) {
    throw new Error('Source archive filename does not match the release tag');
  }
  if (
    index.schemaVersion !== 2 ||
    index.mediaType !== 'application/vnd.oci.image.index.v1+json' ||
    !Array.isArray(index.manifests)
  ) {
    throw new Error('Expected a multi-platform OCI image index');
  }
  const source = {
    repository: `https://github.com/${repository}`,
    upstreamCommit: UPSTREAM_COMMIT,
    derivativeCommit: commit,
    archiveUrl: `https://github.com/${repository}/releases/download/${tag}/${archiveName}`,
    archiveSha256: sha256(readFileSync(archivePath))
  };
  const images = [];
  const attestations = [];
  for (const descriptor of index.manifests) {
    if (!digestPattern.test(descriptor.digest ?? '')) {
      throw new Error('Invalid OCI child manifest digest');
    }
    if (
      descriptor.annotations?.['vnd.docker.reference.type'] ===
      'attestation-manifest'
    ) {
      attestations.push({
        digest: descriptor.digest,
        subjectDigest: descriptor.annotations['vnd.docker.reference.digest']
      });
      continue;
    }
    const p = descriptor.platform;
    const variant = p?.architecture === 'arm64' ? 'v8' : p?.variant;
    const platform = [p?.os, p?.architecture, variant]
      .filter(Boolean)
      .join('/');
    if (
      !platforms.includes(platform) ||
      images.some((x) => x.platform === platform)
    ) {
      throw new Error(`Unexpected or duplicate OCI platform: ${platform}`);
    }
    images.push({
      platform,
      digest: descriptor.digest,
      nodeRuntimeBaseDigest: nodeBase.platforms[platform],
      source
    });
  }
  if (images.length !== platforms.length) {
    throw new Error('The OCI index must contain all three supported platforms');
  }
  for (const image of images) {
    if (!attestations.some((x) => x.subjectDigest === image.digest)) {
      throw new Error(
        `Missing provenance/SBOM attestation for ${image.platform}`
      );
    }
  }
  const files = [
    'Dockerfile',
    'docker/entrypoint.sh',
    '.github/workflows/tenant-image.yml',
    '.github/workflows/docker-image.yml',
    '.github/workflows/build-code.yml',
    '.config/tenant-node-base.json',
    'package-lock.json'
  ];
  return {
    schemaVersion: 1,
    version: tag,
    image: { repository: IMAGE, indexDigest, platforms: images, attestations },
    source,
    build: {
      workflowRun: runUrl,
      builderPlatform: 'linux/amd64',
      nodeBase,
      files: Object.fromEntries(
        files.map((file) => [
          file,
          { sha256: sha256(readFileSync(join(root, file))) }
        ])
      )
    }
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = process.cwd();
  if (process.argv[2] === 'check') {
    checkNodeBase(root);
    console.log(
      'Both Node stages match the recorded multiarch base and platforms'
    );
  } else if (process.argv[2] === 'manifest') {
    const manifest = createManifest({
      root,
      tag: process.env.RELEASE_TAG,
      commit: process.env.RELEASE_SHA,
      indexDigest: process.env.IMAGE_DIGEST,
      repository: process.env.GITHUB_REPOSITORY,
      index: JSON.parse(readFileSync(process.argv[3], 'utf8')),
      archivePath: process.argv[4],
      runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    });
    writeFileSync(process.argv[5], `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    throw new Error(
      'Usage: node scripts/tenant-release.mjs check|manifest <index.json> <source.tar.gz> <manifest.json>'
    );
  }
}
