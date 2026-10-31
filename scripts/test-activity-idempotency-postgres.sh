#!/usr/bin/env bash
# Start a fresh, trust-authenticated cluster containing synthetic data only.
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN="${PG_BIN:-/usr/lib/postgresql/17/bin}"
TEST_ROOT=$(mktemp -d /tmp/gf-activity-idempotency-test.XXXXXX)
TEST_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
cleanup() {
  "$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT
"$PG_BIN/initdb" -D "$TEST_ROOT/data" -A trust -U gf_test --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -l "$TEST_ROOT/postgres.log" -o "-h 127.0.0.1 -p $TEST_PORT -k $TEST_ROOT" -w start >/dev/null
"$PG_BIN/createdb" -h 127.0.0.1 -p "$TEST_PORT" -U gf_test gf_activity_idempotency_test
export ACTIVITY_IDEMPOTENCY_TEST_DATABASE_URL="postgresql://gf_test@127.0.0.1:$TEST_PORT/gf_activity_idempotency_test"
export DATABASE_URL="$ACTIVITY_IDEMPOTENCY_TEST_DATABASE_URL"
export DIRECT_URL="$ACTIVITY_IDEMPOTENCY_TEST_DATABASE_URL"
# Override config explicitly. Never read or use an application's configured DB.
node node_modules/prisma/build/index.js db push --schema prisma/schema.prisma --url "$ACTIVITY_IDEMPOTENCY_TEST_DATABASE_URL"
# Exercise the deploy migration itself against this still-empty disposable DB.
"$PG_BIN/psql" "$ACTIVITY_IDEMPOTENCY_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'DROP TABLE "ActivityCreateIdempotency"' >/dev/null
"$PG_BIN/psql" "$ACTIVITY_IDEMPOTENCY_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261031000000_activity_create_idempotency/migration.sql >/dev/null
node node_modules/jest/bin/jest.js --config apps/api/jest.config.ts --runInBand --runTestsByPath apps/api/src/app/activities/activity-idempotency.postgres.spec.ts
