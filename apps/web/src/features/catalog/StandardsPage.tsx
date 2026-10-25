import { useQuery } from '@tanstack/react-query';
import { BookOpen, FileUp, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Button,
  Chips,
  EmptyState,
  ErrorNote,
  Loading,
  PageHeader,
  SearchInput,
  StatusBadge,
} from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { count, date } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import { BrandSpecImportSheet } from '../ai/BrandSpecImportSheet';
import {
  type BrandStandard,
  categoryLabel,
  qk,
  type SearchResult,
  SharingMark,
  standardStatusLabel,
  useBrands,
} from './shared';

const DEFAULTS = { q: '', show: 'all' };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const PARENT_ORDER = ['Hilton', 'Marriott', 'IHG'];

export function Component() {
  const s = useSession();
  const nav = useNavigate();
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const [importing, setImporting] = useState(false);
  const canImport = hasPerm(s, 'ai:use') && hasPerm(s, 'catalog:contribute');

  const brands = useBrands();
  const standards = useQuery({
    queryKey: qk.standards({ limit: 500 }),
    queryFn: () => api.get<Page<BrandStandard>>('catalog', '/brand-standards', { limit: 500 }),
  });
  const search = useQuery({
    queryKey: ['catalog', 'search', p.q],
    queryFn: () => api.get<SearchResult>('catalog', '/search', { q: p.q, limit: 100 }),
    enabled: p.q.length > 1,
  });

  const all = standards.data?.items ?? [];
  const visible = all.filter((x) =>
    p.show === 'shared'
      ? x.status === 'published'
      : p.show === 'mine'
        ? x.mine
        : x.status !== 'superseded' || x.mine,
  );
  const parentOf = new Map(brands.data?.map((b) => [b.id, b.parentCompany ?? 'Independent']));
  const groups = new Map<string, BrandStandard[]>();
  for (const x of visible) {
    const parent = parentOf.get(x.brandId) ?? 'Independent';
    groups.set(parent, [...(groups.get(parent) ?? []), x]);
  }
  const ordered = [...groups.entries()].sort(
    ([a], [b]) =>
      (PARENT_ORDER.indexOf(a) + 1 || 99) - (PARENT_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b),
  );
  const mineCount = all.filter((x) => x.mine).length;
  const sharedCount = all.filter((x) => x.status === 'published').length;

  const columns: Column<BrandStandard>[] = [
    {
      key: 'name',
      header: 'Package',
      cell: (r) => (
        <div className="min-w-[260px]">
          <Link
            to={`/app/catalog/standards/${r.id}`}
            className="font-[560] hover:text-lacquer"
            onClick={(e) => e.stopPropagation()}
          >
            {r.name.replace(`${r.brandName} – `, '')}
          </Link>
          <div className="text-[12px] text-ink-3">{r.brandName}</div>
        </div>
      ),
    },
    {
      key: 'version',
      header: 'Version',
      width: 96,
      cell: (r) => <span className="num">{r.version}</span>,
    },
    {
      key: 'effective',
      header: 'Effective',
      width: 120,
      cell: (r) => <span className="num whitespace-nowrap">{date(r.effectiveDate)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: 170,
      cell: (r) => <StatusBadge status={r.status} label={standardStatusLabel[r.status]} />,
    },
    { key: 'items', header: 'Items', align: 'right', width: 80, cell: (r) => count(r.itemCount) },
    { key: 'sharing', header: 'Source', width: 150, cell: (r) => <SharingMark s={r} /> },
  ];

  const searching = p.q.length > 1;

  return (
    <>
      <PageHeader
        title="Brand standards"
        description="Brand FF&E requirements, published once by Pro-Cure curators and shared with every firm. Drafts your firm imports stay private until published."
        actions={
          canImport && (
            <Button variant="primary" icon={<FileUp className="size-4" />} onClick={() => setImporting(true)}>
              Import from PDF
            </Button>
          )
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="Search items: headboard, CG-101, sconce…"
            className="w-full sm:w-80"
          />
          {!searching && (
            <Chips
              value={p.show}
              onChange={(v) => set({ show: v })}
              options={[
                { value: 'all', label: 'All packages' },
                { value: 'shared', label: 'Shared', count: sharedCount },
                { value: 'mine', label: 'Your firm’s', count: mineCount },
              ]}
            />
          )}
          {searching && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText('');
                set({ q: '' });
              }}
            >
              Clear search
            </Button>
          )}
        </div>
      </PageHeader>

      {searching ? (
        <SearchResults result={search.data} loading={search.isLoading} error={search.error} q={p.q} />
      ) : standards.isError ? (
        <ErrorNote error={standards.error} />
      ) : standards.isLoading || brands.isLoading ? (
        <Loading label="Loading brand standards" />
      ) : !ordered.length ? (
        <EmptyState
          icon={<BookOpen />}
          title={p.show === 'mine' ? 'Your firm hasn’t imported any packages yet' : 'No brand standards yet'}
          action={
            canImport && (
              <Button variant="primary" onClick={() => setImporting(true)}>
                Import from PDF
              </Button>
            )
          }
        >
          Import a brand’s FF&E standard PDF and Pro-Cure will read it into items you can review.
        </EmptyState>
      ) : (
        <div className="space-y-5 px-6 py-5 max-sm:px-4">
          {ordered.map(([parent, rows]) => (
            <section key={parent} className="overflow-hidden rounded-md border border-line bg-paper">
              <header className="flex items-baseline justify-between gap-3 border-b border-line-2 px-4 py-2.5">
                <h2 className="text-[15px] font-[640]">{parent}</h2>
                <span className="num text-[12px] text-ink-3">
                  {plural(new Set(rows.map((r) => r.brandId)).size, 'brand')} ·{' '}
                  {plural(rows.length, 'package')}
                </span>
              </header>
              <DataTable
                columns={columns}
                rows={rows}
                onRowClick={(r) => nav(`/app/catalog/standards/${r.id}`)}
              />
            </section>
          ))}
        </div>
      )}
      {canImport && <BrandSpecImportSheet open={importing} onClose={() => setImporting(false)} />}
    </>
  );
}

