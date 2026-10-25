import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Floating panel anchored to an element (e.g. a table cell). Rendered in a portal with fixed
 * positioning, flipped above the anchor when there is no room below, and kept inside the viewport.
 * Closes on outside click and Escape.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  width = 340,
  label,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  label?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const h = panel.current?.offsetHeight ?? 300;
      const w = Math.min(width, window.innerWidth - 16);
      let left = r.right - w;
      if (left < 8) left = Math.min(r.left, window.innerWidth - w - 8);
      left = Math.max(8, left);
      let top = r.bottom + 4;
      if (top + h > window.innerHeight - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
      top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, width]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, anchor, onClose]);

  if (!open || !anchor) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      className="fixed z-[60] rounded-md border border-line bg-paper shadow-[var(--shadow-pop)]"
      style={{
        width: Math.min(width, window.innerWidth - 16),
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
