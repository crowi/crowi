import type { LucideIcon } from 'lucide-react';

interface KindTagProps {
  icon: LucideIcon;
  label: string;
}

/** Small pill (glyph + label) naming what kind of page this is — a portal, an HTML artifact. */
export function KindTag({ icon: Icon, label }: KindTagProps) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-secondary px-2 py-0.5 text-[0.68rem] font-bold uppercase tracking-wider text-primary">
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}
