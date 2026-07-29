import { Avatar, AvatarImage, AvatarFallback } from '@crowi/web';

// crowi renders member initials on the brand teal (--primary); a couple of
// accent colors distinguish members in a group. AvatarImage falls back to the
// initials when the src can't load (as in this sandbox), so the fallback is
// always the visible content here.
const tint = (bg: string) => ({ backgroundColor: bg, color: 'white' });

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Avatar style={{ width: 24, height: 24 }}>
      <AvatarFallback style={{ ...tint('var(--primary)'), fontSize: 10 }}>SK</AvatarFallback>
    </Avatar>
    <Avatar>
      <AvatarFallback style={tint('var(--primary)')}>SK</AvatarFallback>
    </Avatar>
    <Avatar style={{ width: 48, height: 48 }}>
      <AvatarFallback style={{ ...tint('var(--primary)'), fontSize: 18 }}>SK</AvatarFallback>
    </Avatar>
  </div>
);

export const WithImage = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Avatar>
      <AvatarImage src="https://example.com/avatar.png" alt="Sotaro Karasawa" />
      <AvatarFallback style={tint('var(--primary)')}>SK</AvatarFallback>
    </Avatar>
    <span style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>
      AvatarImage with an AvatarFallback — falls back to initials when the image can't load.
    </span>
  </div>
);

export const Group = () => {
  const members: [string, string][] = [
    ['SK', 'var(--primary)'],
    ['AN', '#6b7280'],
    ['KS', '#b45309'],
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {members.map(([label, bg], i) => (
        <Avatar
          key={label}
          style={{ marginLeft: i ? -10 : 0, boxShadow: '0 0 0 2px var(--background)' }}
        >
          <AvatarFallback style={tint(bg)}>{label}</AvatarFallback>
        </Avatar>
      ))}
      <Avatar style={{ marginLeft: -10, boxShadow: '0 0 0 2px var(--background)' }}>
        <AvatarFallback style={{ fontSize: 12 }}>+5</AvatarFallback>
      </Avatar>
    </div>
  );
};
