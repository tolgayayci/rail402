# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# Postgres with pgBackRest (MIT) for continuous WAL archiving and point-in-time restore. Same base image
# as the plain Postgres service (Alpine, musl), so an existing data directory keeps its collation.
#   docker build -t rail402-postgres deploy/postgres
ARG POSTGRES_IMAGE=postgres:18.6-alpine@sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5
FROM ${POSTGRES_IMAGE}
RUN apk add --no-cache pgbackrest=2.58.0-r0 \
  && install -d -o postgres -g postgres -m 750 /var/log/pgbackrest /var/lib/pgbackrest /var/spool/pgbackrest
USER postgres
