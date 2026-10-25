import { SpecCategory } from '@procure/domain';
import {
  ActivityEntry,
  type App,
  badRequest,
  conflict,
  listActivity,
  must,
  type Tx,
  upstream,
  z,
} from '@procure/platform';
import { catalog, tolerate } from '../clients.js';
import { pageResult, recordSpecCost, specCostStatus } from '../repo.js';
import {
  ActivityQuery,
  FromBrandStandardBody,
  IdParams,
  pageOf,
  Spec,
  SpecDetail,
  SpecImportBody,
  SpecImportResult,
  SpecImportRow,
  SpecInput,
  SpecListQuery,
  SpecPatch,
} from '../schemas.js';

export const specSelect = (tx: Tx) => tx`
  s.id, s.code, s.name, s.description, s.category, s.vendor_id, s.vendor_name, s.vendor_sku, s.finish,
  s.dimensions, s.materials, s.unit, s.cost, s.cost_expires_at, ${specCostStatus(tx)} as cost_status,
  s.lead_time_weeks, s.freight_unit, s.image_document_id, s.master_spec_id, s.brand_standard_id,
  s.brand_standard_item_id, s.notes, s.archived, s.created_at, s.updated_at`;

export async function getSpec(tx: Tx, id: string) {
  const [s] = await tx<Spec[]>`select ${specSelect(tx)} from quoting.specs s where s.id = ${id}`;
  return must(s, 'Spec');
}

const COLS: Record<string, string> = {
  code: 'code',
  name: 'name',
  description: 'description',
  category: 'category',
  vendorId: 'vendor_id',
  vendorName: 'vendor_name',
  vendorSku: 'vendor_sku',
  finish: 'finish',
  dimensions: 'dimensions',
  materials: 'materials',
  unit: 'unit',
  cost: 'cost',
  costExpiresAt: 'cost_expires_at',
  leadTimeWeeks: 'lead_time_weeks',
  freightUnit: 'freight_unit',
  imageDocumentId: 'image_document_id',
  masterSpecId: 'master_spec_id',
  brandStandardId: 'brand_standard_id',
  brandStandardItemId: 'brand_standard_item_id',
  notes: 'notes',
  archived: 'archived',
};

export const toColumns = (b: Record<string, unknown>, cols: Record<string, string> = COLS) =>
  Object.fromEntries(
    Object.entries(b)
      .filter(([k, v]) => v !== undefined && k in cols)
      .map(([k, v]) => [cols[k]!, v]),
  );

/** Vendor display name for a spec when only the id was given. Tolerates catalog being down. */
async function vendorName(tenantId: string, vendorId: string | null | undefined, given?: string | null) {
  if (given || !vendorId) return given ?? null;
  const v = await tolerate(() => catalog.vendor(tenantId, vendorId));
  return v?.name ?? null;
}

// ---------------------------------------------------------------- import (shared with /internal)
type ImportRow = { row: number; code: string | null; errors: string[] };

const num = (v: unknown): number | null | 'invalid' => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 'invalid';
};

