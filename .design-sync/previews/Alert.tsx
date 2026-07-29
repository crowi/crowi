import { Alert, AlertTitle, AlertDescription } from '@crowi/web';

const TriangleAlertIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
);

const InfoIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </svg>
);

export const Default = () => (
  <Alert style={{ width: 360 }}>
    <AlertTitle>Draft not yet published</AlertTitle>
    <AlertDescription>Only you can see this page until it's published to the space.</AlertDescription>
  </Alert>
);

export const Destructive = () => (
  <Alert variant="destructive" style={{ width: 360 }}>
    <TriangleAlertIcon />
    <AlertTitle>This page is in the trash</AlertTitle>
    <AlertDescription>
      It was moved to the trash 3 days ago and will be permanently deleted in 27 days unless restored.
    </AlertDescription>
  </Alert>
);

export const WithIcon = () => (
  <Alert style={{ width: 360 }}>
    <InfoIcon />
    <AlertTitle>Autosaved</AlertTitle>
    <AlertDescription>Your changes were saved automatically 2 minutes ago.</AlertDescription>
  </Alert>
);
