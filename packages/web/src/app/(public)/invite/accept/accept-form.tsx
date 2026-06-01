'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AtSign, KeyRound, User as UserIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormErrorList } from '@/components/ui/form-error-list';
import { apiClientV2 } from '@/lib/api-client';
import { errorMessage } from '@/lib/error-message';
import { storeTokens } from '@/lib/auth-token';
import { m } from '@paraglide/messages.js';

export function AcceptInviteForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [formData, setFormData] = useState({ username: '', name: '', password: '' });

  // Preview the invite to show who it is for / detect a dead link early.
  useEffect(() => {
    if (!token) {
      setTokenInvalid(true);
      return;
    }
    let active = true;
    (async () => {
      const res = await apiClientV2.invite.accept.$get({ query: { token } });
      if (!active) return;
      if (res.status === 200) {
        const body = await res.json();
        setInvitedEmail(body.email);
      } else {
        setTokenInvalid(true);
      }
    })().catch(() => {
      if (active) setTokenInvalid(true);
    });
    return () => {
      active = false;
    };
  }, [token]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setIsSubmitting(true);
    setErrors([]);

    try {
      const response = await apiClientV2.invite.accept.$post({
        json: { token, username: formData.username, name: formData.name, password: formData.password },
      });

      if (response.status === 200) {
        const body = await response.json();
        storeTokens(body, body.expiresIn);
        router.push('/');
      } else {
        const body = await response.json();
        const error = 'error' in body ? body.error : undefined;
        setErrors([errorMessage(error?.code, error?.message || m['auth.invite_accept.error']())]);
      }
    } catch {
      setErrors([m['auth.common.server_error']()]);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (tokenInvalid) {
    return (
      <Card className="shadow-2xl">
        <CardHeader>
          <CardTitle className="text-xl text-center">{m['auth.invite_accept.invalid_title']()}</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>{m['auth.invite_accept.invalid_body']()}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-2xl">
      <CardHeader className="space-y-1">
        <CardTitle className="text-xl text-center">{m['auth.invite_accept.heading']()}</CardTitle>
        {invitedEmail && <CardDescription className="text-center">{m['auth.invite_accept.joining_as']({ email: invitedEmail })}</CardDescription>}
      </CardHeader>
      <CardContent>
        <FormErrorList errors={errors} />

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">{m['auth.invite_accept.username_label']()}</Label>
            <div className="relative">
              <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="username" name="username" value={formData.username} onChange={handleChange} className="pl-10" required autoComplete="username" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">{m['auth.invite_accept.name_label']()}</Label>
            <div className="relative">
              <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input id="name" name="name" value={formData.name} onChange={handleChange} className="pl-10" required autoComplete="name" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">{m['auth.invite_accept.password_label']()}</Label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="password"
                name="password"
                type="password"
                value={formData.password}
                onChange={handleChange}
                className="pl-10"
                required
                minLength={6}
                autoComplete="new-password"
              />
            </div>
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? m['auth.invite_accept.submitting']() : m['auth.invite_accept.submit']()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