export async function importSpecs(
  tx: Tx,
  tenantId: string,
  rows: Record<string, unknown>[],
  by: string | null,
  source: 'import' | 'manual' = 'import',
) {
  let created = 0;
  let updated = 0;
  const errors: ImportRow[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of rows.entries()) {
    const parsed = SpecImportRow.safeParse(raw);
    const code = typeof raw.code === 'string' ? raw.code.trim() : null;
    const errs: string[] = [];
    if (!parsed.success) {
      for (const iss of parsed.error.issues) errs.push(`${iss.path.join('.') || 'row'}: ${iss.message}`);
      errors.push({ row: i, code, errors: errs });
      continue;
    }
    const r = parsed.data;
    if (!r.code.trim()) errs.push('code: required');
    if (!r.name.trim()) errs.push('name: required');
    const category = (r.category ?? 'other')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (!SpecCategory.safeParse(category).success) errs.push(`category: unknown category "${r.category}"`);
    const cost = num(r.cost);
    if (cost === 'invalid' || (typeof cost === 'number' && cost < 0))
      errs.push('cost: must be a non-negative number');
    const lead = num(r.leadTimeWeeks);
    if (lead === 'invalid') errs.push('leadTimeWeeks: must be a number');
    if (r.costExpiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(r.costExpiresAt))
      errs.push('costExpiresAt: use YYYY-MM-DD');
    const uuidish = /^[0-9a-f-]{36}$/i;
    if (r.vendorId && !uuidish.test(r.vendorId)) errs.push('vendorId: must be a uuid');
    if (r.brandStandardItemId && !uuidish.test(r.brandStandardItemId))
      errs.push('brandStandardItemId: must be a uuid');
    if (seen.has(r.code.trim())) errs.push('code: duplicated in this file');
    if (errs.length) {
      errors.push({ row: i, code, errors: errs });
      continue;
    }
    seen.add(r.code.trim());
    const values = {
      tenantId,
      code: r.code.trim(),
      name: r.name.trim(),
      category,
      vendorId: r.vendorId ?? null,
      vendorName: r.vendorName ?? null,
      vendorSku: r.vendorSku ?? null,
      description: r.description ?? null,
      dimensions: r.dimensions ?? null,
      finish: r.finish ?? null,
      materials: r.materials ?? null,
      unit: r.unit || 'ea',
      brandStandardItemId: r.brandStandardItemId ?? null,
    };
    const [existing] = await tx<{ id: string; cost: number | null; costExpiresAt: string | null }[]>`
      select id, cost, cost_expires_at from quoting.specs where tenant_id = ${tenantId} and code = ${values.code} for update`;
    const costCols =
      r.cost !== undefined ? { cost: cost as number | null, costExpiresAt: r.costExpiresAt ?? null } : {};
    let specId: string;
    if (existing) {
      const patch: Record<string, unknown> = Object.fromEntries(
        Object.entries({
          ...values,
          ...costCols,
          leadTimeWeeks: r.leadTimeWeeks !== undefined ? lead : undefined,
        }).filter(
          ([k, v]) =>
            k !== 'tenantId' && k !== 'code' && v !== undefined && (raw[k] !== undefined || k in costCols),
        ),
      );
      if (Object.keys(patch).length)
        await tx`update quoting.specs set ${tx(toColumns(patch) as never)} where id = ${existing.id}`;
      specId = existing.id;
      updated++;
      if (
        'cost' in costCols &&
        (existing.cost !== costCols.cost || existing.costExpiresAt !== costCols.costExpiresAt)
      )
        await recordSpecCost(tx, {
          tenantId,
          specId,
          cost: costCols.cost!,
          expiresAt: costCols.costExpiresAt!,
          source,
          by,
        });
    } else {
      const [s] = await tx<{ id: string }[]>`
        insert into quoting.specs ${tx({ ...values, ...costCols, leadTimeWeeks: lead as number | null } as never)}
        returning id`;
      specId = s!.id;
      created++;
      if (costCols.cost !== undefined && costCols.cost !== null)
        await recordSpecCost(tx, {
          tenantId,
          specId,
          cost: costCols.cost,
          expiresAt: costCols.costExpiresAt!,
          source,
          by,
        });
    }
  }
  return { created, updated, errors };
}

