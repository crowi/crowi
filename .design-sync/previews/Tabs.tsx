import { Tabs, TabsList, TabsTrigger, TabsContent } from '@crowi/web';

export const PageTabs = () => (
  <Tabs defaultValue="overview" style={{ width: 360 }}>
    <TabsList>
      <TabsTrigger value="overview">Overview</TabsTrigger>
      <TabsTrigger value="history">History</TabsTrigger>
      <TabsTrigger value="settings">Settings</TabsTrigger>
    </TabsList>
    <TabsContent value="overview">
      <p style={{ fontSize: 14 }}>Last edited 2 hours ago by Sotaro Karasawa. 14 pages link to this one.</p>
    </TabsContent>
    <TabsContent value="history">
      <p style={{ fontSize: 14 }}>12 revisions since this page was created.</p>
    </TabsContent>
    <TabsContent value="settings">
      <p style={{ fontSize: 14 }}>Visibility: Restricted. Only space members can view this page.</p>
    </TabsContent>
  </Tabs>
);

export const SpaceTabs = () => (
  <Tabs defaultValue="members" style={{ width: 360 }}>
    <TabsList>
      <TabsTrigger value="members">Members</TabsTrigger>
      <TabsTrigger value="permissions">Permissions</TabsTrigger>
    </TabsList>
    <TabsContent value="members">
      <p style={{ fontSize: 14 }}>8 members, 2 pending invitations.</p>
    </TabsContent>
    <TabsContent value="permissions">
      <p style={{ fontSize: 14 }}>Default page grant: Restricted to space members.</p>
    </TabsContent>
  </Tabs>
);
