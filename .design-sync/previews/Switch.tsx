import * as React from 'react';
import { Switch, Label } from '@crowi/web';

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{children}</div>
);

export const States = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Row>
      <Switch id="switch-on" checked onCheckedChange={() => {}} />
      <Label htmlFor="switch-on">On</Label>
    </Row>
    <Row>
      <Switch id="switch-off" checked={false} onCheckedChange={() => {}} />
      <Label htmlFor="switch-off">Off</Label>
    </Row>
  </div>
);

export const MemberSettings = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 320 }}>
    <Row>
      <Switch id="allow-guest-comments" checked onCheckedChange={() => {}} />
      <Label htmlFor="allow-guest-comments">Allow guest comments on public pages</Label>
    </Row>
    <Row>
      <Switch id="restrict-editing" checked={false} onCheckedChange={() => {}} />
      <Label htmlFor="restrict-editing">Restrict editing to space owners</Label>
    </Row>
  </div>
);

export const DisabledControl = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Row>
      <Switch id="locked-on" checked onCheckedChange={() => {}} disabled />
      <Label htmlFor="locked-on">Two-factor auth (enforced by admin)</Label>
    </Row>
    <Row>
      <Switch id="locked-off" checked={false} onCheckedChange={() => {}} disabled />
      <Label htmlFor="locked-off">External sharing (disabled by policy)</Label>
    </Row>
  </div>
);
