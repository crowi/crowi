import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
  Button,
} from '@crowi/web';

export const SuspendUser = () => (
  <AlertDialog defaultOpen>
    <AlertDialogTrigger asChild>
      <Button variant="destructive">Suspend user</Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Suspend this user?</AlertDialogTitle>
        <AlertDialogDescription>
          hoshino_dev will be signed out of every session and won't be able to sign in again until an admin reactivates the account.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90">Suspend</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
