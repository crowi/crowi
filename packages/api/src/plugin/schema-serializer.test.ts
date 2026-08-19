import { z } from 'zod/v3';
import { serializeConfigSchema } from './schema-serializer';

/**
 * Regression coverage for AC-4: `unwrapMeta`/`detectKind` were switched
 * from `instanceof z.ZodXxx` to `_def.typeName` string comparisons (see
 * the header comment in `schema-serializer.ts`). Every kind judgment the
 * admin form relies on (string / secret / number / boolean / enum /
 * nativeEnum / string-array, plus optional/default/effects unwrapping)
 * must return exactly the same result as before the switch.
 */
describe('serializeConfigSchema', () => {
  it('detects a plain string field', () => {
    const [field] = serializeConfigSchema(z.object({ name: z.string().describe('Display name') }));
    expect(field).toMatchObject({ name: 'name', kind: 'string', description: 'Display name', optional: false });
  });

  it('detects a @sensitive string field as kind "secret" and strips the marker', () => {
    const [field] = serializeConfigSchema(z.object({ apiKey: z.string().describe('@sensitive API key') }));
    expect(field).toMatchObject({ name: 'apiKey', kind: 'secret', description: 'API key', optional: false });
  });

  it('detects a number field', () => {
    const [field] = serializeConfigSchema(z.object({ port: z.number() }));
    expect(field.kind).toBe('number');
  });

  it('detects a boolean field', () => {
    const [field] = serializeConfigSchema(z.object({ debug: z.boolean() }));
    expect(field.kind).toBe('boolean');
  });

  it('detects a z.enum field with its options', () => {
    const [field] = serializeConfigSchema(z.object({ mode: z.enum(['a', 'b', 'c']) }));
    expect(field).toMatchObject({ kind: 'enum', options: ['a', 'b', 'c'] });
  });

  it('detects a z.nativeEnum field with its string values', () => {
    enum Region {
      US = 'us',
      EU = 'eu',
    }
    const [field] = serializeConfigSchema(z.object({ region: z.nativeEnum(Region) }));
    expect(field.kind).toBe('enum');
    expect(field.options).toEqual(expect.arrayContaining(['us', 'eu']));
    expect(field.options).toHaveLength(2);
  });

  it('detects a z.array(z.string()) field as kind "string-array"', () => {
    const [field] = serializeConfigSchema(z.object({ tags: z.array(z.string()) }));
    expect(field.kind).toBe('string-array');
  });

  it('falls back to "string" for an array of a non-string element type', () => {
    const [field] = serializeConfigSchema(z.object({ counts: z.array(z.number()) }));
    expect(field.kind).toBe('string');
  });

  it('falls back to "string" for an unrecognised shape (e.g. z.date())', () => {
    const [field] = serializeConfigSchema(z.object({ createdAt: z.date() }));
    expect(field.kind).toBe('string');
  });

  it('unwraps z.optional() and reports optional: true without changing kind', () => {
    const [field] = serializeConfigSchema(z.object({ nickname: z.string().optional() }));
    expect(field).toMatchObject({ kind: 'string', optional: true });
  });

  it('unwraps z.default() and reports the default value without changing kind', () => {
    const [field] = serializeConfigSchema(z.object({ retries: z.number().default(3) }));
    expect(field).toMatchObject({ kind: 'number', optional: false, defaultValue: 3 });
  });

  it('evaluates a function default() lazily', () => {
    const [field] = serializeConfigSchema(z.object({ seed: z.string().default(() => 'generated') }));
    expect(field.defaultValue).toBe('generated');
  });

  it('unwraps a refine()-wrapped (ZodEffects) field to the underlying kind', () => {
    const [field] = serializeConfigSchema(
      z.object({
        email: z
          .string()
          .refine((v) => v.includes('@'))
          .default('a@b.com'),
      }),
    );
    expect(field).toMatchObject({ kind: 'string', defaultValue: 'a@b.com' });
  });

  it('does not echo a default value back for a @sensitive field', () => {
    const [field] = serializeConfigSchema(z.object({ token: z.string().describe('@sensitive Token').default('seed') }));
    expect(field.kind).toBe('secret');
    expect(field.defaultValue).toBeUndefined();
  });

  it('parses an @action-marked field into the action annotation and strips the description', () => {
    const [field] = serializeConfigSchema(z.object({ test: z.string().describe('@action "Test connection" POST /test').default('') }));
    expect(field.action).toEqual({ label: 'Test connection', method: 'POST', path: '/test' });
    expect(field.description).toBeUndefined();
  });

  it('detects @sensitive on an intermediate ZodEffects wrapper, invisible to both the outermost and fully-unwrapped nodes (feature-storage-gcs AC-2)', () => {
    // Two stacked `superRefine()` calls with `.describe()` placed on the
    // FIRST effects layer: neither the outer ZodDefault (built from the
    // second, describe-less effects layer) nor the fully-unwrapped inner
    // ZodString carries the marker — only the middle ZodEffects does.
    const [field] = serializeConfigSchema(
      z.object({
        serviceAccountKey: z
          .string()
          .superRefine(() => undefined)
          .describe('@sensitive Google Cloud service-account key JSON')
          .superRefine(() => undefined)
          .default(''),
      }),
    );
    expect(field).toMatchObject({ kind: 'secret', description: 'Google Cloud service-account key JSON', defaultValue: undefined });
  });

  it('detects @sensitive six ZodEffects (superRefine) wrappers deep — the exact boundary the bounded traversal must still cover', () => {
    // Six stacked `superRefine()` layers (layer0..layer5) wrap the innermost
    // ZodString, which itself carries the `@sensitive` marker (layer6, the
    // final unwrapped node). A traversal that inspects only 6 nodes before
    // unwrapping (rather than 6 wrapper layers PLUS the final node) never
    // looks at layer6 and would report `sensitive: false` here.
    const inner = z.string().describe('@sensitive Deeply wrapped secret');
    const wrapped = [0, 1, 2, 3, 4, 5].reduce<z.ZodTypeAny>((acc) => acc.superRefine(() => undefined), inner);
    const [field] = serializeConfigSchema(z.object({ secret: wrapped }));
    expect(field).toMatchObject({ kind: 'secret', description: 'Deeply wrapped secret' });
  });

  it('detects @sensitive on the single-superRefine shape used by @crowi/plugin-storage-gcs', () => {
    const [field] = serializeConfigSchema(
      z.object({
        serviceAccountKey: z
          .string()
          .superRefine(() => undefined)
          .describe('@sensitive Google Cloud service-account key JSON')
          .default(''),
      }),
    );
    expect(field).toMatchObject({ kind: 'secret', description: 'Google Cloud service-account key JSON', defaultValue: undefined });
  });

  it('serializes every field of a multi-field schema independently', () => {
    const fields = serializeConfigSchema(
      z.object({
        endpoint: z.string().url().describe('Endpoint URL'),
        bucket: z.string().describe('Bucket name'),
        accessKey: z.string().describe('@sensitive Access key'),
        retries: z.number().default(3),
        enabled: z.boolean(),
        region: z.enum(['us', 'eu']),
      }),
    );

    expect(fields.map((f) => f.name)).toEqual(['endpoint', 'bucket', 'accessKey', 'retries', 'enabled', 'region']);
    expect(fields.map((f) => f.kind)).toEqual(['string', 'string', 'secret', 'number', 'boolean', 'enum']);
  });
});
