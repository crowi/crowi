import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Button } from '@crowi/web';

export const DeletePage = () => (
  <Dialog defaultOpen>
    <DialogTrigger asChild>
      <Button variant="outline">Delete page</Button>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Delete this page?</DialogTitle>
        <DialogDescription>"/dev/onboarding-guide" will be moved to the trash. You can restore it from there later.</DialogDescription>
      </DialogHeader>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
        <input id="dialog-preview-completely" type="checkbox" className="h-4 w-4 rounded border-input" />
        <label htmlFor="dialog-preview-completely" style={{ fontSize: 14 }}>
          Delete completely (skip trash, cannot be restored)
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline">Cancel</Button>
        <Button variant="destructive">Delete</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
