#!/bin/sh
# Runs once, on the first start of an empty data volume (Postgres image rule).
# One login role and one database per site; neither can reach the other's.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE ROLE instaplay LOGIN PASSWORD '$LIVE_DB_PASSWORD';
CREATE DATABASE instaplay OWNER instaplay;
REVOKE ALL ON DATABASE instaplay FROM PUBLIC;
CREATE ROLE instaplaytest LOGIN PASSWORD '$TEST_DB_PASSWORD';
CREATE DATABASE instaplaytest OWNER instaplaytest;
REVOKE ALL ON DATABASE instaplaytest FROM PUBLIC;
EOSQL
