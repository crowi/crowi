# @crowi/plugin-api

Type-only contract for Crowi 2.0 plugins. A Crowi plugin is an ordinary
npm package that default-exports an object satisfying the `CrowiPlugin`
type from this package; the runtime loads it via `await
import('<plugin-name>')` at boot and calls each `register*` callback it
implements. See
[RFC-0001](https://github.com/crowi/crowi/blob/main/docs/rfcs/0001-plugin-architecture.md)
for the full design and the
[plugin development guide](https://crowi.wiki/docs/plugins/developing)
for a walkthrough.

> **Alpha notice**: Crowi v2 is under active alpha development and this
> package is at `0.x`. The API stability guarantee (working across every
> v2 minor) takes effect once it reaches `2.x`; the contract may still
> change during the alpha period.

## Minimal plugin

```ts
import type { CrowiPlugin } from '@crowi/plugin-api';

const myPlugin: CrowiPlugin = {
  name: '@example/crowi-plugin-mystorage',
  version: '0.1.0',

  registerStorage: (registry, ctx) => {
    registry.register('mystorage', {
      put: async (key, body, meta) => ({ key }),
      get: async (key) => { throw new Error('not implemented'); },
      delete: async (key) => {},
    });
  },
};

export default myPlugin;
```

`name` must match the npm package name — it doubles as the namespace
prefix for this plugin's config rows (`plugin:<name>:*`) and per-page
metadata (`page.metadata['<name>']`).

## Authoring a config schema

A plugin declares its configurable values with `configSchema`, a Zod
object schema. The admin UI at `/admin/plugins` walks this schema to
auto-generate a config form, encrypt `@sensitive`-marked fields at
rest, and render `@action`-marked fields with a button.

This package's `peerDependencies` declares `zod: "^4"` — that is the
correct **npm package** to install, because the zod v4 package is the
one that ships a `zod/v3` compat subpath. What `peerDependencies`
cannot express is *which entry point* to import from, and that part
matters:

```ts
// Correct — the v3 compat shim that the v4 package ships.
import { z } from 'zod/v3';

// Wrong — compiles and type-checks, but fails at plugin boot.
import { z } from 'zod';
```

`CrowiPlugin.configSchema` is typed against `zod/v3`'s `z.ZodObject`,
and every runtime helper that reads a plugin's config schema
(`@sensitive` / `@action` marker detection, the admin form field
serializer, `listSensitiveKeys()`) introspects the `zod/v3` internal
shape (`_def.typeName`, `_def.values`, `.description`, …). A schema
built from the top-level `zod` (v4) API has a different internal shape
and none of that introspection can see through it — most importantly,
`@sensitive` fields stop being detected, and the value they guard would
be written to and read from storage as plaintext.

To turn that silent failure mode into a loud one, `PluginManager`
validates every plugin's `configSchema` at boot and throws if it wasn't
built from `zod/v3`:

```
Plugin '<name>' declares configSchema built with the top-level 'zod' (v4) API.
Import from 'zod/v3' instead — @crowi/plugin-api's config-schema introspection
requires the zod v3 compat shape (see @crowi/plugin-api README).
```

If you hit this error, the fix is always the same: change the `zod`
import for the file that builds `configSchema` (and `pageMetadataSchema`,
if you use it) to `import { z } from 'zod/v3'`. No other code needs to
change — `zod/v3`'s `z.object()` / `z.string()` / etc. API surface is
what every first-party Crowi plugin already uses.

```ts
import { z } from 'zod/v3';
import type { CrowiPlugin } from '@crowi/plugin-api';

const myPlugin: CrowiPlugin = {
  name: '@example/crowi-plugin-mystorage',
  version: '0.1.0',

  configSchema: z.object({
    endpoint: z.string().url().describe('Storage endpoint URL'),
    accessKey: z.string().describe('@sensitive Access key'),
  }),

  registerStorage: (registry, ctx) => {
    const config = ctx.config<{ endpoint: string; accessKey: string }>();
    // ... build the driver using config
  },
};

export default myPlugin;
```

## See also

- [Plugin development guide](https://crowi.wiki/docs/plugins/developing) —
  the full walkthrough (markers, `adminPlacement`, `configI18n`,
  `PluginContext`, dependency plugins, renderer plugins).
- [RFC-0001: Plugin architecture](https://github.com/crowi/crowi/blob/main/docs/rfcs/0001-plugin-architecture.md)
