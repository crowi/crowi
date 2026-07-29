import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
  Button,
} from '@crowi/web';

export const Basic = () => (
  <Card style={{ width: 360 }}>
    <CardHeader>
      <CardTitle>Project settings</CardTitle>
      <CardDescription>Manage how your team collaborates on this wiki.</CardDescription>
    </CardHeader>
    <CardContent>
      <p style={{ fontSize: 14 }}>
        Changes apply to every member with edit access. You can update the default page grant and space
        visibility from here.
      </p>
    </CardContent>
    <CardFooter style={{ justifyContent: 'flex-end', gap: 8 }}>
      <Button variant="ghost">Cancel</Button>
      <Button>Save changes</Button>
    </CardFooter>
  </Card>
);

export const WithAction = () => (
  <Card style={{ width: 360 }}>
    <CardHeader>
      <CardTitle>Weekly digest</CardTitle>
      <CardDescription>Sent every Monday at 9:00 AM.</CardDescription>
      <CardAction>
        <Button variant="outline" size="sm">
          Edit
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent>
      <p style={{ fontSize: 14 }}>12,480 pages indexed across 34 spaces.</p>
    </CardContent>
  </Card>
);

export const Simple = () => (
  <Card style={{ width: 320 }}>
    <CardContent>
      <p style={{ fontSize: 14 }}>A plain card with only content — useful as a surface container.</p>
    </CardContent>
  </Card>
);
