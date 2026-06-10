import { Document, Model, Schema, Types, model } from 'mongoose';

import Crowi from 'src/crowi';

/**
 * RFC-0008 §7 — the `migrationApplications` collection.
 *
 * An **append-only audit log** of every migration run: one document per
 * apply / re-apply / detected-clean / failure. It is NOT the source of
 * truth for "is this migration pending" — that is decided by inspecting
 * the data via each migration's `isPending` probe (§6.1). This log exists
 * to preserve missed-and-rerun history and duration trends, and to power
 * `migrate status`.
 *
 * Self-bootstrapping (§7.3): created from this schema declaration alone
 * (autoIndex builds its indexes at boot), and no migration may modify its
 * schema — this avoids a chicken-and-egg dependency where the framework's
 * own bookkeeping needs a migration to exist.
 */

export type MigrationResult = 'applied' | 'detected-clean' | 're-applied' | 'failed';

export interface MigrationApplicationDocument extends Document {
  _id: Types.ObjectId;
  migrationId: string;
  fromVersion?: string;
  toVersion?: string;
  layer?: 'boot' | 'preflight';
  result: MigrationResult;
  appliedAt: Date;
  durationMs?: number;
  stats?: Record<string, unknown>;
  appliedBy?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecordApplicationInput {
  migrationId: string;
  fromVersion?: string;
  toVersion?: string;
  layer?: 'boot' | 'preflight';
  result: MigrationResult;
  durationMs?: number;
  stats?: Record<string, unknown>;
  appliedBy?: string;
  error?: string;
}

export interface MigrationApplicationModel extends Model<MigrationApplicationDocument> {
  /** Append one application record (the only write path — append-only). */
  record(input: RecordApplicationInput): Promise<MigrationApplicationDocument>;
  /** The most recent record for a migration id, or null if never run. */
  latestFor(migrationId: string): Promise<MigrationApplicationDocument | null>;
  /** The N most recent records across all migrations (for `migrate status`). */
  recent(limit?: number): Promise<MigrationApplicationDocument[]>;
}

export default (crowi: Crowi) => {
  const migrationApplicationSchema = new Schema<MigrationApplicationDocument, MigrationApplicationModel>(
    {
      migrationId: { type: String, required: true, index: true },
      fromVersion: { type: String },
      toVersion: { type: String },
      layer: { type: String, enum: ['boot', 'preflight'] },
      result: {
        type: String,
        enum: ['applied', 'detected-clean', 're-applied', 'failed'],
        required: true,
      },
      appliedAt: { type: Date, default: Date.now, index: true },
      durationMs: { type: Number },
      // Free-form per-run stats (detected / transformed counts, etc.).
      stats: { type: Schema.Types.Mixed },
      // 'boot-auto' | `admin-cli@${hostname}`.
      appliedBy: { type: String },
      // Only populated when `result === 'failed'`.
      error: { type: String },
    },
    { timestamps: true },
  );

  migrationApplicationSchema.statics.record = function (input: RecordApplicationInput): Promise<MigrationApplicationDocument> {
    return MigrationApplication.create({ ...input, appliedAt: new Date() });
  };

  migrationApplicationSchema.statics.latestFor = function (migrationId: string): Promise<MigrationApplicationDocument | null> {
    return MigrationApplication.findOne({ migrationId }).sort({ appliedAt: -1 }).exec();
  };

  migrationApplicationSchema.statics.recent = function (limit = 10): Promise<MigrationApplicationDocument[]> {
    return MigrationApplication.find({}).sort({ appliedAt: -1 }).limit(limit).exec();
  };

  const MigrationApplication = model<MigrationApplicationDocument, MigrationApplicationModel>('MigrationApplication', migrationApplicationSchema);

  return MigrationApplication;
};
