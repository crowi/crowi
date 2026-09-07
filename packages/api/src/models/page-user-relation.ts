import { Types, Document, Model } from 'mongoose';

/**
 * Read-preference override for a relation query/aggregate. Omitted means
 * "leave the connection's configured default alone". The only value ever
 * passed is `'primary'` — call sites that must observe their own
 * just-completed write (feature-page-relations-collections spec D-2/D-6)
 * pass it explicitly; call sites reading someone else's state (a
 * different request, a rebuild flush batch) omit it.
 */
export interface RelationReadOptions {
  readPreference?: 'primary';
}

/**
 * Shared shape for `Like.add` / `Seen.add`. `document` is the row for the
 * `{page,user}` identity AFTER this call settles — freshly inserted,
 * already-existing (idempotent re-add), or `null` when a concurrent
 * remove won the race between this call's insert and its post-E11000
 * re-read (spec D-1). `inserted` is true only when THIS call created the
 * row — callers gate Activity creation on it.
 */
export interface RelationAddResult<T> {
  document: T | null;
  inserted: boolean;
}

/** `string | ObjectId` bulk static inputs are cast here — aggregation `$in` does not auto-cast like a Mongoose query does (spec D-2). */
export const toObjectId = (id: string | Types.ObjectId): Types.ObjectId => (typeof id === 'string' ? new Types.ObjectId(id) : id);

/** Shared by `Like` / `Seen` — a `{page,user}`-unique relation row with the D-1 nullable `createdAt`. */
export interface RelationDocument extends Document {
  _id: Types.ObjectId;
  page: Types.ObjectId;
  user: Types.ObjectId;
  createdAt: Date | null;
}

export const applyReadPreference = <Q extends { read: (pref: 'primary') => Q }>(query: Q, options?: RelationReadOptions): Q =>
  options?.readPreference ? query.read(options.readPreference) : query;

/**
 * Shared `Like.add` / `Seen.add` body — atomic upsert on the `{page,user}`
 * identity, tolerant of a concurrent-upsert E11000 (spec D-1: re-read the
 * winner's row rather than treat it as a failure; `document: null` means a
 * concurrent `remove` deleted the row between the E11000 and this re-read).
 */
export async function addRelationRow<D extends RelationDocument>(
  model: Model<D>,
  pageId: Types.ObjectId,
  userId: Types.ObjectId,
): Promise<RelationAddResult<D>> {
  try {
    const result = await model
      .findOneAndUpdate(
        { page: pageId, user: userId },
        { $setOnInsert: { createdAt: new Date() } },
        { upsert: true, returnDocument: 'after', includeResultMetadata: true, setDefaultsOnInsert: true },
      )
      .exec();
    const inserted = result.lastErrorObject?.updatedExisting === false;
    return { document: result.value, inserted };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const existing = await model.findOne({ page: pageId, user: userId }).read('primary').exec();
      return { document: existing, inserted: false };
    }
    throw err;
  }
}

/** Shared `Like.getCountsByPageIds` / `Seen.getCountsByPageIds` body — one `$group` aggregate, pages with 0 rows absent from the map. */
export async function getRelationCountsByPageIds<D extends RelationDocument>(
  model: Model<D>,
  pageIds: (string | Types.ObjectId)[],
  options?: RelationReadOptions,
): Promise<Map<string, number>> {
  if (pageIds.length === 0) return new Map();
  const ids = pageIds.map(toObjectId);
  const aggregate = model.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { page: { $in: ids } } },
    { $group: { _id: '$page', count: { $sum: 1 } } },
  ]);
  const result = await applyReadPreference(aggregate, options);
  return new Map(result.map((r) => [r._id.toString(), r.count]));
}

/**
 * D-1: the only path that ever builds a relation model's 3 indexes
 * (`{page:1}` / `{user:1}` / unique `{page:1,user:1}`) — both `Like` and
 * `Seen` register their schema with `autoIndex: false`, so schema
 * registration never does. Re-verifies the catalog after
 * `createIndexes()` so a caller (boot step / migration stage) fails
 * loudly instead of silently proceeding without the uniqueness guarantee
 * C-CONCURRENCY depends on.
 */
export async function assertRelationUniqueIndex(model: Model<RelationDocument>, modelName: string): Promise<void> {
  await model.createIndexes();
  const indexes = await model.collection.indexes();
  const matchesShape = (key: Record<string, unknown>, shape: Record<string, number>) => {
    const keyNames = Object.keys(key);
    const shapeNames = Object.keys(shape);
    return keyNames.length === shapeNames.length && shapeNames.every((name) => key[name] === shape[name]);
  };
  const pageIndex = indexes.find((idx) => matchesShape(idx.key, { page: 1 }));
  const userIndex = indexes.find((idx) => matchesShape(idx.key, { user: 1 }));
  const compoundIndex = indexes.find((idx) => matchesShape(idx.key, { page: 1, user: 1 }));
  if (!pageIndex) throw new Error(`${modelName}.ensureUniqueIndex: missing '{ page: 1 }' index after createIndexes()`);
  if (!userIndex) throw new Error(`${modelName}.ensureUniqueIndex: missing '{ user: 1 }' index after createIndexes()`);
  if (!compoundIndex) throw new Error(`${modelName}.ensureUniqueIndex: missing '{ page: 1, user: 1 }' index after createIndexes()`);
  if (compoundIndex.unique !== true) throw new Error(`${modelName}.ensureUniqueIndex: '{ page: 1, user: 1 }' index exists but is not unique`);
}
