/**
 * CloudFormation custom resource: one-time (idempotent) database bootstrap for Aurora PostgreSQL.
 * Equivalent of tools/db-create.mjs for AWS:
 *
 *   procure_owner — owns the database and every schema; runs migrations
 *   procure_app   — the role services connect as; subject to row-level security (NOBYPASSRLS)
 *
 * Runs as the cluster master user (rds_superuser, not a true superuser) inside the VPC. On every
 * Create/Update it (re)creates the roles if missing, syncs their passwords from Secrets Manager,
 * creates the database, installs extensions that need elevated rights, and grants CONNECT to the app
 * role. Delete is a no-op: the database outlives the stack resource.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import postgres from 'postgres';

const sm = new SecretsManagerClient({});

interface Props {
  Host: string;
  Port: string;
  DatabaseName: string;
  MasterSecretArn: string;
  OwnerSecretArn: string;
  AppSecretArn: string;
}

const secretJson = async (arn: string) => {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(res.SecretString ?? '{}') as { username: string; password: string };
};

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`invalid identifier: ${s}`);
  return s;
};
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function handler(event: CloudFormationCustomResourceEvent) {
  const physicalId = 'pro-cure-db-bootstrap';
  if (event.RequestType === 'Delete') return { PhysicalResourceId: physicalId };

  const p = event.ResourceProperties as unknown as Props;
  const dbName = ident(p.DatabaseName);
  const [master, owner, app] = await Promise.all([
    secretJson(p.MasterSecretArn),
    secretJson(p.OwnerSecretArn),
    secretJson(p.AppSecretArn),
  ]);

  const connect = (database: string) =>
    postgres({
      host: p.Host,
      port: Number(p.Port),
      database,
      username: master.username,
      password: master.password,
      ssl: 'require',
      max: 1,
      connect_timeout: 15,
      onnotice: () => {},
    });

  const admin = connect('postgres');
  try {
    for (const role of [owner, app]) {
      const name = ident(role.username);
      const rows = await admin`select rolbypassrls from pg_roles where rolname = ${name}`;
      if (!rows.length) {
        await admin.unsafe(`create role ${name} login password ${literal(role.password)}`);
        console.log(`created role ${name}`);
      } else {
        await admin.unsafe(`alter role ${name} with login password ${literal(role.password)}`);
        // Changing BYPASSRLS needs a true superuser; roles we create never have it.
        if (rows[0]?.rolbypassrls) throw new Error(`role ${name} has BYPASSRLS; remove it manually`);
      }
    }
    const ownerName = ident(owner.username);
    // PG16: CREATE DATABASE … OWNER requires membership (SET) in the owner role.
    await admin.unsafe(`grant ${ownerName} to current_user`);

    const db = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (!db.length) {
      await admin.unsafe(`create database ${dbName} owner ${ownerName}`);
      console.log(`created database ${dbName}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  const target = connect(dbName);
  try {
    // Extensions need rds_superuser; migrations (run as owner) then rely on them.
    await target.unsafe('create extension if not exists pgcrypto; create extension if not exists pg_trgm;');
    await target.unsafe(`revoke all on database ${dbName} from public`);
    await target.unsafe(`grant connect, temporary on database ${dbName} to ${ident(app.username)}`);
    await target.unsafe(`grant all on database ${dbName} to ${ident(owner.username)}`);
  } finally {
    await target.end({ timeout: 5 });
  }

  return { PhysicalResourceId: physicalId, Data: { DatabaseName: dbName } };
}
