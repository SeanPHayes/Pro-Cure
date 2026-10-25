import proxy from '@fastify/http-proxy';
import { GATEWAY_PORT, SERVICES, SERVICE_NAMES } from '@procure/domain';
import { rootLogger, serviceUrl } from '@procure/platform';
import Fastify from 'fastify';

/**
 * Local stand-in for AWS API Gateway: routes /api/<service>/* to each service and serves a docs index.
 * Auth is enforced by the services themselves (they verify the bearer token), exactly as in AWS where
 * API Gateway passes the token through.
 */
const log = rootLogger('gateway');
const app = Fastify({ loggerInstance: log, trustProxy: true, bodyLimit: 250 * 1024 * 1024 });

for (const name of SERVICE_NAMES) {
  const svc = SERVICES[name];
  await app.register(proxy, {
    upstream: serviceUrl(name, svc.port),
    prefix: `/api/${svc.prefix}`,
    rewritePrefix: '',
    http2: false,
    replyOptions: {
      rewriteRequestHeaders: (req, headers) => ({
        ...headers,
        'x-request-id': req.id,
        'x-procure-internal': '',
      }),
    },
  });
}

app.get('/api', async () => ({
  name: 'Pro-Cure API',
  services: SERVICE_NAMES.map((n) => ({
    name: n,
    docs: `/api/${SERVICES[n].prefix}/docs`,
    openapi: `/api/${SERVICES[n].prefix}/openapi.json`,
  })),
}));
app.get('/health', async () => ({ ok: true }));

await app.listen({ port: Number(process.env.PORT ?? GATEWAY_PORT), host: '0.0.0.0' });
