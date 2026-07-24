import * as React from 'react';
import { Button } from '@crowi/web';

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>
);

const Check = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const Plus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M12 5v14" />
  </svg>
);

export const Primary = () => <Button>Save changes</Button>;

export const Variants = () => (
  <Row>
    <Button>Default</Button>
    <Button variant="secondary">Secondary</Button>
    <Button variant="outline">Outline</Button>
    <Button variant="ghost">Ghost</Button>
    <Button variant="destructive">Delete</Button>
    <Button variant="link">Link</Button>
  </Row>
);

export const Sizes = () => (
  <Row>
    <Button size="sm">Small</Button>
    <Button size="default">Default</Button>
    <Button size="lg">Large</Button>
  </Row>
);

export const WithIcon = () => (
  <Row>
    <Button>
      <Check />
      Confirm
    </Button>
    <Button variant="outline" size="icon" aria-label="Add">
      <Plus />
    </Button>
  </Row>
);

export const Disabled = () => (
  <Row>
    <Button disabled>Disabled</Button>
    <Button variant="outline" disabled>
      Disabled
    </Button>
  </Row>
);
