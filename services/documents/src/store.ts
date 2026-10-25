import { createHash } from 'node:crypto';
import { type Db, storage, storageKey, type Tx } from '@procure/platform';
import { PDFDocument } from 'pdf-lib';
import type { DocumentKind, DocumentOut, Visibility } from './schemas.js';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Accepted upload types: PDFs, images, office documents, CSV/TXT, email, zip, CAD drawings. */
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/svg+xml',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
  'message/rfc822',
  'application/vnd.ms-outlook',
  'application/zip',
  'application/x-zip-compressed',
  'application/acad',
  'application/x-acad',
  'application/dwg',
  'image/vnd.dwg',
  'image/x-dwg',
  'application/x-dwg',
]);

const BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  eml: 'message/rfc822',
  msg: 'application/vnd.ms-outlook',
  zip: 'application/zip',
  dwg: 'image/vnd.dwg',
};

/**
 * Normalise the declared content type: browsers send `application/octet-stream` (or nothing) for
 * DWG/EML and some office files, so fall back to the extension. Returns null when not allowed.
 */
export function resolveContentType(filename: string, declared: string | undefined): string | null {
  const base = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (ALLOWED_TYPES.has(base)) return base;
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const byExt = BY_EXTENSION[ext];
  if (
    byExt &&
    (!base ||
      base === 'application/octet-stream' ||
      base.startsWith('application/') ||
      base.startsWith('text/'))
  )
    return byExt;
  return null;
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Page count for PDFs (null for other types, or when the PDF cannot be parsed). */
export async function pdfPageCount(bytes: Buffer, contentType: string): Promise<number | null> {
  if (contentType !== 'application/pdf') return null;
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return pdf.getPageCount();
  } catch {
    return null;
  }
}

export const safeFilename = (f: string) =>
  [...f.replace(/[\\/]+/g, '_')]
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join('')
    .trim()
    .slice(0, 250) || 'file';

export interface NewDocument {
  tenantId: string | null;
  ownerOrgId: string | null;
  filename: string;
  contentType: string;
  bytes: Buffer;
  kind: DocumentKind;
  entityType?: string | null;
  entityId?: string | null;
  visibility: Visibility;
  vendorOrgId?: string | null;
  clientOrgId?: string | null;
  includeInSpecBook?: boolean;
  pageCount?: number | null;
  template?: string | null;
  uploadedBy?: string | null;
  uploadedByName?: string | null;
}

/**
 * Store bytes then insert the metadata row in `tx` (RLS decides whether the caller may create it).
 * If the insert fails the object is removed again, so storage never holds unreferenced files.
 */
export async function createDocument(tx: Tx, d: NewDocument): Promise<string> {
  const filename = safeFilename(d.filename);
  const key = storageKey(d.tenantId, filename);
  const id = crypto.randomUUID();
  const pageCount = d.pageCount ?? (await pdfPageCount(d.bytes, d.contentType));
  await storage().put(key, d.bytes, d.contentType);
  try {
    await tx`
      insert into documents.documents ${tx({
        id,
        tenant_id: d.tenantId,
        owner_org_id: d.ownerOrgId,
        filename,
        content_type: d.contentType,
        size: d.bytes.length,
        sha256: sha256(d.bytes),
        storage_key: key,
        kind: d.kind,
        entity_type: d.entityType ?? null,
        entity_id: d.entityId ?? null,
        visibility: d.visibility,
        vendor_org_id: d.vendorOrgId ?? null,
        client_org_id: d.clientOrgId ?? null,
        include_in_spec_book: d.includeInSpecBook ?? false,
        page_count: pageCount,
        template: d.template ?? null,
        uploaded_by: d.uploadedBy ?? null,
        uploaded_by_name: d.uploadedByName ?? null,
      } as never)}`;
  } catch (err) {
    await storage()
      .remove(key)
      .catch(() => {});
    throw err;
  }
  return id;
}

