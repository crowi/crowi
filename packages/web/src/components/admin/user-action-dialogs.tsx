'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Copy, Loader2 } from 'lucide-react';
import type { InvitedUserResult, UserPublic } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EmailConflictError, useEditAdminUser, useInviteAdminUsers, useUpdateAdminUserEmail } from '@/lib/use-admin-users';
import { cn } from '@/lib/utils';
import { m } from '@paraglide/messages.js';

/**
 * Permissive email check used purely to flag obvious typos before submitting.
 * Authoritative validation lives in the Zod contract on the server.
 */
const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function userLabel(user: UserPublic): string {
  return user.name || user.username || user.email;
}

interface InviteUsersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InviteUsersDialog({ open, onOpenChange }: InviteUsersDialogProps) {
  const invite = useInviteAdminUsers();
  const [text, setText] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [results, setResults] = useState<InvitedUserResult[] | null>(null);

  useEffect(() => {
    if (open) {
      setText('');
      setSendEmail(false);
      setLocalError(null);
      setResults(null);
      invite.reset();
    }
    // invite.reset is a fresh closure each render; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const grouped = useMemo(() => {
    if (!results) return null;
    const created: InvitedUserResult[] = [];
    const exists: InvitedUserResult[] = [];
    const failed: InvitedUserResult[] = [];
    for (const r of results) {
      if (r.status === 'created') created.push(r);
      else if (r.status === 'exists') exists.push(r);
      else failed.push(r);
    }
    return { created, exists, failed };
  }, [results]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLocalError(null);

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      setLocalError(m['admin.users.action.invite_no_emails']());
      return;
    }
    const invalid = lines.filter((line) => !SIMPLE_EMAIL_RE.test(line));
    if (invalid.length > 0) {
      setLocalError(m['admin.users.action.invite_invalid_emails']({ emails: invalid.slice(0, 3).join(', ') }));
      return;
    }

    try {
      const response = await invite.mutateAsync({ emailList: lines, sendEmail });
      setResults(response.results);
    } catch {
      // surfaced via invite.error below
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m['admin.users.action.invite_dialog_title']()}</DialogTitle>
          <DialogDescription>{m['admin.users.action.invite_dialog_description']()}</DialogDescription>
        </DialogHeader>

        {grouped ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">{m['admin.users.action.invite_results_heading']()}</p>
            <div className="space-y-2 text-sm">
              <InviteResultGroup
                items={grouped.created}
                summary={m['admin.users.action.invite_results_created']({ count: grouped.created.length })}
                summaryClassName="text-emerald-700 dark:text-emerald-300"
                openByDefault
              />
              <InviteResultGroup
                items={grouped.exists}
                summary={m['admin.users.action.invite_results_exists']({ count: grouped.exists.length })}
                summaryClassName="text-amber-700 dark:text-amber-300"
              />
              <InviteResultGroup
                items={grouped.failed}
                summary={m['admin.users.action.invite_results_failed']({ count: grouped.failed.length })}
                summaryClassName="text-destructive"
              />
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {m['admin.users.action.invite_results_close']()}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="invite-emails">{m['admin.users.action.invite_emails_label']()}</Label>
              <Textarea
                id="invite-emails"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={m['admin.users.action.invite_emails_placeholder']()}
                rows={6}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} className="size-4 rounded border-input" />
              {m['admin.users.action.invite_send_email_label']()}
            </label>

