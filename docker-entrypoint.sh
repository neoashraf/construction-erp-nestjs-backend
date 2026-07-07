#!/bin/sh
# Run pending TypeORM migrations against the compiled DataSource, then start the app.
# Idempotent — typeorm skips migrations already recorded in typeorm_migrations.
set -e

echo "[entrypoint] running migrations..."
npx typeorm migration:run -d dist/database/data-source.js

echo "[entrypoint] starting app..."
exec node dist/main.js
