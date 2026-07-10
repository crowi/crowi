// Plugin config schemas are still authored against zod v3 (see
// `packages/plugin-*`/index.ts). The serializer introspects v3 internals
// (`_def`, `ZodEffects`, `ZodNativeEnum`, etc.) that were restructured in
// zod v4, so we explicitly pin this file to the `zod/v3` compat module
// that the v4 package ships. The v4 schemas live in `@crowi/api-contract`
// and never reach this code path.
//
// Detection below compares `_def.typeName` strings rather than using
// `instanceof z.ZodXxx`: `instanceof` silently returns false against a
// zod v4-native schema (no exception, no type error — see
// `PluginManager`'s `assertZodV3ConfigSchema` boot guard, which is the
// first line of defense against that; this is the second, and also
// sidesteps any hoisting-induced prototype mismatch across duplicate
// `zod/v3` copies in node_modules).
import { type ZodTypeAny, z } from 'zod/v3';
import { ACTION_FIELD_MARKER, SENSITIVE_FIELD_MARKER, getActionAnnotation } from '@crowi/plugin-api';

/**
 * Serialised shape of a single plugin config field. The web admin
 * form renders one input per field, picking the control by `kind`.
 *
 * Sensitive fields (`@sensitive` description marker) are NOT present
 * in `defaultValue` even when the schema declares one — secrets are
 * never echoed back from the server. Use the separate values payload
 * with `{ hasValue: true }` to render the "currently saved" badge.
 */
export interface SerializedPluginField {
  name: string;
  kind: 'string' | 'secret' | 'number' | 'boolean' | 'enum' | 'string-array';
  description?: string;
  defaultValue?: unknown;
  /** Enum options when `kind === 'enum'`. */
  options?: string[];
  /** Action button annotation (parsed from `@action ...` description). */
  action?: { label: string; method: string; path: string };
  /** True when the field was declared as optional (`z.…optional()`). */
  optional: boolean;
}

/**
 * Walk a plugin's `configSchema` (assumed to be a `z.object({...})`)
 * and produce a flat list of fields the admin form can render. Only
 * the field shapes the plugin RFC committed to are recognised:
 * string / number / boolean / enum / string[]. Anything else falls
 * back to `kind: 'string'` (with a descriptive log on the server).
 */
export function serializeConfigSchema(schema: z.ZodObject<Record<string, ZodTypeAny>>): SerializedPluginField[] {
  const out: SerializedPluginField[] = [];
  for (const [name, raw] of Object.entries(schema.shape)) {
    out.push(serializeField(name, raw));
  }
  return out;
}

function serializeField(name: string, raw: ZodTypeAny): SerializedPluginField {
  const { unwrapped, optional, defaultValue } = unwrapMeta(raw);
  const description = (unwrapped.description ?? raw.description) || undefined;
  const cleanedDescription = stripMarkers(description);
  const action = getActionAnnotation(raw) ?? getActionAnnotation(unwrapped) ?? undefined;
  const sensitive = describesSensitive(raw) || describesSensitive(unwrapped);

  const kindResult = detectKind(unwrapped, sensitive);

  return {
    name,
    kind: kindResult.kind,
    description: cleanedDescription,
    // Sensitive defaults are not echoed back — operators set their own.
    defaultValue: sensitive ? undefined : defaultValue,
    options: kindResult.options,
    action,
    optional,
  };
}

interface UnwrapResult {
  unwrapped: ZodTypeAny;
  optional: boolean;
  defaultValue: unknown;
}

/**
 * Strip `ZodOptional` / `ZodDefault` / `ZodEffects` wrappers (which
 * `z.string().refine(...)` introduces) so we can introspect the inner
 * primitive type.
 */
function unwrapMeta(node: ZodTypeAny): UnwrapResult {
  let cur: ZodTypeAny = node;
  let optional = false;
  let defaultValue: unknown = undefined;

  // Unwrap up to a small depth to avoid pathological loops.
  for (let i = 0; i < 6; i++) {
    const typeName = cur._def?.typeName;
    if (typeName === 'ZodOptional') {
      optional = true;
      cur = cur._def.innerType;
      continue;
    }
    if (typeName === 'ZodDefault') {
      const def = cur._def.defaultValue;
      defaultValue = typeof def === 'function' ? def() : def;
      cur = cur._def.innerType;
      continue;
    }
    if (typeName === 'ZodEffects') {
      // refine / transform — keep the underlying schema for kind detection
      cur = cur._def.schema;
      continue;
    }
    break;
  }

  return { unwrapped: cur, optional, defaultValue };
}

function detectKind(unwrapped: ZodTypeAny, sensitive: boolean): { kind: SerializedPluginField['kind']; options?: string[] } {
  const typeName = unwrapped._def?.typeName;
  if (typeName === 'ZodString') {
    return { kind: sensitive ? 'secret' : 'string' };
  }
  if (typeName === 'ZodNumber') {
    return { kind: 'number' };
  }
  if (typeName === 'ZodBoolean') {
    return { kind: 'boolean' };
  }
  if (typeName === 'ZodEnum') {
    return { kind: 'enum', options: [...unwrapped._def.values] };
  }
  if (typeName === 'ZodNativeEnum') {
    const values = Object.values(unwrapped._def.values).filter((v): v is string => typeof v === 'string');
    return { kind: 'enum', options: values };
  }
  if (typeName === 'ZodArray' && unwrapped._def.type?._def?.typeName === 'ZodString') {
    return { kind: 'string-array' };
  }
  // Unrecognised shape — fall back to string (admin form renders an Input).
  return { kind: 'string' };
}

function describesSensitive(node: ZodTypeAny): boolean {
  const d = node.description;
  return typeof d === 'string' && d.trimStart().startsWith(SENSITIVE_FIELD_MARKER);
}

/**
 * Remove the leading `@sensitive` / `@action ...` marker from a
 * description so the admin form can render it as plain help text.
 * The marker payload is already extracted into `kind`/`action`.
 */
function stripMarkers(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const trimmed = description.trimStart();
  if (trimmed.startsWith(SENSITIVE_FIELD_MARKER)) {
    return trimmed.slice(SENSITIVE_FIELD_MARKER.length).trim() || undefined;
  }
  if (trimmed.startsWith(ACTION_FIELD_MARKER)) {
    // The full annotation `"label" METHOD /path` is captured into
    // `action`; the leftover after parsing is rarely useful for help
    // text, so omit it entirely.
    return undefined;
  }
  return description;
}
