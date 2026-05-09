'use client';

import { useState } from 'react';
import { Copy, Eye, EyeOff, RefreshCw, Check, Key } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogClose } from '@/components/ui/dialog';
import { useApiToken, useResetApiToken } from '@/lib/use-profile';
import { m } from '@paraglide/messages.js';

export function ApiTokenSection() {
  const [isTokenVisible, setIsTokenVisible] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data: tokenData, isLoading, error: fetchError } = useApiToken();
  const resetApiToken = useResetApiToken();

  const apiToken = tokenData?.apiToken || '';

  const maskedToken = apiToken ? `${apiToken.substring(0, 8)}${'*'.repeat(Math.max(0, apiToken.length - 8))}` : '';

  const handleCopyToken = async () => {
    if (!apiToken) return;

    try {
      await navigator.clipboard.writeText(apiToken);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      setErrorMessage(m['me.api_token.copy_failed']());
    }
  };

  const handleResetToken = async () => {
    setSuccessMessage(null);
    setErrorMessage(null);

    try {
      await resetApiToken.mutateAsync();
      setSuccessMessage(m['me.api_token.regenerate_success']());
      setIsDialogOpen(false);
      setIsTokenVisible(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : m['me.api_token.regenerate_failed']());
      setIsDialogOpen(false);
    }
  };

  const toggleTokenVisibility = () => {
    setIsTokenVisible((prev) => !prev);
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
        <AlertDescription>{m['me.api_token.fetch_failed']()}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {successMessage && (
        <Alert>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="apiToken" className="flex items-center gap-2">
            <Key className="size-4" />
            {m['me.api_token.label']()}
          </Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input id="apiToken" type="text" value={isTokenVisible ? apiToken : maskedToken} readOnly className="pr-10 font-mono text-sm bg-muted" />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute right-1 top-1/2 -translate-y-1/2"
                onClick={toggleTokenVisibility}
                title={isTokenVisible ? m['me.api_token.hide']() : m['me.api_token.show']()}
              >
                {isTokenVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            </div>
            <Button type="button" variant="outline" size="icon" onClick={handleCopyToken} disabled={!apiToken} title={m['me.api_token.copy']()}>
              {isCopied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{m['me.api_token.helper']()}</p>
        </div>

        <div className="pt-4 border-t">
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button type="button" variant="outline" disabled={resetApiToken.isPending}>
                <RefreshCw className={resetApiToken.isPending ? 'animate-spin' : ''} />
                {resetApiToken.isPending ? m['me.api_token.regenerate_pending']() : m['me.api_token.regenerate']()}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{m['me.api_token.regenerate_dialog_title']()}</DialogTitle>
                <DialogDescription className="space-y-2 pt-2">
                  <span className="block">{m['me.api_token.regenerate_dialog_warn1']()}</span>
                  <span className="block text-destructive font-medium">{m['me.api_token.regenerate_dialog_warn2']()}</span>
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:gap-0">
                <DialogClose asChild>
                  <Button variant="outline">{m['me.api_token.regenerate_dialog_cancel']()}</Button>
                </DialogClose>
                <Button variant="destructive" onClick={handleResetToken} disabled={resetApiToken.isPending}>
                  {resetApiToken.isPending ? m['me.api_token.regenerate_pending']() : m['me.api_token.regenerate_dialog_confirm']()}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
