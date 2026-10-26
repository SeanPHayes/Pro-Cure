import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { type EventData, EventEnvelope, type EventType, SERVICES, type ServiceName } from '@procure/domain';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import pino, { type Logger } from 'pino';
import { Principal, verifyAccessToken } from './auth.js';
import { config, serviceUrl } from './config.js';
import { closeDb, type DbContext, sql, type Tx, withContext } from './db.js';
import { AppError, forbidden, unauthorized } from './errors.js';
import {
  consume,
  emit,
  internalSecret,
  registerSubscriptions,
  type Subscription,
  startOutboxRelay,
} from './events.js';
import { type Job, startJobs } from './jobs.js';
import { startSqsConsumer } from './sqs.js';

export type App = FastifyInstance<any, any, any, Logger, ZodTypeProvider>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on every authenticated route. */
    principal: Principal;
    /** Run `fn` in a transaction scoped to the caller's tenant (RLS) with audit attribution. */
    tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
    /** Write an integration event to the outbox inside `tx`, attributed to the caller. */
    emit<T extends EventType>(tx: Tx, type: T, data: EventData<T>): Promise<string>;
  }
  interface FastifyContextConfig {
    /** No authentication required. */
    public?: boolean;
    /** Internal-network only (x-procure-internal shared secret). */
    internal?: boolean;
  }
}

export interface ServiceDefinition {
  name: ServiceName;
  title: string;
  description: string;
  routes: (app: App) => Promise<void> | void;
  subscriptions?: Subscription[];
  jobs?: Job[];
  /** Upload limit for multipart routes (bytes). */
  maxUploadBytes?: number;
}

export const rootLogger = (name: string) =>
  pino({
    name,
    level: config().LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.accessToken'],
    ...(config().APP_ENV === 'local'
      ? { transport: { target: 'pino-pretty', options: { singleLine: true, ignore: 'pid,hostname' } } }
      : {}),
  });

const PG_ERRORS: Record<string, [number, string, string]> = {
  '23505': [409, 'conflict', 'A record with those values already exists'],
  '23503': [409, 'conflict', 'Referenced record does not exist or is still in use'],
  '23514': [422, 'unprocessable', 'Value violates a business rule'],
  '22P02': [400, 'bad_request', 'Malformed value'],
  '42501': [403, 'forbidden', 'Not permitted for this tenant'],
};

