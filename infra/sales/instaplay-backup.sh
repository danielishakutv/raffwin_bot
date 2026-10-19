#!/bin/sh
# Nightly dumps of the sales site databases (cron: /etc/cron.d/instaplay-backup).
# One file per database per day in /srv/<db>/backups. Never overwrites, never
# prunes (house rule: nothing is deleted); clear old ones by hand when needed.
# A failure is reported through the box's alert path and exits non-zero.
set -u
day=$(date +%F)
status=0
for db in instaplay instaplaytest; do
  out=/srv/$db/backups/$db-$day.dump
  if [ -e "$out" ]; then
    echo "$out exists, skipped"
    continue
  fi
  if docker exec instaplay-db pg_dump -U instaplay_admin --format=custom "$db" > "$out.partial" && [ -s "$out.partial" ]; then
    mv "$out.partial" "$out" && chmod 600 "$out" && echo "$out $(stat -c %s "$out") bytes"
  else
    status=1
    echo "backup of $db FAILED; partial file left at $out.partial" >&2
    /usr/local/sbin/toko-telegram-notify "aictig: sales DB backup failed" "pg_dump of $db failed on $day" || true
  fi
done
exit $status
