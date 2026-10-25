#!/usr/bin/env node
// Creates the Pro-Cure database and its two roles on a local Postgres.
//   procure_owner — owns all schemas, runs migrations
//   procure_app   — the role services connect as; subject to row-level security (no BYPASSRLS)
// Usage: node tools/db-create.mjs [--drop] [--db procure]
// Env:   PG_SUPERUSER_URL (default postgres://postgres:postgres@localhost:5432/postgres)
import postgres from 'postgres';

const args = process.argv.slice(2);
const drop = args.includes('--drop');
const dbi = args.indexOf('--db');
const dbName = dbi >= 0 ? args[dbi + 1] : (process.env.PROCURE_DB_NAME ?? 'procure');
if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error('invalid db name');

const superUrl = process.env.PG_SUPERUSER_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const sql = postgres(superUrl, { onnotice: () => {} });

try {
  for (const [role, pw] of [
    ['procure_owner', process.env.PROCURE_OWNER_PASSWORD ?? 'procure_owner'],
    ['procure_app', process.env.PROCURE_APP_PASSWORD ?? 'procure_app'],
  ]) {
    const exists = await sql`select 1 from pg_roles where rolname = ${role}`;
    if (!exists.length) await sql.unsafe(`create role ${role} login password '${pw.replace(/'/g, "''")}'`);
    await sql.unsafe(`alter role ${role} nobypassrls`);
  }
  if (drop) {
    await sql.unsafe(`drop database if exists ${dbName} with (force)`);
    console.log(`dropped ${dbName}`);
  }
  const db = await sql`select 1 from pg_database where datname = ${dbName}`;
  if (!db.length) {
    await sql.unsafe(`create database ${dbName} owner procure_owner`);
    console.log(`created database ${dbName}`);
  } else {
    console.log(`database ${dbName} exists`);
  }
  // Extensions need superuser; create them here so migrations (run as owner) can rely on them.
  const dbSql = postgres(superUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`), { onnotice: () => {} });
  await dbSql.unsafe('create extension if not exists pgcrypto; create extension if not exists pg_trgm;');
  await dbSql.unsafe('grant connect on database ' + dbName + ' to procure_app;');
  await dbSql.end();
} finally {
  await sql.end();
}
