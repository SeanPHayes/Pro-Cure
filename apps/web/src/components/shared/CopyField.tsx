import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { cx } from '@/components/ui';

/** Read-only value with a copy button (invite links, forwarding addresses). */
export function CopyField({ value, label, className }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied`);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Copy failed. Select the text and copy it manually.');
    }
  };
  return (
    <div className={cx('flex min-w-0 items-stretch rounded-sm border border-line bg-stone', className)}>
      <input
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="num h-9 min-w-0 flex-1 bg-transparent px-2.5 text-[13px] text-ink focus:outline-none"
      />
      <button
        type="button"
        onClick={copy}
        className="flex items-center gap-1.5 border-l border-line px-2.5 text-[13px] font-[560] text-ink-2 hover:bg-stone-2 hover:text-ink"
      >
        {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
