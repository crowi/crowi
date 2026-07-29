import * as React from 'react';
import { Textarea, Label } from '@crowi/web';

const Field = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 320 }}>{children}</div>
);

export const Basic = () => (
  <Field>
    <Label htmlFor="page-description">Page description</Label>
    <Textarea
      id="page-description"
      defaultValue={
        'A living reference for onboarding new engineers to the platform team.\nUpdated whenever the deploy process changes.'
      }
      rows={4}
    />
  </Field>
);

export const Placeholder = () => (
  <Field>
    <Label htmlFor="comment-body">Add a comment</Label>
    <Textarea id="comment-body" placeholder="Share feedback on this page..." rows={3} />
  </Field>
);

export const Disabled = () => (
  <Field>
    <Label htmlFor="archived-note">Archive note</Label>
    <Textarea
      id="archived-note"
      defaultValue="This space was archived on 2026-06-01 and is now read-only."
      disabled
      rows={3}
    />
  </Field>
);
