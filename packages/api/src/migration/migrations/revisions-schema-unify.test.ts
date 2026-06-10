import { crowi } from 'src/test/setup';
import type { MigrationApplicationModel } from 'src/models/migration-application';

import { MigrationRegistry } from '../registry';
import { runBootMigrations } from '../run-boot-migrations';
import { MigrationRunner } from '../runner';
import { revisionsSchemaUnify } from './revisions-schema-unify';

/**
 * RFC-0008 §10.3 step5 — `revisions-schema-unify` boot migration.
 *
 * Backfills `type='snapshot'` onto v1.x revisions written before the field
 * existed (RFC-0003 added it; collab saves set it explicitly, HTTP API saves
 * did not until the Phase 6 schema `default`). Verifies: the schema default
 * closes the write source, the migration backfills legacy null/missing rows
 * only, is idempotent, and the framework wires it through boot
 * (isPending → apply → migrationApplications record → second boot clean).
 */
const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

describe('migration/revisions-schema-unify', () => {
  let Revision;

  beforeAll(() => {
    Revision = crowi.model('Revision');
  });

  beforeEach(async () => {
    await Revision.deleteMany({ path: { $regex: '^/__rev-unify' } });
    await MigrationApplication().deleteMany({ migrationId: 'revisions-schema-unify' });
  });

  afterEach(async () => {
    await Revision.deleteMany({ path: { $regex: '^/__rev-unify' } });
  });

  describe('schema default closes the write source', () => {
    it('stamps type=snapshot on a revision created without an explicit type (HTTP API path)', async () => {
      // `Revision.create` goes through the schema and applies the
      // `default: 'snapshot'` — the same path Page.createPage /
      // Page.updatePage exercise (they never pass `type`).
      const doc = await Revision.create({
        path: '/__rev-unify/http-save',
        body: 'body',
      });
      const fetched = await Revision.findById(doc._id).lean();
      expect(fetched.type).toBe('snapshot');
    });
  });

  describe('backfill semantics', () => {
    it('backfills type=snapshot on legacy revisions with no type', async () => {
      // Raw collection insert bypasses the schema default, reproducing a
      // pre-Phase-6 (v1.x) row with the field missing.
      await Revision.collection.insertMany([
        { path: '/__rev-unify/legacy-a', body: 'a' },
        { path: '/__rev-unify/legacy-b', body: 'b', type: null },
      ]);

      const runner = new MigrationRunner(crowi);
      const outcome = await runner.apply(revisionsSchemaUnify);

      expect(outcome.result).toBe('applied');
      expect((outcome.stats['backfill-type'] as { transformed: number }).transformed).toBe(2);

      const a = await Revision.findOne({ path: '/__rev-unify/legacy-a' });
      const b = await Revision.findOne({ path: '/__rev-unify/legacy-b' });
      expect(a.type).toBe('snapshot');
      expect(b.type).toBe('snapshot');
    });

    it('leaves an explicit incremental type untouched and is idempotent', async () => {
      await Revision.collection.insertMany([
        { path: '/__rev-unify/incremental', body: 'i', type: 'incremental' },
        { path: '/__rev-unify/snapshot', body: 's', type: 'snapshot' },
      ]);

      // No null rows → not pending → detected-clean, no stage runs.
      const runner = new MigrationRunner(crowi);
      const outcome = await runner.apply(revisionsSchemaUnify);
      expect(outcome.result).toBe('detected-clean');

      const incremental = await Revision.findOne({ path: '/__rev-unify/incremental' });
      const snapshot = await Revision.findOne({ path: '/__rev-unify/snapshot' });
      // The migration must never rewrite an incremental into a snapshot.
      expect(incremental.type).toBe('incremental');
      expect(snapshot.type).toBe('snapshot');
    });

    it('only touches type (contributors / renderedAst stay unchanged)', async () => {
      await Revision.collection.insertMany([{ path: '/__rev-unify/scope', body: 's' }]);

      await new MigrationRunner(crowi).apply(revisionsSchemaUnify);

      const raw = await Revision.collection.findOne({ path: '/__rev-unify/scope' });
      expect(raw?.type).toBe('snapshot');
      // We never fabricate collaboration history nor a rendered AST.
      expect(raw?.contributors).toBeUndefined();
      expect(raw?.renderedAst).toBeUndefined();
    });

    it('dry-run touches no rows', async () => {
      await Revision.collection.insertMany([{ path: '/__rev-unify/dry', body: 'd' }]);

      const runner = new MigrationRunner(crowi, { dryRun: true });
      await runner.apply(revisionsSchemaUnify);

      // Read the raw document: the stage no-oped, so the field must still
      // be absent on disk (the schema default would otherwise hydrate it on
      // a Mongoose `findOne`).
      const dry = await Revision.collection.findOne({ path: '/__rev-unify/dry' });
      expect(dry?.type == null).toBe(true);
      expect(await MigrationApplication().countDocuments({ migrationId: 'revisions-schema-unify' })).toBe(0);
    });
  });

  describe('isPending probe', () => {
    it('is pending while a legacy null row exists, clean once backfilled', async () => {
      await Revision.collection.insertMany([{ path: '/__rev-unify/probe', body: 'p' }]);

      const runner = new MigrationRunner(crowi);
      expect(await runner.isPending(revisionsSchemaUnify)).toBe(true);

      await runner.apply(revisionsSchemaUnify);
      expect(await runner.isPending(revisionsSchemaUnify)).toBe(false);
    });

    it('stays clean after a fresh revision is created via the schema default (no permanent boot block)', async () => {
      // Regression for the Phase 3 lesson: a boot migration whose write
      // source is not closed re-pends on every new row and blocks boot
      // forever. Here the schema `default: 'snapshot'` fills new revisions,
      // so isPending stays false even after writing more.
      await Revision.collection.insertMany([{ path: '/__rev-unify/legacy', body: 'l' }]);

      const runner = new MigrationRunner(crowi);
      await runner.apply(revisionsSchemaUnify);
      expect(await runner.isPending(revisionsSchemaUnify)).toBe(false);

      // A new HTTP-API-style save through the schema gets type via default.
      await Revision.create({ path: '/__rev-unify/new', body: 'n' });
      expect(await runner.isPending(revisionsSchemaUnify)).toBe(false);
    });
  });

  describe('boot wiring (§4.2.1)', () => {
    it('boot applies it, records to migrationApplications, and a second boot is detected-clean', async () => {
      await Revision.collection.insertMany([{ path: '/__rev-unify/boot', body: 'b' }]);

      const registry = new MigrationRegistry([revisionsSchemaUnify]);

      const first = await runBootMigrations(crowi, { registry, policy: 'block' });
      expect(first.appliedBootIds).toEqual(['revisions-schema-unify']);

      const recorded = await MigrationApplication().latestFor('revisions-schema-unify');
      expect(recorded?.result).toBe('applied');
      expect(recorded?.layer).toBe('boot');
      expect(recorded?.appliedBy).toBe('boot-auto');

      const booted = await Revision.findOne({ path: '/__rev-unify/boot' });
      expect(booted.type).toBe('snapshot');
      expect(await MigrationApplication().countDocuments({ migrationId: 'revisions-schema-unify' })).toBe(1);

      // Second boot: data is now clean and a prior apply is recorded → the
      // §6.2 "consistent" path runs no stage and appends NO new record.
      await runBootMigrations(crowi, { registry, policy: 'block' });
      expect(await MigrationApplication().countDocuments({ migrationId: 'revisions-schema-unify' })).toBe(1);
    });
  });
});
