import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Globe, Store } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, cx, EmptyState, ErrorNote, Field, Input, Loading, Section, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { humanize } from '@/lib/format';

interface VendorSelf {
  id: string;
  name: string;
  website: string | null;
  emailDomains: string[];
  categories: string[];
  hqCity: string | null;
  hqRegion: string | null;
  hqCountry: string | null;
  description: string | null;
  verified: boolean;
  updatedAt: string;
}

const CATEGORIES = [
  'casegoods',
  'seating',
  'soft_seating',
  'tables',
  'bedding',
  'lighting',
  'mirrors',
  'artwork',
  'window_treatments',
  'carpet',
  'flooring',
  'wallcovering',
  'millwork',
  'plumbing',
  'electronics',
  'signage',
  'outdoor',
  'ose',
  'other',
];
const LABEL: Record<string, string> = {
  ose: 'OS&E',
  soft_seating: 'Upholstered seating',
  window_treatments: 'Window treatments',
};

export function Component() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['vendor', 'profile'],
    queryFn: () => api.get<VendorSelf>('catalog', '/vendor/profile'),
  });
  if (q.isLoading) return <Loading label="Loading your listing" />;
  if (q.isError)
    return (
      <div className="mx-auto max-w-[820px] px-4 py-6">
        <ErrorNote error={q.error} />
      </div>
    );
  if (!q.data)
    return (
      <EmptyState icon={<Store />} title="No listing yet">
        Your company listing hasn’t been set up. Contact the procurement firm that invited you.
      </EmptyState>
    );
  return <ProfileForm v={q.data} onSaved={(v) => qc.setQueryData(['vendor', 'profile'], v)} />;
}

function ProfileForm({ v, onSaved }: { v: VendorSelf; onSaved: (v: VendorSelf) => void }) {
  const [f, setF] = useState({
    website: v.website ?? '',
    description: v.description ?? '',
    hqCity: v.hqCity ?? '',
    hqRegion: v.hqRegion ?? '',
    hqCountry: v.hqCountry ?? '',
  });
  const [cats, setCats] = useState<Set<string>>(new Set(v.categories));
  const dirty =
    f.website !== (v.website ?? '') ||
    f.description !== (v.description ?? '') ||
    f.hqCity !== (v.hqCity ?? '') ||
    f.hqRegion !== (v.hqRegion ?? '') ||
    f.hqCountry !== (v.hqCountry ?? '') ||
    cats.size !== v.categories.length ||
    v.categories.some((c) => !cats.has(c));
  const m = useMutation({
    mutationFn: () =>
      api.patch<VendorSelf>('catalog', '/vendor/profile', {
        website: f.website.trim() || null,
        description: f.description.trim() || null,
        categories: [...cats],
        hqCity: f.hqCity.trim() || null,
        hqRegion: f.hqRegion.trim() || null,
        hqCountry: f.hqCountry.trim() || null,
      }),
    onSuccess: (nv) => {
      toast.success('Company profile saved');
      onSaved(nv);
    },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <div className="mx-auto max-w-[820px] px-4 py-6 sm:px-6">
      <h1 className="flex flex-wrap items-center gap-2 text-[24px] leading-tight font-[640]">
        {v.name}
        {v.verified && (
          <span className="inline-flex items-center gap-1 rounded-xs bg-ok-50 px-1.5 py-0.5 text-[12px] font-[620] text-ok">
            <BadgeCheck className="size-3.5" />
            Verified
          </span>
        )}
      </h1>
      <p className="mt-1 max-w-[66ch] text-ink-2">
        This is your company’s listing in the Pro-Cure vendor network. Procurement firms and designers use it
        to find vendors by category and region. It’s shared across every firm on Pro-Cure, so keep it general:
        your prices, terms and orders with each firm stay private to that firm.
      </p>

      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Section title="About your company">
          <div className="space-y-4">
            <Field label="Website">
              {(id) => (
                <div className="relative">
                  <Globe className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-3" />
                  <Input
                    id={id}
                    className="pl-8"
                    value={f.website}
                    onChange={set('website')}
                    placeholder="https://"
                  />
                </div>
              )}
            </Field>
            <Field
              label="Description"
              hint="What you make, for which kinds of hotels, typical lead times and capacity."
            >
              {(id) => (
                <Textarea
                  id={id}
                  rows={5}
                  value={f.description}
                  onChange={set('description')}
                  maxLength={5000}
                />
              )}
            </Field>
          </div>
        </Section>
        <Section title="Headquarters">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="City">{(id) => <Input id={id} value={f.hqCity} onChange={set('hqCity')} />}</Field>
            <Field label="State or region">
              {(id) => <Input id={id} value={f.hqRegion} onChange={set('hqRegion')} />}
            </Field>
            <Field label="Country">
              {(id) => <Input id={id} value={f.hqCountry} onChange={set('hqCountry')} />}
            </Field>
          </div>
        </Section>
        <Section title={`What you supply${cats.size ? ` · ${cats.size}` : ''}`}>
          <fieldset>
            <legend className="mb-2 text-[13px] text-ink-2">
              Choose every category you can quote. Firms search the network by these.
            </legend>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => {
                const on = cats.has(c);
                return (
                  <label
                    key={c}
                    className={cx(
                      'cursor-pointer rounded-sm border px-2.5 py-1 text-[13px] font-[560] select-none focus-within:ring-2 focus-within:ring-brass',
                      on
                        ? 'border-lacquer bg-lacquer text-white'
                        : 'border-line bg-paper text-ink-2 hover:border-ink-4',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      onChange={() => {
                        const n = new Set(cats);
                        if (on) n.delete(c);
                        else n.add(c);
                        setCats(n);
                      }}
                    />
                    {LABEL[c] ?? humanize(c)}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </Section>
        {v.emailDomains.length > 0 && (
          <p className="text-[13px] text-ink-3">
            Emails from {v.emailDomains.map((d) => `@${d}`).join(', ')} are recognised as your company.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!dirty}>
            Save profile
          </Button>
        </div>
      </form>
    </div>
  );
}
