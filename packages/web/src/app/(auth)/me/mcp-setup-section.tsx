'use client';

import { useState, useSyncExternalStore } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MCP_ENDPOINT_PLACEHOLDER, resolveMcpEndpoint } from '@/lib/resolve-mcp-endpoint';
import { m } from '@paraglide/messages.js';
import { getLocale } from '@paraglide/runtime.js';

/** Stand-in for the PAT in every copy-pasteable snippet. */
const TOKEN_PLACEHOLDER = '<YOUR_TOKEN>';

/** Env var the Codex config reads the bearer token from. */
const CODEX_TOKEN_ENV = 'CROWI_MCP_PAT';

// The same-origin endpoint needs `window.location`, which does not exist
// during prerender. Reading it through `useSyncExternalStore` lets the server
// snapshot (the placeholder) drive the hydration render and the real origin
// take over afterwards, keeping SSR ↔ hydration parity without
// setState-in-effect. The endpoint never changes for a given page load, so the
// subscribe callback has nothing to listen to.
const subscribeEndpoint = () => () => {};
const getEndpointServerSnapshot = () => MCP_ENDPOINT_PLACEHOLDER;

/** A copy button that flips to a check mark for 2s, matching the PAT section. */
function useCopy(value: string) {
  const [isCopied, setIsCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // clipboard denied — the text stays visible and selectable.
    }
  };
  return { isCopied, copy };
}

/** Read-only snippet with a copy button pinned to its top-right corner. */
function CodeBlock({ code }: { code: string }) {
  const { isCopied, copy } = useCopy(code);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-muted p-3 pr-12 text-xs leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
      <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1" onClick={copy} title={m['me.mcp.copy']()}>
        {isCopied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

export function McpSetupSection() {
  const endpoint = useSyncExternalStore(subscribeEndpoint, resolveMcpEndpoint, getEndpointServerSnapshot);

  const { isCopied: isEndpointCopied, copy: copyEndpoint } = useCopy(endpoint);

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
            <Button type="button" variant="outline" size="icon" onClick={copyEndpoint} title={m['me.mcp.copy']()}>
              {isEndpointCopied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
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
