'use client';

import { CircleAlert, Info, Lightbulb, type LucideIcon, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { ComponentPropsWithoutRef } from 'react';

/**
 * The `aside` adapter `render-mdast.ts` composes into every caller's
 * component map.
 *
 * The api's `crowiAlert` handler emits a plain `<aside>` carrying
 * `data-crowi-alert-variant`; this component turns the recognised five
 * into the callout DOM. The presentation is decided ENTIRELY here from
 * a closed variant map — the incoming node contributes no class, no
 * label, no icon and no markup, only which of five fixed presentations
 * to use, so an author who hand-writes `<aside
 * data-crowi-alert-variant="note">` in their page body gets a
 * (correctly styled) note box and nothing else. Every other `<aside>`,
 * including one with an unrecognised variant, is passed through
 * untouched.
 *
 * Title text and icon are always drawn together with the accent colour
 * so the five variants stay distinguishable without relying on colour
 * (WCAG 1.4.1). No `role="alert"`: this is static document content, not
 * a live region — announcing it would interrupt whatever the user is
 * doing when the page loads.
 */

interface AlertPresentation {
  label: string;
  Icon: LucideIcon;
}

const ALERT_PRESENTATIONS = {
  note: { label: 'Note', Icon: Info },
  tip: { label: 'Tip', Icon: Lightbulb },
  important: { label: 'Important', Icon: CircleAlert },
  warning: { label: 'Warning', Icon: TriangleAlert },
  caution: { label: 'Caution', Icon: OctagonAlert },
} as const satisfies Record<string, AlertPresentation>;

export type CrowiAlertVariant = keyof typeof ALERT_PRESENTATIONS;

export function isCrowiAlertVariant(value: unknown): value is CrowiAlertVariant {
  return typeof value === 'string' && Object.hasOwn(ALERT_PRESENTATIONS, value);
}

type CrowiAlertProps = ComponentPropsWithoutRef<'aside'> & {
  'data-crowi-alert-variant'?: string;
  'data-source-line'?: string | number;
};

export function CrowiAlert(props: CrowiAlertProps) {
  const variant = props['data-crowi-alert-variant'];
  if (!isCrowiAlertVariant(variant)) return <aside {...props} />;

  const { label, Icon } = ALERT_PRESENTATIONS[variant];
  return (
    // Only the editor preview's scroll-sync anchor is carried over from
    // the node; everything else is fixed so no page body can influence
    // this element's attributes.
    <aside data-source-line={props['data-source-line']} data-crowi-alert-variant={variant} className={`crowi-alert crowi-alert-${variant}`} aria-label={label}>
      <p className="crowi-alert-title">
        <Icon className="crowi-alert-icon" aria-hidden="true" />
        <span>{label}</span>
      </p>
      <div className="crowi-alert-body">{props.children}</div>
    </aside>
  );
}
