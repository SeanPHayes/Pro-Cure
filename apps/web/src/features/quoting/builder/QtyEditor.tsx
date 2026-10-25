import { useMemo, useState } from 'react';
import { Button, cx } from '@/components/ui';
import type { Line, QuoteDetail } from '../types';
import { computeQuantity } from './calc';
import type { LinePatch } from './data';

const numOr0 = (s: string) => {
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Quantity breakdown editor: fixed quantity, or quantity per room type × room count, plus attic
 * stock % and optional left/right handing (nightstands, sconces). Enter saves; Esc closes.
 */
export function QtyEditor({
  line,
  quote,
  onSave,
  onCancel,
  readOnly,
}: {
  line: Line;
  quote: QuoteDetail;
  onSave: (p: LinePatch) => void;
  onCancel: () => void;
  readOnly?: boolean;
}) {
  const rooms = quote.roomTypes;
  const [mode, setMode] = useState<'fixed' | 'per_room'>(
    line.qtyMode === 'per_room' || (line.qtyFixed === 0 && rooms.length > 0) ? 'per_room' : 'fixed',
  );
  const [fixed, setFixed] = useState(String(line.qtyFixed ?? 0));
  const [per, setPer] = useState<Record<string, string>>(
    Object.fromEntries(
      rooms.map((r) => [r.id, line.qtyPerRoom?.[r.id] ? String(line.qtyPerRoom[r.id]) : '']),
    ),
  );
  const [attic, setAttic] = useState(String(line.atticStockPct ?? 0));
  const [handed, setHanded] = useState(!!line.handing);
  const [left, setLeft] = useState(String(line.handing?.left ?? ''));
  const [right, setRight] = useState(String(line.handing?.right ?? ''));

  const draft = useMemo(() => {
    const qtyPerRoom = Object.fromEntries(
      Object.entries(per)
        .map(([k, v]) => [k, numOr0(v)] as const)
        .filter(([, v]) => v > 0),
    );
    return {
      qtyMode: mode,
      qtyFixed: mode === 'fixed' ? numOr0(fixed) : line.qtyFixed,
      qtyPerRoom: mode === 'per_room' ? qtyPerRoom : line.qtyPerRoom,
      atticStockPct: Math.min(100, numOr0(attic)),
    };
  }, [mode, fixed, per, attic, line]);
  const calc = computeQuantity(draft, rooms);
  const l = numOr0(left);
  const r = numOr0(right);
  const handingError = handed && l + r !== calc.quantity ? `L + R must equal ${calc.quantity}` : null;

  const save = () => {
    if (handingError) return;
    onSave({
      qtyMode: draft.qtyMode,
      ...(mode === 'fixed' ? { qtyFixed: draft.qtyFixed } : { qtyPerRoom: draft.qtyPerRoom }),
      atticStockPct: draft.atticStockPct,
      handing: handed ? { left: l, right: r } : null,
    });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  };
  const splitEven = (q: number) => {
    setLeft(String(Math.floor(q / 2)));
    setRight(String(q - Math.floor(q / 2)));
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Enter anywhere in the editor saves it
    <div className="p-3 text-[13px]" onKeyDown={onKey}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-[620]">Quantity</div>
        <div className="inline-flex rounded-sm border border-line p-0.5">
          {(['per_room', 'fixed'] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={readOnly || (m === 'per_room' && !rooms.length)}
              onClick={() => setMode(m)}
              className={cx(
                'h-6 rounded-xs px-2 text-[12px] font-[560] disabled:opacity-40',
                mode === m ? 'bg-lacquer text-white' : 'text-ink-2 hover:bg-stone',
              )}
            >
              {m === 'per_room' ? 'Per room type' : 'Fixed'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'per_room' ? (
        <table className="w-full">
          <thead>
            <tr className="text-[12px] text-ink-3">
              <th className="py-1 text-left font-[520]">Room type</th>
              <th className="py-1 text-right font-[520]">Per room</th>
              <th className="py-1 text-right font-[520]">Rooms</th>
              <th className="py-1 text-right font-[520]">Qty</th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((rt, i) => {
              const q = numOr0(per[rt.id] ?? '');
              return (
                <tr key={rt.id} className="border-t border-line-2">
                  <td className="py-1 pr-2">
                    <span className="font-[560]">{rt.name}</span>
                  </td>
                  <td className="py-1 text-right">
                    <input
                      // biome-ignore lint/a11y/noAutofocus: the popover editor focuses its first field
                      autoFocus={i === 0}
                      disabled={readOnly}
                      aria-label={`Quantity per ${rt.name} room`}
                      inputMode="decimal"
                      value={per[rt.id] ?? ''}
                      placeholder="0"
                      onChange={(e) => setPer((p) => ({ ...p, [rt.id]: e.target.value }))}
                      onFocus={(e) => e.target.select()}
                      className="num h-7 w-14 rounded-xs border border-line px-1.5 text-right focus:border-lacquer focus:outline-none"
                    />
                  </td>
                  <td className="num py-1 text-right text-ink-2">× {rt.count}</td>
                  <td className={cx('num py-1 text-right', q ? 'font-[560]' : 'text-ink-4')}>
                    {(q * rt.count).toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <label className="flex items-center justify-between gap-2">
          <span className="text-ink-2">Quantity</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the popover editor focuses its first field
            autoFocus
            disabled={readOnly}
            inputMode="decimal"
            value={fixed}
            onChange={(e) => setFixed(e.target.value)}
            onFocus={(e) => e.target.select()}
            className="num h-7 w-24 rounded-xs border border-line px-1.5 text-right focus:border-lacquer focus:outline-none"
          />
        </label>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-line-2 pt-2">
        <label className="flex items-center gap-2 text-ink-2">
          Attic stock
          <input
            disabled={readOnly}
            inputMode="decimal"
            value={attic}
            onChange={(e) => setAttic(e.target.value)}
            onFocus={(e) => e.target.select()}
            className="num h-7 w-14 rounded-xs border border-line px-1.5 text-right focus:border-lacquer focus:outline-none"
          />
          %
        </label>
        <span className="num text-ink-2">+{calc.attic}</span>
      </div>

      <div className="mt-2 flex items-baseline justify-between border-t border-ink/70 pt-2">
        <span className="font-[620]">Total</span>
        <span className="num text-[16px] font-[640]">
          {calc.quantity.toLocaleString()}{' '}
          <span className="text-[12px] font-[480] text-ink-3">{line.unit}</span>
        </span>
      </div>

      <div className="mt-3 rounded-sm bg-stone px-2.5 py-2">
        <label className="flex items-center gap-2 font-[560]">
          <input
            type="checkbox"
            className="accent-lacquer"
            disabled={readOnly}
            checked={handed}
            onChange={(e) => {
              setHanded(e.target.checked);
              if (e.target.checked && !left && !right) splitEven(calc.quantity);
            }}
          />
          Left / right handing
        </label>
        {handed && (
          <div className="mt-2 flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-ink-2">
              L
              <input
                disabled={readOnly}
                inputMode="numeric"
                value={left}
                onChange={(e) => {
                  setLeft(e.target.value);
                  setRight(String(Math.max(0, calc.quantity - numOr0(e.target.value))));
                }}
                className="num h-7 w-16 rounded-xs border border-line bg-paper px-1.5 text-right focus:border-lacquer focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5 text-ink-2">
              R
              <input
                disabled={readOnly}
                inputMode="numeric"
                value={right}
                onChange={(e) => setRight(e.target.value)}
                className="num h-7 w-16 rounded-xs border border-line bg-paper px-1.5 text-right focus:border-lacquer focus:outline-none"
              />
            </label>
            <button
              type="button"
              className="ml-auto text-[12px] font-[560] text-lacquer hover:underline"
              onClick={() => splitEven(calc.quantity)}
            >
              Split evenly
            </button>
          </div>
        )}
        {handingError && <p className="mt-1.5 text-[12px] text-crit">{handingError}</p>}
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {readOnly ? 'Close' : 'Cancel'}
        </Button>
        {!readOnly && (
          <Button size="sm" variant="primary" onClick={save} disabled={!!handingError}>
            Save quantity
          </Button>
        )}
      </div>
    </div>
  );
}