const COLUMNS = `d.id, d.tenant_id, d.filename, d.content_type, d.size, d.sha256, d.kind, d.template, d.entity_type,
  d.entity_id, d.visibility, d.vendor_org_id, d.client_org_id, d.include_in_spec_book, d.page_count,
  d.created_at, d.updated_at, d.uploaded_by_name, d.storage_key`;

export interface DocumentRow {
  id: string;
  tenantId: string | null;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  kind: DocumentKind;
  template: string | null;
  entityType: string | null;
  entityId: string | null;
  visibility: Visibility;
  vendorOrgId: string | null;
  clientOrgId: string | null;
  includeInSpecBook: boolean;
  pageCount: number | null;
  createdAt: string;
  updatedAt: string;
  uploadedByName: string | null;
  storageKey: string;
}

/** One live (not deleted) document visible to the caller's RLS context. */
export async function findDocument(tx: Db, id: string): Promise<DocumentRow | undefined> {
  const [row] = await tx<DocumentRow[]>`
    select ${tx.unsafe(COLUMNS)} from documents.documents d where d.id = ${id} and d.deleted_at is null`;
  return row;
}

export const downloadPath = (id: string) => `/api/documents/documents/${id}/download`;

/** Attach additional-link info and serialize to the public Document shape. */
export async function present(tx: Db, rows: DocumentRow[]): Promise<DocumentOut[]> {
  if (!rows.length) return [];
  const links = await tx<{ documentId: string; entityType: string; entityId: string }[]>`
    select document_id, entity_type, entity_id from documents.document_links
    where document_id in ${tx(rows.map((r) => r.id))} order by created_at`;
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    contentType: r.contentType,
    size: r.size,
    sha256: r.sha256,
    kind: r.kind,
    template: r.template,
    entityType: r.entityType,
    entityId: r.entityId,
    visibility: r.visibility,
    vendorOrgId: r.vendorOrgId,
    clientOrgId: r.clientOrgId,
    includeInSpecBook: r.includeInSpecBook,
    pageCount: r.pageCount,
    global: r.tenantId === null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    uploadedByName: r.uploadedByName,
    downloadUrl: downloadPath(r.id),
    links: links
      .filter((l) => l.documentId === r.id)
      .map((l) => ({ entityType: l.entityType, entityId: l.entityId })),
  }));
}

export async function presentOne(tx: Db, row: DocumentRow): Promise<DocumentOut> {
  const [out] = await present(tx, [row]);
  return out!;
}

export interface ListFilter {
  entityType?: string;
  entityId?: string;
  kind?: string;
  visibility?: string;
  includeInSpecBook?: boolean;
  q?: string;
  limit: number;
  offset: number;
}

/** Documents whose primary entity matches, plus those linked to it via document_links. */
export async function listDocuments(tx: Db, f: ListFilter) {
  const entity =
    f.entityType && f.entityId
      ? tx`and ((d.entity_type = ${f.entityType} and d.entity_id = ${f.entityId})
               or exists (select 1 from documents.document_links l where l.document_id = d.id
                          and l.entity_type = ${f.entityType} and l.entity_id = ${f.entityId}))`
      : f.entityType
        ? tx`and d.entity_type = ${f.entityType}`
        : tx``;
  const where = tx`
    where d.deleted_at is null ${entity}
      ${f.kind ? tx`and d.kind = ${f.kind}` : tx``}
      ${f.visibility ? tx`and d.visibility = ${f.visibility}` : tx``}
      ${f.includeInSpecBook !== undefined ? tx`and d.include_in_spec_book = ${f.includeInSpecBook}` : tx``}
      ${f.q ? tx`and d.filename ilike ${`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}` : tx``}`;
  const [c] = await tx<
    { total: number }[]
  >`select count(*)::int as total from documents.documents d ${where}`;
  const rows = await tx<DocumentRow[]>`
    select ${tx.unsafe(COLUMNS)} from documents.documents d ${where}
    order by d.created_at desc, d.id limit ${f.limit} offset ${f.offset}`;
  return { rows, total: c?.total ?? 0 };
}
