import type { z } from '@procure/platform';
import type { ScheduleData } from './data.js';
import {
  addressLines,
  C,
  type Chip,
  chip,
  dataTable,
  date,
  documentShell,
  fieldGrid,
  humanize,
  letterhead,
  type Node,
  notes,
  section,
  text,
} from './pdf.js';

type Data = z.infer<typeof ScheduleData>;
type Milestone = Data['milestones'][number];

const tone = (status: string | null | undefined): Chip['tone'] => {
  const s = (status ?? '').toLowerCase();
  if (['done', 'complete', 'completed', 'approved'].includes(s)) return 'green';
  if (['blocked', 'late', 'overdue', 'at_risk', 'critical'].includes(s)) return 'red';
  if (['in_progress', 'pending', 'watch'].includes(s)) return 'amber';
  if (['skipped', 'cancelled'].includes(s)) return 'neutral';
  return 'accent';
};

const isOverdue = (m: Milestone, today: string) =>
  !!m.due &&
  !m.completedAt &&
  m.due < today &&
  !['done', 'complete', 'completed', 'skipped'].includes((m.status ?? '').toLowerCase());

export function scheduleDoc(d: Data, generatedAt = new Date()) {
  const today = (d.generatedAt ?? generatedAt.toISOString()).slice(0, 10);
  const done = d.milestones.filter(
    (m) => m.completedAt || ['done', 'complete', 'completed'].includes((m.status ?? '').toLowerCase()),
  ).length;
  const overdue = d.milestones.filter((m) => isOverdue(m, today)).length;
  const pct = d.milestones.length ? Math.round((done / d.milestones.length) * 100) : 0;

  const stat = (label: string, value: string, color = C.ink): Node => ({
    stack: [
      { text: label.toUpperCase(), style: 'label' },
      { text: value, fontSize: 16, bold: true, color },
    ],
  });

  const content: Node[] = [
    letterhead(d.tenant, 'Project Schedule', d.project.number ?? null),
    {
      stack: [
        { text: d.project.name, fontSize: 12, bold: true, color: C.ink },
        ...[d.project.propertyName, ...addressLines(d.project.address)]
          .filter(Boolean)
          .map((l) => ({ text: l, style: 'muted' })),
      ],
      margin: [0, 0, 0, 10],
    },
    {
      columns: [
        stat('Milestones', String(d.milestones.length)),
        stat('Complete', `${done} · ${pct}%`, C.green),
        stat('Overdue', String(overdue), overdue ? C.red : C.ink),
        stat('As of', date(today)),
      ],
      margin: [0, 0, 0, 12],
    },
  ];
  if (d.headerFields.length)
    content.push(
      fieldGrid(
        d.headerFields.map((f) => ({
          label: f.label,
          value: typeof f.value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(f.value) ? date(f.value) : f.value,
        })),
      ),
    );

  content.push(
    section('Milestones'),
    dataTable(
      [
        { header: '#', width: 18, align: 'right', value: (_m: Milestone, i) => String(i + 1) },
        { header: 'Milestone', value: (m) => ({ text: m.name, bold: true, color: C.ink }) },
        { header: 'Party', width: 62, value: (m) => humanize(text(m.party)) },
        { header: 'Start', width: 66, value: (m) => date(m.start) },
        {
          header: 'Due',
          width: 66,
          value: (m) => ({
            text: date(m.due),
            color: isOverdue(m, today) ? C.red : C.body,
            bold: isOverdue(m, today),
          }),
        },
        { header: 'Completed', width: 66, value: (m) => date(m.completedAt) },
        {
          header: 'Status',
          width: 74,
          value: (m) =>
            m.status
              ? chip({ text: humanize(m.status), tone: isOverdue(m, today) ? 'red' : tone(m.status) })
              : '—',
        },
      ],
      d.milestones,
      { empty: 'No milestones scheduled' },
    ),
    ...notes('Notes', d.notes),
  );

  return documentShell({
    title: 'Project Schedule',
    subject: `Schedule · ${d.project.name}`,
    tenantName: d.tenant.name,
    content,
    generatedAt:
      d.generatedAt && !Number.isNaN(Date.parse(d.generatedAt)) ? new Date(d.generatedAt) : generatedAt,
  });
}
