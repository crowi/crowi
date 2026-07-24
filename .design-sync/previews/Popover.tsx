import { Popover, PopoverTrigger, PopoverContent, Avatar, AvatarFallback } from '@crowi/web';

const viewers = [
  { name: 'Sotaro Karasawa', username: 'sotarok', badge: '(you)' },
  { name: 'Aki Nomura', username: 'akinomura', badge: 'editing' },
  { name: 'Ren Ishikawa', username: 'ren-i', badge: null },
];

export const PageViewers = () => (
  <Popover defaultOpen>
    <PopoverTrigger className="inline-flex h-6 items-center rounded-full bg-muted px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70">
      +{viewers.length}
    </PopoverTrigger>
    <PopoverContent align="start" className="w-64 p-0">
      <div className="py-1">
        <p className="px-3 py-2 text-xs font-medium text-muted-foreground">Currently viewing</p>
        <ul>
          {viewers.map((viewer) => (
            <li key={viewer.username} className="flex items-center gap-2.5 px-3 py-1.5">
              <Avatar>
                <AvatarFallback>{viewer.name.slice(0, 1)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-sm">
                  <span className="truncate font-medium">{viewer.name}</span>
                  {viewer.badge && <span className="shrink-0 text-xs text-muted-foreground">{viewer.badge}</span>}
                </div>
                <div className="truncate text-xs text-muted-foreground">@{viewer.username}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </PopoverContent>
  </Popover>
);
