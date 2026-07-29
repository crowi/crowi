import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
} from '@crowi/web';

export const Default = () => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
    <Select defaultValue="public">
      <SelectTrigger style={{ width: 200 }}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="public">Public</SelectItem>
        <SelectItem value="restricted">Restricted</SelectItem>
        <SelectItem value="private">Private</SelectItem>
      </SelectContent>
    </Select>
    <Select>
      <SelectTrigger style={{ width: 200 }}>
        <SelectValue placeholder="Select visibility" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="public">Public</SelectItem>
        <SelectItem value="restricted">Restricted</SelectItem>
        <SelectItem value="private">Private</SelectItem>
      </SelectContent>
    </Select>
  </div>
);

export const Open = () => (
  <Select defaultOpen defaultValue="restricted">
    <SelectTrigger style={{ width: 220 }}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent position="popper" sideOffset={4}>
      <SelectGroup>
        <SelectLabel>Visibility</SelectLabel>
        <SelectItem value="public">Public</SelectItem>
        <SelectItem value="restricted">Restricted</SelectItem>
        <SelectItem value="private">Private</SelectItem>
      </SelectGroup>
    </SelectContent>
  </Select>
);