            {localError && (
              <p className="text-xs text-destructive" role="alert">
                {localError}
              </p>
            )}
            {invite.isError && invite.error instanceof Error && (
              <p className="text-xs text-destructive" role="alert">
                {invite.error.message}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {m['admin.users.action.confirm_cancel']()}
              </Button>
              <Button type="submit" disabled={invite.isPending}>
                {invite.isPending ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    {m['admin.users.action.invite_submit_pending']()}
                  </>
                ) : (
                  m['admin.users.action.invite_submit']()
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InviteResultGroup({
  items,
  summary,
  summaryClassName,
  openByDefault = false,
}: {
  items: InvitedUserResult[];
  summary: string;
  summaryClassName: string;
  openByDefault?: boolean;
}) {
  return (
    <details {...(openByDefault ? { open: true } : {})} className="rounded-md border p-3">
      <summary className={cn('cursor-pointer', summaryClassName)}>{summary}</summary>
      <ul className="mt-2 space-y-0.5 pl-4 text-muted-foreground">
        {items.map((r) => (
          <li key={r.email}>{r.email}</li>
        ))}
      </ul>
    </details>
  );
}

interface EditUserDialogProps {
  user: UserPublic | null;
  onOpenChange: (open: boolean) => void;
}

export function EditUserDialog({ user, onOpenChange }: EditUserDialogProps) {
  const edit = useEditAdminUser();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [emailFieldError, setEmailFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setName(user.name ?? '');
      setEmail(user.email ?? '');
      setEmailFieldError(null);
      edit.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) return;
    setEmailFieldError(null);
    try {
      await edit.mutateAsync({ id: user._id, body: { name, email } });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof EmailConflictError) {
        setEmailFieldError(err.message);
      }
    }
  };

  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m['admin.users.action.edit_dialog_title']()}</DialogTitle>
          <DialogDescription>{m['admin.users.action.edit_dialog_description']()}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="edit-user-name">{m['admin.users.action.edit_field_name']()}</Label>
            <Input id="edit-user-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-user-email">{m['admin.users.action.edit_field_email']()}</Label>
            <Input
              id="edit-user-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(emailFieldError)}
              required
            />
            {emailFieldError && (
              <p className="text-xs text-destructive" role="alert">
                {emailFieldError}
              </p>
            )}
          </div>
          {edit.isError && !(edit.error instanceof EmailConflictError) && edit.error instanceof Error && (
            <p className="text-xs text-destructive" role="alert">
              {edit.error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {m['admin.users.action.confirm_cancel']()}
            </Button>
            <Button type="submit" disabled={edit.isPending}>
              {edit.isPending ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  {m['admin.common.submit_pending']()}
                </>
              ) : (
                m['admin.users.action.edit_submit']()
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface UpdateEmailDialogProps {
  user: UserPublic | null;
  onOpenChange: (open: boolean) => void;
}

export function UpdateEmailDialog({ user, onOpenChange }: UpdateEmailDialogProps) {
  const update = useUpdateAdminUserEmail();
  const [email, setEmail] = useState('');
  const [emailFieldError, setEmailFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setEmail(user.email ?? '');
      setEmailFieldError(null);
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) return;
    setEmailFieldError(null);
    try {
      await update.mutateAsync({ id: user._id, body: { email } });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof EmailConflictError) {
        setEmailFieldError(err.message);
      }
    }
  };

  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m['admin.users.action.update_email_dialog_title']()}</DialogTitle>
          <DialogDescription>{m['admin.users.action.update_email_dialog_description']()}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="update-email-input">{m['admin.users.action.edit_field_email']()}</Label>
            <Input
              id="update-email-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(emailFieldError)}
              required
            />
            {emailFieldError && (
              <p className="text-xs text-destructive" role="alert">
                {emailFieldError}
              </p>
            )}
          </div>
          {update.isError && !(update.error instanceof EmailConflictError) && update.error instanceof Error && (
            <p className="text-xs text-destructive" role="alert">
              {update.error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {m['admin.users.action.confirm_cancel']()}
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  {m['admin.common.submit_pending']()}
                </>
              ) : (
                m['admin.users.action.update_email_submit']()
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface ResetPasswordResultDialogProps {
  newPassword: string | null;
  pending: boolean;
  errorMessage: string | null;
  onOpenChange: (open: boolean) => void;
}

export function ResetPasswordResultDialog({ newPassword, pending, errorMessage, onOpenChange }: ResetPasswordResultDialogProps) {
  const open = pending || newPassword !== null || errorMessage !== null;
  // Derive "copied" by remembering which password we last wrote to the
  // clipboard. Using a useEffect-based reset would require chasing the
  // password identity through deps; this reads cleaner and naturally re-arms
  // on a new password.
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const copied = copiedFor !== null && copiedFor === newPassword;

  const handleCopy = async () => {
    if (!newPassword) return;
    try {
      await navigator.clipboard.writeText(newPassword);
      setCopiedFor(newPassword);
    } catch {
      // Clipboard unavailable (insecure context / denied); the input stays
      // selectable so the operator can copy manually.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m['admin.users.action.reset_password_result_title']()}</DialogTitle>
          <DialogDescription>{m['admin.users.action.reset_password_result_description']()}</DialogDescription>
        </DialogHeader>

        {pending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {m['admin.users.action.reset_password_pending']()}
          </div>
        ) : errorMessage ? (
          <p className="text-sm text-destructive" role="alert">
            {errorMessage}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="reset-password-result">{m['admin.users.action.reset_password_result_label']()}</Label>
              <div className="flex gap-2">
                <Input id="reset-password-result" readOnly value={newPassword ?? ''} className="font-mono" />
                <Button type="button" variant="outline" onClick={handleCopy}>
                  {copied ? (
                    <>
                      <CheckCircle2 className="mr-1 h-4 w-4 text-emerald-600" />
                      {m['admin.users.action.reset_password_copied']()}
                    </>
                  ) : (
                    <>
                      <Copy className="mr-1 h-4 w-4" />
                      {m['admin.users.action.reset_password_copy']()}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} disabled={pending}>
            {m['admin.users.action.reset_password_close']()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ConfirmActionDialogProps {
  open: boolean;
  title: string;
  description: string;
  pending: boolean;
  destructive?: boolean;
  errorMessage?: string | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

export function ConfirmActionDialog({ open, title, description, pending, destructive, errorMessage, onConfirm, onOpenChange }: ConfirmActionDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {errorMessage && (
          <p className="text-xs text-destructive" role="alert">
            {errorMessage}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{m['admin.users.action.confirm_cancel']()}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            className={cn(destructive && 'bg-destructive text-white hover:bg-destructive/90')}
            onClick={(event) => {
              // Don't auto-close — the parent closes after the mutation
              // resolves so we can keep showing pending / error states.
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                {m['admin.users.action.confirm_pending']()}
              </>
            ) : (
              m['admin.users.action.confirm_confirm']()
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
