import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './index';

/**
 * Hover/focus tooltip rendered in a portal so it is never clipped by scrolling tables. Use for short
 * explanatory text on icons and badges (the native title attribute is too slow and unstyled).
 */
export function Tooltip({
  content,
  children,
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const show = (el: HTMLElement) => setRect(el.getBoundingClientRect());
  const above = rect ? rect.top > 60 : true;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus only reveal supplementary text
    <span
      className={cx('inline-flex', className)}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setRect(null)}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={() => setRect(null)}
    >
      {children}
      {rect &&
        content &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[70] max-w-72 rounded-xs bg-ink px-2 py-1 text-[12px] leading-snug text-white shadow-[var(--shadow-pop)]"
            style={{
              left: Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150),
              top: above ? rect.top - 6 : rect.bottom + 6,
              transform: `translate(-50%, ${above ? '-100%' : '0'})`,
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
