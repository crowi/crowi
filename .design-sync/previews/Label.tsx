import { Input, Label, Switch } from '@crowi/web';

export const Basic = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 280 }}>
    <Label htmlFor="member-name">Member name</Label>
    <Input id="member-name" defaultValue="Sotaro Karasawa" />
  </div>
);

export const WithSwitch = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <Switch id="notify-mentions" checked onCheckedChange={() => {}} />
    <Label htmlFor="notify-mentions">Notify me when mentioned</Label>
  </div>
);

export const Required = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 280 }}>
    <Label htmlFor="required-space-name">
      Space name <span style={{ color: '#dc2626' }}>*</span>
    </Label>
    <Input id="required-space-name" placeholder="e.g. Design Team" />
  </div>
);

export const Disabled = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 280 }}>
    <Input id="archived-space" className="peer" defaultValue="Archived Space" disabled />
    <Label htmlFor="archived-space">This space is archived and read-only</Label>
  </div>
);
