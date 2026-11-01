# Activity profile display-name evidence

Historical proof: the later [batch identity and BUY rename evidence](2026-11-01-batch-activity-identity-evidence.md)
supersedes this initial BUY/SELL name contract. The final name field is BUY-only
and requires a locked expected profile UUID; SELL uses its separate target path.

Work item: [Finance Hub #1376](https://github.com/tonyawino/finance-hub/issues/1376).

The change adds two explicit activity-update options. `assetProfileName` updates
the existing authenticated user's MANUAL BUY/SELL profile label while retaining
its profile UUID and symbol key. `preserveComment: true` preserves an omitted
comment on that user's existing activity. Omitting these options retains the
previous update behavior.

The worktree starts at `3.86.0-fh.3`, source
`a1d3c245dece625bcce8c51bcf1c2ac4474d795b`. Regression tests first failed for the
missing name update, owner/source/type guards, DTO acceptance, and omitted-comment
preservation. A separate SELL regression failed before that explicit supported
path was enabled.

## Focused verification

| Command                                                                                                                                                                                                                                                                          | Result                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `NX_DAEMON=false npx dotenv-cli -e .env.example -- npx nx run api:test --test-file 'activities.(service\|controller).spec.ts' --runInBand --skip-nx-cache`                                                                                                                       | 2 suites, 49 passed, 0 failed, 0 skipped    |
| `NX_DAEMON=false npx nx run api:lint --skip-nx-cache`                                                                                                                                                                                                                            | Passed with repository warnings             |
| `NX_DAEMON=false npx nx run common:lint --skip-nx-cache`                                                                                                                                                                                                                         | Passed; 0 errors, 77 warnings               |
| `npx eslint -c apps/api/eslint.config.cjs apps/api/src/app/activities/activities.controller.ts apps/api/src/app/activities/activities.service.ts apps/api/src/app/activities/activities.service.spec.ts apps/api/src/app/activities/activities.controller.spec.ts --format json` | 0 errors, 27 warnings across the four files |
| `NX_DAEMON=false npx dotenv-cli -e .env.example -- npx nx run api:build:production --skip-nx-cache`                                                                                                                                                                              | Production API bundle compiled successfully |
| `git diff --check`                                                                                                                                                                                                                                                               | Passed                                      |

The first baseline test attempt could not compile because the new worktree had
no ignored Prisma workspace types. Generating only the local `workspaceClient`
resolved that setup issue; the unchanged baseline then passed 27 service tests.
Directly invoking root ESLint on the common DTO lacked its typed parser setup;
the configured `common:lint` target above passed. No full suite was run.

## Disposable runtime proof

The baseline image was
`ghcr.io/tonyawino/ghostfolio@sha256:486fcbc8f3038258d7c20ebfc3fa14f0639225153a365499468c25bd09fad101`.
A symbol-only MANUAL BUY PUT returned 200 while its label remained unchanged,
reproducing the original issue.

The local candidate overlaid only the compiled production API bundle on that
exact base image. The bundle SHA-256 was
`ba331759b5d778220e81db2937f37b733e078e6f50760e5667b5eaac69f309e5`;
local candidate image ID was
`sha256:5bfbbcb97cc2e3ad129b9263cbf8ee33c54ec58bb6084b09e0b62b6c4ea4893a`.
This is evidence for a local API candidate, not a published release image.
Repeat the proof against the final released image before updating the Hub pin.

An internal Docker network with disposable Postgres/Redis and synthetic USERs
verified all of these assertions:

- Explicit BUY and SELL label updates retained the activity and profile UUIDs
  and the original profile symbol key.
- Repeating the identical BUY update returned 200 and kept one activity.
- An ordinary UUID-symbol update without `assetProfileName` retained the human
  label.
- Omitted comments, tags, account mapping, quantities, prices, and balance
  history were preserved by the opted-in BUY update; SELL retained its comment.
- Another USER could not update the activity (404).
- A deliberately mismatched synthetic activity/profile owner relationship
  rejected the explicit name update (403), preserving both the activity values
  and the other USER's profile label.

Only synthetic records were used. `docker compose down -v` removed all three
containers, the project network, the named database volume, and the anonymous
Redis volume; subsequent container/network/volume queries were empty. The
temporary proof directory and synthetic credential state were removed. The
local candidate image remains available for review and was never published.
