#!/bin/sh
# The library's CLI, inside the image (server/host/node/cli.ts): `docker compose exec library
# slidr-library login`, as the command of the machine runs it.
exec node --enable-source-maps /app/dist/node/library.mjs "$@"
