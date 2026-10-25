/**
 * Service registry. Each service owns exactly one Postgres schema (same name) and one route prefix.
 * Locally the gateway routes /api/<prefix>/* to the service port; in AWS, API Gateway routes the same
 * prefixes to the service's ECS target group.
 */
export const SERVICES = {
  identity: { port: 4001, prefix: 'identity', schema: 'identity' },
  catalog: { port: 4002, prefix: 'catalog', schema: 'catalog' },
  projects: { port: 4003, prefix: 'projects', schema: 'projects' },
  quoting: { port: 4004, prefix: 'quoting', schema: 'quoting' },
  orders: { port: 4005, prefix: 'orders', schema: 'orders' },
  finance: { port: 4006, prefix: 'finance', schema: 'finance' },
  documents: { port: 4007, prefix: 'documents', schema: 'documents' },
  ai: { port: 4008, prefix: 'ai', schema: 'ai' },
  comms: { port: 4009, prefix: 'comms', schema: 'comms' },
} as const;

export type ServiceName = keyof typeof SERVICES;
export const SERVICE_NAMES = Object.keys(SERVICES) as ServiceName[];
/** Migration order — services whose data others reference by id come first (no cross-schema FKs). */
export const MIGRATION_ORDER: ServiceName[] = [
  'identity',
  'catalog',
  'documents',
  'projects',
  'quoting',
  'orders',
  'finance',
  'comms',
  'ai',
];
export const GATEWAY_PORT = 8080;
