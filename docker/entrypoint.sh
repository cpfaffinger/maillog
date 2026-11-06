#!/bin/sh
# Bind mounts are created by the Docker daemon as root. Fix ownership of the data folder once,
# then drop privileges to the unprivileged "app" user of the base image.
set -eu

DATA="${MAILLOG_DATA_DIR:-/data}"
mkdir -p "$DATA"
chown app:app "$DATA"
chmod 0700 "$DATA"

exec setpriv --reuid=app --regid=app --init-groups dotnet /app/MailLog.dll "$@"