export async function specRoutes(app: App) {
  app.get(
    '/specs',
    {
      schema: {
        tags: ['specs'],
        summary: 'Search the private spec library',
        querystring: SpecListQuery,
        response: { 200: pageOf(Spec) },
      },
    },
    async (req) => {
      req.principal.require('specs:read');
      const {
        q,
        category,
        vendorId,
        masterSpecId,
        brandStandardItemId,
        costStatus,
        includeArchived,
        limit,
        offset,
      } = req.query;
      return req.tx(async (tx) => {
        const where = tx`
          where true
            ${includeArchived ? tx`` : tx`and not s.archived`}
            ${q ? tx`and (s.code ilike ${`%${q}%`} or s.name ilike ${`%${q}%`} or s.vendor_name ilike ${`%${q}%`} or s.vendor_sku ilike ${`%${q}%`})` : tx``}
            ${category ? tx`and s.category = ${category}` : tx``}
            ${vendorId ? tx`and s.vendor_id = ${vendorId}` : tx``}
            ${masterSpecId ? tx`and s.master_spec_id = ${masterSpecId}` : tx``}
            ${brandStandardItemId ? tx`and s.brand_standard_item_id = ${brandStandardItemId}` : tx``}
            ${costStatus ? tx`and ${specCostStatus(tx)} = ${costStatus}` : tx``}`;
        const [{ count }] =
          (await tx`select count(*)::int as count from quoting.specs s ${where}`) as unknown as [
            { count: number },
          ];
        const items = await tx<Spec[]>`
          select ${specSelect(tx)} from quoting.specs s ${where}
          order by s.code limit ${limit} offset ${offset}`;
        return pageResult(items, count, limit, offset);
      });
    },
  );

  app.post(
    '/specs',
    {
      schema: { tags: ['specs'], summary: 'Create a spec', body: SpecInput, response: { 201: Spec } },
    },
    async (req, reply) => {
      req.principal.require('specs:write');
      const p = req.principal;
      const name = await vendorName(p.tenantId, req.body.vendorId, req.body.vendorName);
      const spec = await req.tx(async (tx) => {
        const [dupe] = await tx`select 1 from quoting.specs where code = ${req.body.code}`;
        if (dupe) throw conflict(`A spec with code ${req.body.code} already exists`);
        const [s] = await tx<{ id: string }[]>`
          insert into quoting.specs ${tx({ tenantId: p.tenantId, createdBy: p.userId, ...toColumns({ ...req.body, vendorName: name }) } as never)}
          returning id`;
        if (req.body.cost !== undefined && req.body.cost !== null)
          await recordSpecCost(tx, {
            tenantId: p.tenantId,
            specId: s!.id,
            cost: req.body.cost,
            expiresAt: req.body.costExpiresAt ?? null,
            source: 'manual',
            by: p.name,
          });
        return getSpec(tx, s!.id);
      });
      return reply.status(201).send(spec);
    },
  );

  app.get(
    '/specs/:id',
    {
      schema: {
        tags: ['specs'],
        summary: 'Spec with cost history, master spec and the quotes using it',
        params: IdParams,
        response: { 200: SpecDetail },
      },
    },
    async (req) => {
      req.principal.require('specs:read');
      return req.tx(async (tx) => {
        const s = await getSpec(tx, req.params.id);
        const costHistory = await tx<z.infer<typeof SpecDetail>['costHistory']>`
          select id, cost, expires_at, source, cost_request_id, recorded_at, recorded_by_name
          from quoting.spec_cost_history where spec_id = ${s.id} order by recorded_at desc, id limit 100`;
        const [master] = s.masterSpecId
          ? await tx<
              { id: string; name: string }[]
            >`select id, name from quoting.master_specs where id = ${s.masterSpecId}`
          : [];
        const quotes = await tx<z.infer<typeof SpecDetail>['usage']['quotes']>`
          select q.id as quote_id, q.number, q.name, q.status, q.is_template, count(*)::int as line_count
          from quoting.quote_lines l join quoting.quotes q on q.id = l.quote_id
          where l.spec_id = ${s.id}
          group by q.id order by q.created_at desc`;
        return {
          ...s,
          costHistory,
          masterSpec: master ?? null,
          usage: {
            quoteCount: quotes.length,
            lineCount: quotes.reduce((a, q) => a + q.lineCount, 0),
            quotes,
          },
        };
      });
    },
  );

  app.patch(
    '/specs/:id',
    {
      schema: {
        tags: ['specs'],
        summary:
          'Update a spec (cost changes are recorded in cost history; quotes pick them up on "refresh costs")',
        params: IdParams,
        body: SpecPatch,
        response: { 200: Spec },
      },
    },
    async (req) => {
      req.principal.require('specs:write');
      const p = req.principal;
      const b = req.body;
      const name =
        b.vendorId !== undefined && b.vendorName === undefined
          ? await vendorName(p.tenantId, b.vendorId)
          : b.vendorName;
      return req.tx(async (tx) => {
        const before = await getSpec(tx, req.params.id);
        const sets = toColumns({ ...b, ...(name !== undefined ? { vendorName: name } : {}) });
        if (Object.keys(sets).length)
          await tx`update quoting.specs set ${tx(sets as never)} where id = ${req.params.id}`;
        const costChanged =
          (b.cost !== undefined && b.cost !== before.cost) ||
          (b.costExpiresAt !== undefined && b.costExpiresAt !== before.costExpiresAt);
        const after = await getSpec(tx, req.params.id);
        if (costChanged)
          await recordSpecCost(tx, {
            tenantId: p.tenantId,
            specId: after.id,
            cost: after.cost,
            expiresAt: after.costExpiresAt,
            source: 'manual',
            by: p.name,
          });
        return after;
      });
    },
  );

  app.delete(
    '/specs/:id',
    {
      schema: {
        tags: ['specs'],
        summary: 'Delete an unused spec (409 when any quote uses it)',
        params: IdParams,
      },
    },
    async (req, reply) => {
      req.principal.require('specs:write');
      await req.tx(async (tx) => {
        await getSpec(tx, req.params.id);
        const [{ n }] =
          (await tx`select count(*)::int as n from quoting.quote_lines where spec_id = ${req.params.id}`) as unknown as [
            { n: number },
          ];
        if (n > 0) throw conflict(`Spec is used by ${n} quote line(s); archive it instead`, { lineCount: n });
        await tx`delete from quoting.specs where id = ${req.params.id}`;
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/specs/import',
    {
      schema: {
        tags: ['specs'],
        summary: 'Bulk import specs (upsert by code); returns per-row validation errors',
        body: SpecImportBody,
        response: { 200: SpecImportResult },
      },
    },
    async (req) => {
      req.principal.require('specs:write');
      return req.tx((tx) => importSpecs(tx, req.principal.tenantId, req.body.rows, req.principal.name));
    },
  );

  app.post(
    '/specs/from-brand-standard',
    {
      schema: {
        tags: ['specs'],
        summary: 'Create/update library specs from a shared brand-standard package',
        body: FromBrandStandardBody,
        response: {
          200: z.object({ created: z.number().int(), updated: z.number().int(), specs: z.array(Spec) }),
        },
      },
    },
    async (req) => {
      req.principal.require('specs:write');
      const p = req.principal;
      const std = await catalog.brandStandard(p.tenantId, req.body.standardId).catch((e) => {
        throw e?.status === 404 ? badRequest('Brand standard not found') : upstream('Catalog unavailable');
      });
      const wanted = req.body.itemIds ? new Set(req.body.itemIds) : null;
      const items = std.items.filter((i) => !wanted || wanted.has(i.id));
      if (wanted && items.length !== wanted.size)
        throw badRequest('Some itemIds are not in this brand standard');
      const assign = req.body.vendorAssignments ?? {};
      const vendorIds = [
        ...new Set(items.map((i) => assign[i.id] ?? i.vendorId).filter(Boolean)),
      ] as string[];
      const names = new Map<string, string | null>();
      for (const v of vendorIds) names.set(v, await vendorName(p.tenantId, v));
      return req.tx(async (tx) => {
        let created = 0;
        let updated = 0;
        const ids: string[] = [];
        for (const it of items) {
          const vendorId = assign[it.id] ?? it.vendorId ?? null;
          const cat = String(it.category ?? 'other').toLowerCase();
          const values = {
            name: it.name,
            description: it.description ?? null,
            category: SpecCategory.safeParse(cat).success ? cat : 'other',
            dimensions: it.dimensions ?? null,
            finish: it.finish ?? null,
            materials: it.materials ?? null,
            vendorId,
            vendorName: vendorId ? (names.get(vendorId) ?? null) : null,
            brandStandardId: std.id,
            brandStandardItemId: it.id,
          };
          const [ex] = await tx<{ id: string }[]>`
            select id from quoting.specs where brand_standard_item_id = ${it.id} or code = ${it.code}
            order by (brand_standard_item_id = ${it.id}) desc limit 1`;
          if (ex) {
            await tx`update quoting.specs set ${tx(toColumns(values) as never)} where id = ${ex.id}`;
            ids.push(ex.id);
            updated++;
          } else {
            const [s] = await tx<{ id: string }[]>`
              insert into quoting.specs ${tx({ tenantId: p.tenantId, code: it.code, createdBy: p.userId, ...toColumns(values) } as never)}
              returning id`;
            ids.push(s!.id);
            created++;
          }
        }
        const specs = ids.length
          ? await tx<
              Spec[]
            >`select ${specSelect(tx)} from quoting.specs s where s.id in ${tx(ids)} order by s.code`
          : [];
        return { created, updated, specs };
      });
    },
  );

  app.get(
    '/specs/:id/activity',
    {
      schema: {
        tags: ['specs'],
        summary: 'Field-level change history of a spec',
        params: IdParams,
        querystring: ActivityQuery,
        response: { 200: z.array(ActivityEntry) },
      },
    },
    async (req) => {
      req.principal.require('specs:read');
      return req.tx(async (tx) => {
        await getSpec(tx, req.params.id);
        return listActivity(tx, 'spec', req.params.id, { limit: req.query.limit });
      });
    },
  );
}
