import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from './db.js';

/**
 * Forward-only SQL migrations. Files are `NNNN_description.sql`, applied in order, each in its own
 * transaction, recorded in platform.schema_migrations with a checksum (editing an applied file is an
 * error — write a new migration instead).
 *
 * After a scope's migrations run, the app role is granted DML on every table in that schema; RLS
 * policies (declared in the migration files) decide which rows it can see.
 */
export interface MigrationScope {
  scope: string; // 'platform' or a service schema name
  dir: string;
}

const BOOTSTRAP = `
  create schema if not exists platform;
  create table if not exists platform.schema_migrations (
    scope      text not null,
    filename   text not null,
    checksum   text not null,
    applied_at timestamptz not null default now(),
    primary key (scope, filename)
  );
`;

export async function migrate(sql: Sql, scopes: MigrationScope[], log: (m: string) => void = console.log) {
  await sql.unsafe(BOOTSTRAP);
  let applied = 0;
  for (const { scope, dir } of scopes) {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    } catch {
      continue;
    }
    const done = new Map(
      (
        await sql<{ filename: string; checksum: string }[]>`
          select filename, checksum from platform.schema_migrations where scope = ${scope}`
      ).map((r) => [r.filename, r.checksum]),
    );
    for (const f of files) {
      const body = await readFile(join(dir, f), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16);
      const prev = done.get(f);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${scope}/${f} was modified after being applied`);
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into platform.schema_migrations (scope, filename, checksum) values (${scope}, ${f}, ${checksum})`;
      });
      log(`  ✔ ${scope}/${f}`);
      applied++;
    }
    if (scope !== 'platform') {
      await sql.unsafe(`
        do $$ begin
          if exists (select 1 from pg_namespace where nspname = '${scope}') then
            execute 'grant usage on schema ${scope} to procure_app';
            execute 'grant select, insert, update, delete on all tables in schema ${scope} to procure_app';
            execute 'grant usage, select on all sequences in schema ${scope} to procure_app';
            execute 'grant execute on all functions in schema ${scope} to procure_app';
          end if;
        end $$;`);
    }
  }
  return applied;
}
