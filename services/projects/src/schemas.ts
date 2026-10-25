import {
  IsoDate,
  ProjectRole,
  ProjectStage,
  ProjectStatus,
  ProjectType,
  page,
  TaskKind,
  TaskParty,
  TaskStatus,
} from '@procure/domain';
import { z } from '@procure/platform';

// ---------------------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------------------
export const IdParams = z.object({ id: z.uuid() });
export const ProjectChildParams = z.object({ id: z.uuid(), childId: z.uuid() });
export const Ok = z.object({ ok: z.boolean() });

/** Lenient address: every field optional so partially-known sites can be saved. */
export const AddressInput = z.object({
  line1: z.string().max(200).optional(),
  line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(2).optional(),
});
export const AddressOut = AddressInput;

const csv = <T extends z.ZodType<string, string>>(item: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(item));

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/**
 * PATCH schema from a create schema: every field optional and defaults removed, so omitted fields are
 * left untouched instead of being reset to their create-time default.
 */
const patchOf = <S extends z.ZodRawShape>(o: z.ZodObject<S>) =>
  z.object(
    Object.fromEntries(
      Object.entries(o.shape).map(([k, v]) => [
        k,
        (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : (v as z.ZodType)).optional(),
      ]),
    ),
  ) as unknown as z.ZodObject<{ [K in keyof S]: z.ZodOptional<S[K]> }>;

const Paging = {
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).optional(),
};

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------
export const TeamMember = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string().nullable(),
  role: ProjectRole,
  isLead: z.boolean(),
});
export const TeamMemberInput = z.object({
  userId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  email: z.string().email().nullable().optional(),
  role: ProjectRole,
  isLead: z.boolean().default(false),
});

