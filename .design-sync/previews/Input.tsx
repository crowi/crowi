import * as React from 'react';
import { Input, Label } from '@crowi/web';

const Field = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 280 }}>{children}</div>
);

export const Basic = () => (
  <Field>
    <Label htmlFor="page-title">Page title</Label>
    <Input id="page-title" defaultValue="Getting started with Crowi" />
  </Field>
);

export const Placeholder = () => (
  <Field>
    <Label htmlFor="search-pages">Search</Label>
    <Input id="search-pages" placeholder="Search pages, spaces, members..." />
  </Field>
);

export const Disabled = () => (
  <Field>
    <Label htmlFor="page-slug">Page path</Label>
    <Input id="page-slug" defaultValue="/dev-team/onboarding" disabled />
  </Field>
);

export const Types = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Field>
      <Label htmlFor="invite-email">Invite by email</Label>
      <Input id="invite-email" type="email" placeholder="member@example.com" />
    </Field>
    <Field>
      <Label htmlFor="space-name">Space name</Label>
      <Input id="space-name" type="text" defaultValue="Design Team" />
    </Field>
  </div>
);