const problem = (reply: FastifyReply, req: FastifyRequest, status: number, body: Record<string, unknown>) =>
  reply
    .status(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', status, traceId: req.id, ...body });

export async function buildService(def: ServiceDefinition, log: Logger = rootLogger(def.name)): Promise<App> {
  const cfg = config();
  const svc = SERVICES[def.name];
  const app = Fastify({
    loggerInstance: log,
    genReqId: (req) => (req.headers['x-request-id'] as string) || crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(cors, {
    origin: cfg.APP_ENV === 'production' ? [cfg.PUBLIC_WEB_URL] : true,
    credentials: true,
    exposedHeaders: ['content-disposition', 'x-request-id'],
  });
  await app.register(rateLimit, { max: 1200, timeWindow: '1 minute', allowList: ['127.0.0.1', '::1'] });
  await app.register(multipart, { limits: { fileSize: def.maxUploadBytes ?? 200 * 1024 * 1024, files: 20 } });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: `Pro-Cure ${def.title} API`, description: def.description, version: '1.0.0' },
      servers: [{ url: `${cfg.PUBLIC_API_URL}/${svc.prefix}` }],
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { config: { public: true }, schema: { hide: true } }, async () => app.swagger());

  // ---- request decorations -------------------------------------------------------------------
  app.decorateRequest('principal', null as unknown as Principal);
  app.decorateRequest('tx', function <T>(this: FastifyRequest, fn: (tx: Tx) => Promise<T>) {
    const p = this.principal;
    const ctx: DbContext = p
      ? { tenantId: p.tenantId, userId: p.userId, orgId: p.orgId, actor: p.actor, userName: p.name }
      : { tenantId: null, userId: null, orgId: null, actor: 'service' };
    return withContext(ctx, fn);
  });
  app.decorateRequest('emit', function <
    T extends EventType,
  >(this: FastifyRequest, tx: Tx, type: T, data: EventData<T>) {
    const p = this.principal;
    return emit(tx, def.name, type, data, {
      tenantId: p?.tenantId ?? null,
      actor: p ? { userId: p.userId, orgId: p.orgId, name: p.name } : null,
    });
  });

  app.addHook('onRequest', async (req) => {
    const rc = req.routeOptions.config;
    if (rc?.internal) {
      if (req.headers['x-procure-internal'] !== internalSecret()) throw forbidden('internal endpoint');
      return;
    }
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (token) {
      const claims = await verifyAccessToken(token);
      req.principal = new Principal(claims, token);
    } else if (!rc?.public && req.routeOptions.url && !req.routeOptions.url.startsWith('/docs')) {
      throw unauthorized();
    }
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // ---- errors as problem+json ----------------------------------------------------------------
  app.setErrorHandler((err: any, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return problem(reply, req, 400, {
        title: 'Validation failed',
        code: 'validation_failed',
        errors: err.validation.map((v: any) => ({
          path: (v.instancePath || v.params?.issue?.path?.join('.') || '')
            .replace(/^\//, '')
            .replace(/\//g, '.'),
          message: v.message ?? 'invalid',
        })),
      });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err, issues: err.cause?.issues }, 'response failed schema');
      return problem(reply, req, 500, { title: 'Response serialization failed', code: 'serialization' });
    }
    if (err instanceof AppError) {
      return problem(reply, req, err.status, {
        title: err.message,
        code: err.code,
        ...(err.detail !== undefined ? { detail: err.detail } : {}),
      });
    }
    const pg = err?.code && PG_ERRORS[err.code as string];
    if (pg) {
      req.log.warn(
        { err: { code: err.code, detail: err.detail, constraint: err.constraint_name } },
        'db error',
      );
      return problem(reply, req, pg[0], {
        title: pg[2],
        code: pg[1],
        detail: err.constraint_name ?? err.detail,
      });
    }
    if (typeof err.statusCode === 'number' && err.statusCode < 500) {
      return problem(reply, req, err.statusCode, { title: err.message, code: err.code ?? 'error' });
    }
    req.log.error({ err }, 'unhandled error');
    return problem(reply, req, 500, { title: 'Internal server error', code: 'internal' });
  });
  app.setNotFoundHandler((req, reply) =>
    problem(reply, req, 404, { title: 'Route not found', code: 'not_found' }),
  );

  // ---- health & events ---------------------------------------------------------------------
  app.get('/health', { config: { public: true }, schema: { hide: true } }, async () => ({
    ok: true,
    service: def.name,
  }));
  app.get('/ready', { config: { public: true }, schema: { hide: true } }, async () => {
    await sql()`select 1`;
    return { ok: true };
  });

  const subs = def.subscriptions ?? [];
  app.post(
    '/internal/events',
    { config: { internal: true }, schema: { hide: true, body: EventEnvelope } },
    async (req) => {
      const result = await consume(def.name, req.body as never, subs, req.log);
      return { result };
    },
  );

  await def.routes(app);
  return app;
}

/** Build, listen, and start background loops (outbox relay, event consumer, scheduled jobs). */
export async function runService(def: ServiceDefinition) {
  const log = rootLogger(def.name);
  const app = await buildService(def, log);
  const port = Number(process.env.PORT ?? SERVICES[def.name].port);
  await app.listen({ port, host: '0.0.0.0' });

  const stops: (() => void)[] = [];
  stops.push(startOutboxRelay(def.name, log));
  const subs = def.subscriptions ?? [];
  if (subs.length) {
    if (config().EVENT_TRANSPORT === 'eventbridge') stops.push(startSqsConsumer(def.name, subs, log));
    else
      await registerSubscriptions(
        def.name,
        `${serviceUrl(def.name, SERVICES[def.name].port)}/internal/events`,
        subs,
      );
  }
  stops.push(startJobs(def.name, def.jobs ?? [], log));

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    for (const s of stops) s();
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return app;
}