export const ContactRole = z.enum([
  'owner_rep',
  'gm',
  'site_manager',
  'gc',
  'installer',
  'warehouse',
  'architect',
  'designer',
  'other',
]);
export const Contact = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  company: z.string().nullable(),
  role: ContactRole,
  email: z.string().nullable(),
  phone: z.string().nullable(),
  isDeliveryRecipient: z.boolean(),
  visibleToClient: z.boolean(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ContactInput = z.object({
  name: z.string().trim().min(1).max(200),
  company: z.string().max(200).nullable().optional(),
  role: ContactRole.default('other'),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  isDeliveryRecipient: z.boolean().default(false),
  visibleToClient: z.boolean().default(false),
  notes: z.string().max(4000).nullable().optional(),
});
export const ContactPatch = patchOf(ContactInput);

export const Project = z.object({
  id: z.uuid(),
  number: z.string(),
  name: z.string(),
  propertyName: z.string().nullable(),
  brandId: z.uuid().nullable(),
  clientOrgId: z.uuid().nullable(),
  type: ProjectType,
  stage: ProjectStage,
  status: ProjectStatus,
  keys: z.number().int().nullable(),
  floors: z.number().int().nullable(),
  address: AddressOut,
  shipToAddress: AddressOut,
  targetOpenDate: z.string().nullable(),
  startDate: z.string().nullable(),
  budget: z.number().nullable(),
  creditTerms: z.string().nullable(),
  tags: z.array(z.string()),
  description: z.string().nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const NextMilestone = z
  .object({ id: z.uuid(), name: z.string(), due: z.string().nullable() })
  .nullable();

export const ProjectListItem = Project.extend({
  openTasks: z.number().int(),
  overdueTasks: z.number().int(),
  nextMilestone: NextMilestone,
});

export const ProjectListQuery = z.object({
  ...Paging,
  stage: csv(ProjectStage).optional(),
  status: csv(ProjectStatus).optional(),
  clientOrgId: z.uuid().optional(),
  brandId: z.uuid().optional(),
  assignee: z.union([z.literal('me'), z.uuid()]).optional(),
  sort: z
    .enum([
      'number',
      '-number',
      'name',
      '-name',
      'targetOpenDate',
      '-targetOpenDate',
      'updatedAt',
      '-updatedAt',
      'createdAt',
      '-createdAt',
      'stage',
      '-stage',
    ])
    .default('-updatedAt'),
});

export const ProjectInput = z.object({
  name: z.string().trim().min(1).max(200),
  propertyName: z.string().max(200).nullable().optional(),
  brandId: z.uuid().nullable().optional(),
  clientOrgId: z.uuid().nullable().optional(),
  type: ProjectType.default('renovation'),
  stage: ProjectStage.default('lead'),
  status: ProjectStatus.default('active'),
  keys: z.number().int().min(0).max(10000).nullable().optional(),
  floors: z.number().int().min(0).max(300).nullable().optional(),
  address: AddressInput.default({}),
  shipToAddress: AddressInput.nullable().optional(),
  targetOpenDate: IsoDate.nullable().optional(),
  startDate: IsoDate.nullable().optional(),
  budget: z.number().min(0).max(1e12).nullable().optional(),
  creditTerms: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).default([]),
  description: z.string().max(20000).nullable().optional(),
  team: z.array(TeamMemberInput).max(50).optional(),
  templateId: z.uuid().optional(),
  anchorDate: IsoDate.optional(),
});
export const ProjectPatch = patchOf(ProjectInput.omit({ team: true, templateId: true, anchorDate: true }));

export const TaskCounts = z.object({
  todo: z.number().int(),
  in_progress: z.number().int(),
  blocked: z.number().int(),
  done: z.number().int(),
  skipped: z.number().int(),
  overdue: z.number().int(),
  total: z.number().int(),
});

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------
export const Task = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  templateTaskId: z.uuid().nullable(),
  key: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  phase: z.string().nullable(),
  kind: TaskKind,
  party: TaskParty,
  status: TaskStatus,
  assigneeUserId: z.uuid().nullable(),
  assigneeName: z.string().nullable(),
  assigneeRole: ProjectRole.nullable(),
  workHours: z.number().nullable(),
  durationDays: z.number().int(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  completedAt: z.string().nullable(),
  completedByName: z.string().nullable(),
  dependsOn: z.array(z.uuid()),
  isMilestone: z.boolean(),
  autoCompleteOn: z.string().nullable(),
  ready: z.boolean(),
  overdue: z.boolean(),
  sort: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const TaskWithProject = Task.extend({
  projectNumber: z.string(),
  projectName: z.string(),
  propertyName: z.string().nullable(),
});

export const Milestone = z.object({
  id: z.uuid(),
  name: z.string(),
  phase: z.string().nullable(),
  party: TaskParty,
  status: TaskStatus,
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const ProjectDetail = Project.extend({
  team: z.array(TeamMember),
  contacts: z.array(Contact),
  milestones: z.array(Milestone),
  taskCounts: TaskCounts,
});

export const DueFilter = z.enum(['overdue', 'today', 'this_week', 'next_week', 'no_date']);
export const TaskListQuery = z.object({
  ...Paging,
  assignee: z.union([z.enum(['me', 'unassigned']), z.uuid()]).optional(),
  projectId: z.uuid().optional(),
  status: csv(TaskStatus).optional(),
  party: TaskParty.optional(),
  due: DueFilter.optional(),
  kind: TaskKind.optional(),
  milestone: bool.optional(),
  ready: bool.optional(),
  /** Default true: only tasks of active / on-hold projects (the "action required" view). */
  activeProjectsOnly: bool.default(true),
  sort: z.enum(['dueDate', '-dueDate', 'updatedAt', '-updatedAt', 'project']).default('dueDate'),
});

const TaskEditable = z.object({
  name: z.string().trim().min(1).max(300),
  description: z.string().max(10000).nullable().optional(),
  phase: z.string().max(100).nullable().optional(),
  kind: TaskKind.default('task'),
  party: TaskParty.default('internal'),
  assigneeUserId: z.uuid().nullable().optional(),
  assigneeName: z.string().max(200).nullable().optional(),
  assigneeRole: ProjectRole.nullable().optional(),
  workHours: z.number().min(0).max(10000).nullable().optional(),
  durationDays: z.number().int().min(0).max(1000).optional(),
  startDate: IsoDate.nullable().optional(),
  dueDate: IsoDate.nullable().optional(),
  dependsOn: z.array(z.uuid()).max(50).default([]),
  isMilestone: z.boolean().default(false),
  autoCompleteOn: z.string().max(100).nullable().optional(),
});
export const TaskInput = TaskEditable.extend({ projectId: z.uuid() });
export const TaskPatch = patchOf(TaskEditable).extend({ status: TaskStatus.optional() });
export const CompleteBody = z.object({ note: z.string().max(2000).optional() }).optional();

export const RescheduleBody = z.object({ fromTaskId: z.uuid() });
export const RescheduleQuery = z.object({ dryRun: bool.default(false) });
export const RescheduleResult = z.object({
  dryRun: z.boolean(),
  deltaDays: z.number().int(),
  changes: z.array(
    z.object({
      taskId: z.uuid(),
      name: z.string(),
      fromStart: z.string().nullable(),
      toStart: z.string().nullable(),
      fromDue: z.string().nullable(),
      toDue: z.string().nullable(),
    }),
  ),
});

export const GanttTask = z.object({
  id: z.uuid(),
  key: z.string().nullable(),
  name: z.string(),
  phase: z.string().nullable(),
  party: TaskParty,
  kind: TaskKind,
  status: TaskStatus,
  assigneeName: z.string().nullable(),
  start: z.string().nullable(),
  due: z.string().nullable(),
  durationDays: z.number().int(),
  dependsOn: z.array(z.uuid()),
  progress: z.number(),
  isMilestone: z.boolean(),
  critical: z.boolean(),
  overdue: z.boolean(),
});
export const Gantt = z.object({
  projectId: z.uuid(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  targetOpenDate: z.string().nullable(),
  tasks: z.array(GanttTask),
});

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------
export const TemplateTask = z.object({
  id: z.uuid(),
  templateId: z.uuid(),
  key: z.string(),
  name: z.string(),
  phase: z.string().nullable(),
  kind: TaskKind,
  party: TaskParty,
  assigneeRole: ProjectRole.nullable(),
  workHours: z.number().nullable(),
  durationDays: z.number().int(),
  dependsOn: z.array(z.string()),
  offsetDays: z.number().int(),
  isMilestone: z.boolean(),
  autoCompleteOn: z.string().nullable(),
  description: z.string().nullable(),
  sort: z.number().int(),
});
export const TemplateTaskInput = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase slug')
    .max(80),
  name: z.string().trim().min(1).max(300),
  phase: z.string().max(100).nullable().optional(),
  kind: TaskKind.default('task'),
  party: TaskParty.default('internal'),
  assigneeRole: ProjectRole.nullable().optional(),
  workHours: z.number().min(0).max(10000).nullable().optional(),
  durationDays: z.number().int().min(0).max(1000).default(1),
  dependsOn: z.array(z.string()).max(50).default([]),
  offsetDays: z.number().int().min(-365).max(365).default(0),
  isMilestone: z.boolean().default(false),
  autoCompleteOn: z.string().max(100).nullable().optional(),
  description: z.string().max(10000).nullable().optional(),
  sort: z.number().int().optional(),
});
export const TemplateTaskPatch = patchOf(TemplateTaskInput);

export const Template = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  projectType: ProjectType.nullable(),
  isDefault: z.boolean(),
  taskCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const TemplateDetail = Template.extend({ tasks: z.array(TemplateTask) });
export const TemplateInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).nullable().optional(),
  projectType: ProjectType.nullable().optional(),
  isDefault: z.boolean().default(false),
  tasks: z.array(TemplateTaskInput).max(500).optional(),
});
export const TemplatePatch = patchOf(TemplateInput.omit({ tasks: true }));
export const TemplateTasksReplace = z.object({ tasks: z.array(TemplateTaskInput).max(500) });

export const ApplyTemplateBody = z.object({
  templateId: z.uuid(),
  anchorDate: IsoDate,
  mode: z.enum(['append', 'replace']).default('append'),
});
export const ApplyTemplateResult = z.object({
  created: z.number().int(),
  removed: z.number().int(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  tasks: z.array(Task),
});

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------
export const NoteVisibility = z.enum(['internal', 'client']);
export const Note = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  authorId: z.uuid().nullable(),
  authorName: z.string(),
  body: z.string(),
  visibility: NoteVisibility,
  pinned: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const NoteInput = z.object({
  body: z.string().trim().min(1).max(20000),
  visibility: NoteVisibility.default('internal'),
  pinned: z.boolean().default(false),
});
export const NotePatch = patchOf(NoteInput);
export const NoteListQuery = z.object({
  limit: Paging.limit,
  offset: Paging.offset,
  visibility: NoteVisibility.optional(),
});

// ---------------------------------------------------------------------------------------------
// Reports & dashboard
// ---------------------------------------------------------------------------------------------
export const ScheduleReportBody = z.object({
  includeParties: z.array(TaskParty).min(1).optional(),
  notes: z.string().max(4000).optional(),
  /** Include every task, not only milestones (and client tasks when the client party is included). */
  allTasks: z.boolean().default(false),
  visibility: z.enum(['internal', 'client']).default('internal'),
});
export const DocumentOut = z
  .object({
    id: z.uuid(),
    filename: z.string(),
    contentType: z.string(),
    size: z.number().optional(),
    kind: z.string().optional(),
    entityType: z.string().nullable().optional(),
    entityId: z.string().nullable().optional(),
    visibility: z.string().optional(),
    pageCount: z.number().nullable().optional(),
    createdAt: z.string().optional(),
    downloadUrl: z.string().optional(),
  })
  .passthrough();

export const Dashboard = z.object({
  activeProjects: z.number().int(),
  byStage: z.array(z.object({ stage: ProjectStage, count: z.number().int() })),
  tasksDueThisWeek: z.number().int(),
  overdueTasks: z.number().int(),
  myTasks: z.array(TaskWithProject),
  upcomingMilestones: z.array(TaskWithProject),
  recentlyUpdatedProjects: z.array(
    z.object({
      id: z.uuid(),
      number: z.string(),
      name: z.string(),
      stage: ProjectStage,
      status: ProjectStatus,
      updatedAt: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------------------------
// Client portal — separate schemas so internal fields (budget, credit terms, internal notes,
// internal tasks, work hours...) can never serialize to an owner.
// ---------------------------------------------------------------------------------------------
export const ClientProjectSummary = z.object({
  id: z.uuid(),
  number: z.string(),
  name: z.string(),
  propertyName: z.string().nullable(),
  type: ProjectType,
  stage: ProjectStage,
  status: ProjectStatus,
  address: AddressOut,
  targetOpenDate: z.string().nullable(),
  openClientTasks: z.number().int(),
  nextMilestone: NextMilestone,
});
export const ClientTask = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  phase: z.string().nullable(),
  kind: TaskKind,
  party: TaskParty,
  status: TaskStatus,
  isMilestone: z.boolean(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  completedAt: z.string().nullable(),
  completedByName: z.string().nullable(),
  canComplete: z.boolean(),
});
export const ClientProjectDetail = z.object({
  id: z.uuid(),
  number: z.string(),
  name: z.string(),
  propertyName: z.string().nullable(),
  type: ProjectType,
  stage: ProjectStage,
  status: ProjectStatus,
  keys: z.number().int().nullable(),
  address: AddressOut,
  shipToAddress: AddressOut,
  targetOpenDate: z.string().nullable(),
  team: z.array(
    z.object({ name: z.string(), email: z.string().nullable(), role: ProjectRole, isLead: z.boolean() }),
  ),
  contacts: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      company: z.string().nullable(),
      role: ContactRole,
      email: z.string().nullable(),
      phone: z.string().nullable(),
    }),
  ),
  milestones: z.array(ClientTask),
  tasks: z.array(ClientTask),
  notes: z.array(
    z.object({
      id: z.uuid(),
      authorName: z.string(),
      body: z.string(),
      pinned: z.boolean(),
      createdAt: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------------------------
// Internal (service-to-service) — see docs/service-contracts.md
// ---------------------------------------------------------------------------------------------
export const InternalProject = z.object({
  id: z.uuid(),
  number: z.string(),
  name: z.string(),
  propertyName: z.string().nullable(),
  brandId: z.uuid().nullable(),
  clientOrgId: z.uuid().nullable(),
  address: AddressOut,
  shipToAddress: AddressOut,
  targetOpenDate: z.string().nullable(),
  stage: ProjectStage,
  status: ProjectStatus,
  team: z.array(
    z.object({ userId: z.uuid(), name: z.string(), email: z.string().nullable(), role: ProjectRole }),
  ),
  contacts: z
    .array(
      z.object({
        name: z.string(),
        email: z.string().nullable(),
        phone: z.string().nullable(),
        company: z.string().nullable(),
        role: ContactRole,
        isDeliveryRecipient: z.boolean(),
      }),
    )
    .optional(),
});

export const pageOf = page;
export type TaskRow = z.infer<typeof Task>;
