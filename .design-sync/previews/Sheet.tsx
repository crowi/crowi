import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, Avatar, AvatarFallback } from '@crowi/web';

export const Default = () => (
  <Sheet defaultOpen>
    <SheetContent>
      <SheetHeader>
        <SheetTitle>Page settings</SheetTitle>
        <SheetDescription>Configure visibility and notifications for this page.</SheetDescription>
      </SheetHeader>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={{ fontSize: 14 }}>Visibility: Restricted — only space members can view.</p>
        <p style={{ fontSize: 14 }}>Watchers are notified whenever this page is edited.</p>
      </div>
    </SheetContent>
  </Sheet>
);

export const Viewers = () => (
  <Sheet defaultOpen>
    <SheetContent side="bottom">
      <SheetHeader>
        <SheetTitle>Currently viewing</SheetTitle>
        <SheetDescription>3 people are looking at this page right now.</SheetDescription>
      </SheetHeader>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Avatar>
            <AvatarFallback>SK</AvatarFallback>
          </Avatar>
          <span style={{ fontSize: 14 }}>Sotaro Karasawa</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Avatar>
            <AvatarFallback>AN</AvatarFallback>
          </Avatar>
          <span style={{ fontSize: 14 }}>Aya Nakamura</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Avatar>
            <AvatarFallback>KS</AvatarFallback>
          </Avatar>
          <span style={{ fontSize: 14 }}>Kenji Sato</span>
        </div>
      </div>
    </SheetContent>
  </Sheet>
);
