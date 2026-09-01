'use client';

import { m } from '@paraglide/messages.js';
import { getLocale } from '@paraglide/runtime.js';
import { AlertCircle, Check, Copy, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { resolveMcpEndpoint } from '@/lib/resolve-mcp-endpoint';
import { copyFailureMessage, useCopyFeedback } from '@/lib/use-copy-feedback';

/** Stand-in for the PAT in every copy-pasteable snippet. */
const TOKEN_PLACEHOLDER = '<YOUR_TOKEN>';

/** Env var the Codex config reads the bearer token from. */
const CODEX_TOKEN_ENV = 'CROWI_MCP_PAT';

/** Read-only snippet with a copy button pinned to its top-right corner. */
function CodeBlock({ code }: { code: string }) {
  const { copied, failed, copy } = useCopyFeedback();
  const title = copyFailureMessage(failed) ?? m['me.mcp.copy']();
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-muted p-3 pr-12 text-xs leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
      <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1" onClick={() => copy(code)} title={title} aria-label={title}>
        {copied ? <Check className="size-4 text-green-600" /> : failed ? <AlertCircle className="size-4 text-destructive" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

export function McpSetupSection() {
  // `McpSetupSection` only ever mounts client-side, after `useProfile()`'s
  // query resolves (the `(auth)` tree has no HydrationBoundary/prefetchQuery,
  // so `page.tsx` renders its `isLoading` branch through both SSR and
  // hydration and only swaps to this section afterwards) — so `window` is
  // always available by the time this runs and a plain call is enough; no
  // SSR/hydration-parity mechanism is needed.
  const endpoint = resolveMcpEndpoint();

  const { copied: isEndpointCopied, failed: endpointCopyFailed, copy: copyEndpoint } = useCopyFeedback();
  const endpointCopyTitle = copyFailureMessage(endpointCopyFailed) ?? m['me.mcp.copy']();

  const claudeCommand = `claude mcp add --transport http crowi ${endpoint} \\\n  --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;
  const codexCommand = `export ${CODEX_TOKEN_ENV}=${TOKEN_PLACEHOLDER}\ncodex mcp add crowi --url ${endpoint} --bearer-token-env-var ${CODEX_TOKEN_ENV}`;
  const codexConfig = `[mcp_servers.crowi]\nurl = "${endpoint}"\nbearer_token_env_var = "${CODEX_TOKEN_ENV}"`;

  const docsUrl = `https://crowi.wiki/${getLocale() === 'ja' ? 'ja' : 'en'}/docs/operations/mcp`;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-medium">{m['me.mcp.step_token_title']()}</h3>
        <p className="text-sm text-muted-foreground">{m['me.mcp.step_token_desc']()}</p>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-medium">{m['me.mcp.step_client_title']()}</h3>

        <div className="space-y-2">
          <Label htmlFor="mcp-endpoint">{m['me.mcp.endpoint_label']()}</Label>
          <div className="flex gap-2">
            <Input id="mcp-endpoint" readOnly value={endpoint} className="font-mono text-sm bg-muted" />
            <Button type="button" variant="outline" size="icon" onClick={() => copyEndpoint(endpoint)} title={endpointCopyTitle} aria-label={endpointCopyTitle}>
              {isEndpointCopied ? (
                <Check className="size-4 text-green-600" />
              ) : endpointCopyFailed ? (
                <AlertCircle className="size-4 text-destructive" />
              ) : (
                <Copy className="size-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{m['me.mcp.token_placeholder_note']({ placeholder: TOKEN_PLACEHOLDER })}</p>
        </div>

        <Tabs defaultValue="claude" className="space-y-3">
          <TabsList>
            <TabsTrigger value="claude">{m['me.mcp.tab_claude']()}</TabsTrigger>
            <TabsTrigger value="codex">{m['me.mcp.tab_codex']()}</TabsTrigger>
          </TabsList>

          <TabsContent value="claude" className="space-y-3">
            <p className="text-sm text-muted-foreground">{m['me.mcp.claude_desc']()}</p>
            <CodeBlock code={claudeCommand} />
            <p className="text-xs text-muted-foreground">{m['me.mcp.claude_scope_note']()}</p>
            <p className="text-xs text-muted-foreground">{m['me.mcp.claude_verify_note']()}</p>
          </TabsContent>

          <TabsContent value="codex" className="space-y-3">
            <p className="text-sm text-muted-foreground">{m['me.mcp.codex_desc']()}</p>
            <CodeBlock code={codexCommand} />
            <p className="text-xs text-muted-foreground">{m['me.mcp.codex_env_note']()}</p>
            <p className="text-sm text-muted-foreground">{m['me.mcp.codex_config_desc']()}</p>
            <CodeBlock code={codexConfig} />
            <p className="text-xs text-muted-foreground">{m['me.mcp.codex_verify_note']()}</p>
          </TabsContent>
        </Tabs>
      </section>

      <a href={docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        {m['me.mcp.docs_link']()}
        <ExternalLink className="size-3.5" />
      </a>
    </div>
  );
}
