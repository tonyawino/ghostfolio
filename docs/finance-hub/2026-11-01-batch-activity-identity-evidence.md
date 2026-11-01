# Batch activity identity and BUY rename evidence

Work item: [Finance Hub #1376](https://github.com/tonyawino/finance-hub/issues/1376).

This revises the earlier display-name proof: `assetProfileName` is now BUY-only
and requires `expectedAssetProfileId`. The separate SELL `assetProfileId` target
path is unchanged. Neither generic PUT omission behavior nor idempotency features
are changed by this revision.

## Contract and decisions

`POST /api/v1/activities/identities` accepts `{ "activityIds": [...] }` with
1–100 unique IDs. JWT authentication uses the actual caller, not impersonation.
Success returns HTTP 200, `Cache-Control: no-store`, and `activities` in request
order. Every entry contains exactly `id`, `accountId`, `type`, `dataSource`,
`symbol`, `assetProfileId`, and `assetProfileUserId`.

One parameterized SQL query joins activity, composite account identity and profile
ownership in one snapshot. Only caller-owned BUY/SELL activities on caller-owned
accounts and MANUAL profiles are supported. Profiles may belong to the caller or
be shared (null owner); a foreign private profile is hidden. Duplicate, missing,
foreign or unsupported IDs reject the entire batch with the same 404. Invalid
shape/size returns 400. No financial fields are read by this query or returned.
The batch avoids one request per trade, and SQL joins avoid Prisma relation reads
splitting the ownership snapshot into multiple database queries.

A BUY label update locks the caller-owned activity, then the exact expected
profile UUID, and rechecks BUY/MANUAL/same-user ownership before one transactional
activity/profile update. It changes only `SymbolProfile.name`; it never creates,
reconnects or changes a profile UUID or symbol key. The new expected-ID option
without a name is rejected. SELL cannot use this name field.

## Focused verification

No full suite was run. Final commands and results:

- `NX_DAEMON=false npx dotenv-cli -e .env.example -- npx nx run api:test --test-file '(activities.(service|controller)|activity-identity).spec.ts' --runInBand --skip-nx-cache`: **3 suites, 88 passed, 0 failed, 0 skipped**.
- `NX_DAEMON=false npx nx run api:lint --skip-nx-cache`: passed. A final `--format=json --outputFile=/tmp/gf-1376-full-api-eslint.json` invocation returned the executor summary: **0 errors, 1466 warnings** (exit 0); the executor did not create the requested JSON file.
- `npx eslint -c apps/api/eslint.config.cjs apps/api/src/app/activities/activities.controller.ts apps/api/src/app/activities/activities.service.ts apps/api/src/app/activities/activities.controller.spec.ts apps/api/src/app/activities/activities.service.spec.ts apps/api/src/app/activities/activity-identity.spec.ts --format json`: **0 errors, 39 warnings**.
- `npx eslint -c libs/common/eslint.config.cjs libs/common/src/lib/dtos/update-order.dto.ts --format json`: **0 errors, 3 warnings**.
- `NX_DAEMON=false npx dotenv-cli -e .env.example -- npx nx run api:build:production --skip-nx-cache`: production API bundle compiled successfully (TypeScript build passed).
- `git diff --check`: passed.

Tests first failed for the missing batch route/lookup (21 failures), expected UUID
and transaction fence (11 failures), single-query join (10 failures), and
name-only metadata update (1 failure). Final coverage includes lock-time changes
to activity owner/type/profile UUID and profile owner/source. A transient missing
local type import during development was corrected before final verification.
Ruff is not applicable to this TypeScript-only derivative change.

## Disposable runtime proof

The final local API-only overlay used exact base image
`ghcr.io/tonyawino/ghostfolio@sha256:486fcbc8f3038258d7c20ebfc3fa14f0639225153a365499468c25bd09fad101`
(source tag `3.86.0-fh.3`). Final bundle SHA-256:
`2e566f6b02e40f83624b966331cfe212844eea52c351052e013fc1baa4832c6c`.
Local candidate image ID:
`sha256:45084a6105fe5e9c33c69aecbcd0b8192c393e73eb967d7e3bf6e8a0f6afba8d`.
Both the running container image ID and its bundle hash matched these values.

An internal Docker network, no published ports, disposable PostgreSQL/Redis and
two synthetic USERs proved:

- Exact response fields, request order, JWT enforcement and no-store header.
- BUY private-profile and SELL shared/null-owner identity tuples.
- Common 404 for missing, foreign and duplicate batches, and whole-batch denial
  for a foreign private profile. Unsupported source/type/account lineage is hidden.
- Empty and oversized requests return 400.
- Missing/wrong expected UUID rejects a BUY update without mutation.
- Correct BUY rename and identical replay keep activity/profile UUIDs, symbol key,
  all other profile metadata, comment, account mapping and account-balance history.
- SELL name mutation is rejected and the shared profile label remains unchanged.

The SELL fixture seeds one synthetic shared MANUAL catalog profile before the
normal API create path: that existing profile is required by the pinned API.
All other user/account/activity creation and updates use the API. Synthetic SQL
fixtures exercise invalid lineage and are confined to the disposable database.

`docker compose down -v` removed all three containers, the network, named database
volume and anonymous Redis volume. Follow-up project container/network/volume
queries were empty; the exact Redis volume ID was also absent. The exact temporary
proof directory was removed. No production,
release tag, image pin, upstream repository or deployment was changed. The local
candidate image remains unpublished. This is a compiled API overlay proof;
repeat against the final published image before changing the Hub deployment pin.
