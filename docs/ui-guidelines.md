# Web UI guidelines (apps/web)

## Stack
React 19 + TypeScript, Vite, Tailwind CSS 4 (tokens in `src/styles.css`), TanStack Query, React Router 8
(lazy route modules exporting `Component`, wired in `src/app/router.tsx`), lucide-react icons, sonner
toasts, cmdk. API client: `src/lib/api.ts` (`api.get('quoting', '/quotes', query)` → `/api/quoting/quotes`).
Formatting helpers: `src/lib/format.ts`. URL-synced list state: `useListParams` in `src/lib/hooks.ts`.

## Design language
Hotel-interiors vocabulary, not generic SaaS. Lacquered green `lacquer` (primary actions, nav rail),
brushed brass `brass` (selection, emphasis, the one accent), cool stone ground `stone`, white `paper`
surfaces, ink text `ink/ink-2/ink-3`. Muted status tones (`ok, warn, risk, crit, info`). One typeface:
Instrument Sans; use `num` utility for tabular figures in tables and money.

- Record pages open with a **TitleBlock** (ruled grid of identifying facts, like an architectural sheet's
  title block) — once per record page, nowhere else.
- Dense, scannable data: `DataTable` with sticky headers; money right-aligned with `num`. Prefer tables
  and ruled lists over grids of identical cards. `Section` panels have a 1px border, no shadow.
- Sentence case everywhere. No ALL-CAPS labels, no eyebrow labels above headings, no "→" on buttons,
  no middle-dot meta strings except for compact secondary metadata lines.
- Buttons say what happens ("Create purchase orders", "Send to owner", "Apply 12 prices").
  The same action keeps the same name in toasts ("Purchase orders created").
- Empty states tell the user what to do next. Errors say what went wrong and how to fix it.
- Motion only in response to actions (sheet opening). Respect reduced motion (global CSS does).
- Responsive to ~380px: tables scroll horizontally; side-by-side layouts stack.
- Forms in a `Sheet` (side panel) for create/edit; `Dialog` for confirmations.

## Components (src/components)
`ui/index.tsx`: Button, IconButton, Input, Textarea, Select (+`enumOptions`), Field, SearchInput,
Checkbox, Badge, StatusBadge (maps every status enum to a tone), EscalationMark, PageHeader, Section,
TitleBlock, EmptyState, Spinner, Loading, ErrorNote, Avatar, Stat, Tabs, Chips, Sheet, Dialog, Menu,
Facts, ProgressBar. `ui/DataTable.tsx`: DataTable (columns, selection, server sort), Pagination.
`shared/DocumentsPanel.tsx`, `shared/ThreadPanel.tsx`, `shared/ActivityFeed.tsx` — reuse these on
every record page (files, conversation, history).

Do not change the props of existing shared components; add new shared components as new files.

## Permissions & surfaces
`useSession()` / `hasPerm(session, 'orders:write')` from `src/lib/auth.tsx`. Hide actions the user can't
perform. Internal pages live under `src/features/<domain>/`, vendor portal under `src/portals/vendor/`,
owner portal under `src/portals/client/`. Vendor and owner pages are simpler, calmer, more explanatory —
assume a first-time user.

## Verifying
`pnpm --filter @procure/web typecheck`, then view pages with the screenshot helper against the running
stack: `python3 tools/screenshot.py <demo-user-email> /tmp/shots /app/projects /app/projects/<id>`
(read the PNGs). Demo users are listed at `GET /api/identity/auth/dev/users`.
