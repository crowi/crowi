'use client';

import { useState } from 'react';
import { Check, Copy, Key, Plus, Trash2 } from 'lucide-react';
import { ISSUABLE_SCOPES } from '@crowi/api-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAccessTokens, useCreateAccessToken, useDeleteAccessToken } from '@/lib/use-access-tokens';
import { m } from '@paraglide/messages.js';
import { getLocale } from '@paraglide/runtime.js';

/** Expiry presets surfaced in the create dialog (days; `null` = never). */
const EXPIRY_PRESETS: { value: string; days: number | null }[] = [
  { value: '30', days: 30 },
  { value: '90', days: 90 },
  { value: '365', days: 365 },
  { value: 'never', days: null },
];

function expiresAtFromPreset(value: string): string | null {
  const preset = EXPIRY_PRESETS.find((p) => p.value === value);
  if (!preset || preset.days === null) return null;
  return new Date(Date.now() + preset.days * 24 * 60 * 60 * 1000).toISOString();
}

export function AccessTokensSection() {
  const dateLocale = getLocale() === 'ja' ? 'ja-JP' : 'en-US';
  const { data, isLoading, error: fetchError } = useAccessTokens();
  const createToken = useCreateAccessToken();
  const deleteToken = useDeleteAccessToken();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [expiryPreset, setExpiryPreset] = useState<string>('90');
  const [formError, setFormError] = useState<string | null>(null);

  // The one-time plaintext, shown only immediately after creation.
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);

  const resetForm = () => {
    setName('');
    setSelectedScopes([]);
    setExpiryPreset('90');
    setFormError(null);
  };

  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  };

  const handleCreate = async () => {
    setFormError(null);
    if (!name.trim()) {
      setFormError(m['me.access_tokens.error_name_required']());
      return;
    }
    if (selectedScopes.length === 0) {
      setFormError(m['me.access_tokens.error_scope_required']());
      return;
    }
    try {
      const result = await createToken.mutateAsync({
        name: name.trim(),
        scopes: selectedScopes,
        expiresAt: expiresAtFromPreset(expiryPreset),
      });
      setIssuedToken(result.token);
      setIsDialogOpen(false);
      resetForm();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : m['me.access_tokens.error_create']());
    }
  };

  const handleCopy = async () => {
    if (!issuedToken) return;
    try {
      await navigator.clipboard.writeText(issuedToken);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // clipboard denied — the value is still visible for manual copy.
    }
  };

  const handleDelete = async (id: string) => {
    await deleteToken.mutateAsync(id);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (fetchError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{m['me.access_tokens.fetch_failed']()}</AlertDescription>
      </Alert>
    );
  }

  const tokens = data?.accessTokens ?? [];

  return (
    <div className="space-y-6">
      {issuedToken && (
        <Alert>
          <AlertDescription className="space-y-2">
            <p className="font-medium">{m['me.access_tokens.created_once']()}</p>
            <div className="flex gap-2">
              <Input readOnly value={issuedToken} className="font-mono text-sm bg-muted" />
              <Button type="button" variant="outline" size="icon" onClick={handleCopy} title={m['me.access_tokens.copy']()}>
                {isCopied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setIssuedToken(null)}>
              {m['me.access_tokens.dismiss']()}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end">
        <Dialog
          open={isDialogOpen}
          onOpenChange={(open) => {
            setIsDialogOpen(open);
            if (!open) resetForm();
          }}
        >
          <DialogTrigger asChild>
            <Button type="button">
              <Plus className="size-4" />
              {m['me.access_tokens.create']()}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{m['me.access_tokens.create_dialog_title']()}</DialogTitle>
              <DialogDescription>{m['me.access_tokens.create_dialog_lead']()}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {formError && (
                <Alert variant="destructive">
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="pat-name">{m['me.access_tokens.name_label']()}</Label>
                <Input id="pat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={m['me.access_tokens.name_placeholder']()} />
              </div>

              <div className="space-y-2">
                <Label>{m['me.access_tokens.scopes_label']()}</Label>
                <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
                  {ISSUABLE_SCOPES.map((scope) => (
                    <label key={scope} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 rounded border-input"
                        checked={selectedScopes.includes(scope)}
                        onChange={() => toggleScope(scope)}
                      />
                      <span className="font-mono">{scope}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="pat-expiry">{m['me.access_tokens.expiry_label']()}</Label>
                <Select value={expiryPreset} onValueChange={setExpiryPreset}>
                  <SelectTrigger id="pat-expiry">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30">{m['me.access_tokens.expiry_30']()}</SelectItem>
                    <SelectItem value="90">{m['me.access_tokens.expiry_90']()}</SelectItem>
                    <SelectItem value="365">{m['me.access_tokens.expiry_365']()}</SelectItem>
                    <SelectItem value="never">{m['me.access_tokens.expiry_never']()}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" onClick={handleCreate} disabled={createToken.isPending}>
                {createToken.isPending ? m['me.access_tokens.creating']() : m['me.access_tokens.create_confirm']()}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">{m['me.access_tokens.empty']()}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {tokens.map((token) => (
            <li key={token.id} className="flex items-start justify-between gap-4 p-4">
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Key className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium truncate">{token.name}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {token.scopes.map((scope) => (
                    <span key={scope} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {scope}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {token.expiresAt
                    ? m['me.access_tokens.expires_at']({ date: new Date(token.expiresAt).toLocaleDateString(dateLocale) })
                    : m['me.access_tokens.no_expiry']()}
                  {' · '}
                  {token.lastUsedAt
                    ? m['me.access_tokens.last_used']({ date: new Date(token.lastUsedAt).toLocaleString(dateLocale) })
                    : m['me.access_tokens.never_used']()}
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="outline" size="icon" title={m['me.access_tokens.revoke']()}>
                    <Trash2 className="size-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{m['me.access_tokens.revoke_dialog_title']()}</AlertDialogTitle>
                    <AlertDialogDescription>{m['me.access_tokens.revoke_dialog_warn']({ name: token.name })}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{m['me.access_tokens.revoke_dialog_cancel']()}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleDelete(token.id)}>{m['me.access_tokens.revoke_dialog_confirm']()}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
