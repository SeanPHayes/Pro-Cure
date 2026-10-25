import { type App, notFound, z } from '@procure/platform';
import { getProjectRow } from '../engine.js';
import { IdParams, Note, NoteInput, NoteListQuery, NotePatch, Ok, pageOf } from '../schemas.js';
import { requireStaff, total } from './helpers.js';

const NoteParams = z.object({ id: z.uuid(), noteId: z.uuid() });

export async function noteRoutes(app: App) {
  app.get(
    '/projects/:id/notes',
    {
      schema: {
        tags: ['notes'],
        summary: 'Project notes (pinned first, newest first)',
        params: IdParams,
        querystring: NoteListQuery,
        response: { 200: pageOf(Note) },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      const q = req.query;
      return req.tx(async (tx) => {
        await getProjectRow(tx, req.params.id);
        const rows = await tx<{ totalCount: number }[]>`
          select n.*, count(*) over () as total_count from projects.notes n
          where n.project_id = ${req.params.id} ${q.visibility ? tx`and n.visibility = ${q.visibility}` : tx``}
          order by n.pinned desc, n.created_at desc limit ${q.limit} offset ${q.offset}`;
        return { items: rows as never, total: total(rows), limit: q.limit, offset: q.offset };
      });
    },
  );

  app.post(
    '/projects/:id/notes',
    {
      schema: {
        tags: ['notes'],
        summary: 'Add a note (visibility client = shown in the owner portal)',
        params: IdParams,
        body: NoteInput,
        response: { 201: Note },
      },
    },
    async (req, reply) => {
      requireStaff(req.principal, 'projects:write');
      const n = await req.tx(async (tx) => {
        await getProjectRow(tx, req.params.id);
        const [row] = await tx`insert into projects.notes ${tx({
          tenantId: req.principal.tenantId,
          projectId: req.params.id,
          authorId: req.principal.userId,
          authorName: req.principal.name,
          body: req.body.body,
          visibility: req.body.visibility,
          pinned: req.body.pinned,
        })} returning *`;
        return row;
      });
      return reply.status(201).send(n as never);
    },
  );

  app.patch(
    '/projects/:id/notes/:noteId',
    {
      schema: {
        tags: ['notes'],
        summary: 'Edit a note',
        params: NoteParams,
        body: NotePatch,
        response: { 200: Note },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:write');
      return req.tx(async (tx) => {
        const set = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
        const [row] = Object.keys(set).length
          ? await tx`update projects.notes set ${tx(set, Object.keys(set))}
                     where id = ${req.params.noteId} and project_id = ${req.params.id} returning *`
          : await tx`select * from projects.notes where id = ${req.params.noteId} and project_id = ${req.params.id}`;
        if (!row) throw notFound('Note');
        return row as never;
      });
    },
  );

  app.delete(
    '/projects/:id/notes/:noteId',
    {
      schema: { tags: ['notes'], summary: 'Delete a note', params: NoteParams, response: { 200: Ok } },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:write');
      return req.tx(async (tx) => {
        const r = await tx`delete from projects.notes
                           where id = ${req.params.noteId} and project_id = ${req.params.id} returning id`;
        if (!r.length) throw notFound('Note');
        return { ok: true };
      });
    },
  );
}
