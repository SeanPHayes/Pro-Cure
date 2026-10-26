import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * DATABASE_URL is assembled at container start by services/docker-entrypoint.sh from these pieces,
 * because ECS can inject a JSON secret *field* but cannot template a URL around it:
 *
 *   DATABASE_URL           = postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME?sslmode=$DB_SSLMODE
 *   MIGRATION_DATABASE_URL = postgres://$MIGRATION_DB_USER:$MIGRATION_DB_PASSWORD@…  (migrate task only)
 *
 * DB_SSLMODE=verify-full + NODE_EXTRA_CA_CERTS (RDS CA bundle baked into the image) gives verified TLS.
 */
export function dbEnv(host: string, port: string | number, dbName: string): Record<string, string> {
  return {
    DB_HOST: host,
    DB_PORT: String(port),
    DB_NAME: dbName,
    DB_SSLMODE: 'verify-full',
  };
}

export function dbSecrets(
  secret: secretsmanager.ISecret,
  prefix: 'DB' | 'MIGRATION_DB',
): Record<string, ecs.Secret> {
  return {
    [`${prefix}_USER`]: ecs.Secret.fromSecretsManager(secret, 'username'),
    [`${prefix}_PASSWORD`]: ecs.Secret.fromSecretsManager(secret, 'password'),
  };
}