function SearchResults({
  result,
  loading,
  error,
  q,
}: {
  result: SearchResult | undefined;
  loading: boolean;
  error: unknown;
  q: string;
}) {
  const nav = useNavigate();
  if (error) return <ErrorNote error={error} />;
  if (loading) return <Loading label="Searching" />;
  const items = result?.brandStandardItems ?? [];
  if (!items.length)
    return (
      <EmptyState icon={<Search />} title={`No brand-standard items match “${q}”`}>
        Try an item code (CG-101), a product type (nightstand) or a finish.
      </EmptyState>
    );
  type Row = SearchResult['brandStandardItems'][number];
  const columns: Column<Row>[] = [
    {
      key: 'code',
      header: 'Code',
      width: 110,
      cell: (r) => <span className="num font-[560]">{r.code}</span>,
    },
    {
      key: 'name',
      header: 'Item',
      cell: (r) => <div className="min-w-[240px]">{r.name}</div>,
    },
    { key: 'cat', header: 'Category', cell: (r) => categoryLabel(r.category) },
    { key: 'area', header: 'Area', cell: (r) => r.area },
    {
      key: 'pkg',
      header: 'Package',
      cell: (r) => (
        <div className="min-w-[200px]">
          <div>{r.standardName.replace(`${r.brandName} – `, '')}</div>
          <div className="text-[12px] text-ink-3">{r.brandName}</div>
        </div>
      ),
    },
  ];
  return (
    <div className="bg-paper [&_td:first-child]:pl-6 [&_th:first-child]:pl-6">
      <div className="border-b border-line-2 px-6 py-2 text-[13px] text-ink-3">
        {items.length === 100
          ? 'Top 100 matching items'
          : `${items.length} matching ${items.length === 1 ? 'item' : 'items'}`}{' '}
        across all packages
      </div>
      <DataTable
        columns={columns}
        rows={items}
        onRowClick={(r) => nav(`/app/catalog/standards/${r.standardId}?item=${r.id}`)}
      />
    </div>
  );
}
