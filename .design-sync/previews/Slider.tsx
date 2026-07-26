import * as React from 'react';
import { Slider, Label } from '@crowi/web';

const Field = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 260 }}>{children}</div>
);

export const Basic = () => (
  <Field>
    <Label htmlFor="relevance-threshold">Search relevance threshold</Label>
    <Slider id="relevance-threshold" defaultValue={[40]} max={100} step={1} />
  </Field>
);

export const Range = () => (
  <Field>
    <Label htmlFor="retention-window">Archive retention window (days)</Label>
    <Slider id="retention-window" defaultValue={[20, 80]} max={100} step={5} />
  </Field>
);

export const Disabled = () => (
  <Field>
    <Label htmlFor="storage-plan">Storage quota (upgrade to adjust)</Label>
    <Slider id="storage-plan" defaultValue={[75]} max={100} disabled />
  </Field>
);

export const Stepped = () => (
  <Field>
    <Label htmlFor="autosave-interval">Auto-save interval (minutes)</Label>
    <Slider id="autosave-interval" defaultValue={[15]} min={5} max={60} step={5} />
  </Field>
);
