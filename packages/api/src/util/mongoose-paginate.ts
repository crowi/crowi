import type { Schema } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

/**
 * Apply the `mongoose-paginate-v2` plugin to a schema.
 *
 * mongoose-paginate-v2 types its default export as `(schema: Schema) => void`,
 * which mongoose 8's generic `Schema.plugin()` does not accept directly; the
 * plugin only augments the schema with `paginate`, so apply it against the
 * schema's loosened base type. Centralized here so the cast + rationale live
 * in one place rather than being repeated per model.
 */
export function applyPaginatePlugin<TSchema>(schema: TSchema): void {
  // Widen the model's concrete schema to the base `Schema` so mongoose 8's
  // generic `plugin()` accepts mongoose-paginate-v2's loosely-typed export.
  // (Centralizes the cast that each model previously repeated inline.)
  (schema as unknown as Schema).plugin(mongoosePaginate);
}
