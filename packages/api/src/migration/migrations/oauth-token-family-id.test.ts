import crypto from 'node:crypto';

import mongoose from 'mongoose';

import type { MigrationApplicationModel } from 'src/models/migration-application';
import { crowi } from 'src/test/setup';

import { allMigrations } from './index';
import { MigrationRegistry } from '../registry';
import { runBootMigrations } from '../run-boot-migrations';
import { MigrationRunner } from '../runner';
import { oauthTokenFamilyId } from './oauth-token-family-id';

const MigrationApplication = () => crowi.model('MigrationApplication') as MigrationApplicationModel;

describe('migration/oauth-token-family-id', () => {
  const ObjectId = mongoose.Types.ObjectId;
  const Refresh = () => crowi.model('OAuthRefreshToken');

  const rawRow = (extra: Record<string, unknown> = {}) => ({
    tokenHash: crypto.randomBytes(16).toString('hex'),
    clientId: 'crowi-cli',
    userId: new ObjectId(),
    scopes: [],
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    revokedAt: null,
    rotatedTo: null,
    ...extra,
  });

  const insert = async (extra: Record<string, unknown> = {}) => {
    const row = rawRow(extra);
    await Refresh().collection.insertOne(row);
    return row.tokenHash;
  };
  const revokedAt = async (tokenHash: string) => (await Refresh().collection.findOne({ tokenHash }))?.revokedAt as Date | null;

  beforeEach(async () => {
    await Refresh().deleteMany({});
    await MigrationApplication().deleteMany({ migrationId: 'oauth-token-family-id' });
  });

  afterAll(async () => {
    await Refresh().deleteMany({});
    await MigrationApplication().deleteMany({ migrationId: 'oauth-token-family-id' });
  });

  it('revokes every unrevoked family-less row (missing, null, empty, expired, unlinked forks)', async () => {
    const missing = await insert();
    const nul = await insert({ familyId: null });
    const empty = await insert({ familyId: '' });
    const expired = await insert({ expiresAt: new Date(Date.now() - 1000) });
    const forkA = await insert({ rotatedTo: null });
    const forkB = await insert({ rotatedTo: null });

    const outcome = await new MigrationRunner(crowi).apply(oauthTokenFamilyId);

    expect(outcome.result).toBe('applied');
    expect((outcome.stats['revoke-familyless-refresh-tokens'] as { transformed: number }).transformed).toBe(6);
    for (const h of [missing, nul, empty, expired, forkA, forkB]) {
      expect(await revokedAt(h)).toBeInstanceOf(Date);
    }
    // No family is invented.
    expect((await Refresh().collection.findOne({ tokenHash: missing }))?.familyId).toBeUndefined();
  });

  it('leaves family rows and already revoked rows untouched', async () => {
    const healthy = await insert({ familyId: crypto.randomUUID() });
    const earlier = new Date('2026-01-01T00:00:00Z');
    const alreadyRevoked = await insert({ revokedAt: earlier });

    const runner = new MigrationRunner(crowi);
    expect(await runner.isPending(oauthTokenFamilyId)).toBe(false);
    const outcome = await runner.apply(oauthTokenFamilyId);

    expect(outcome.result).toBe('detected-clean');
    expect(await revokedAt(healthy)).toBeNull();
    expect((await revokedAt(alreadyRevoked))?.getTime()).toBe(earlier.getTime());
  });

  it('resumes from a partial application without rewriting earlier timestamps, and a re-run is clean', async () => {
    const earlier = new Date('2026-01-01T00:00:00Z');
    const done = await insert({ revokedAt: earlier });
    const remaining = await insert();

    const runner = new MigrationRunner(crowi);
    await runner.apply(oauthTokenFamilyId);

    expect((await revokedAt(done))?.getTime()).toBe(earlier.getTime());
    const stamped = await revokedAt(remaining);
    expect(stamped).toBeInstanceOf(Date);

    expect(await runner.isPending(oauthTokenFamilyId)).toBe(false);
    await runner.apply(oauthTokenFamilyId);
    expect((await revokedAt(remaining))?.getTime()).toBe(stamped?.getTime());
  });

  it('is safe when two runners apply concurrently', async () => {
    const hashes = await Promise.all(Array.from({ length: 5 }, () => insert()));
    await Promise.all([new MigrationRunner(crowi).apply(oauthTokenFamilyId), new MigrationRunner(crowi).apply(oauthTokenFamilyId)]);
    for (const h of hashes) expect(await revokedAt(h)).toBeInstanceOf(Date);
  });

  it('detect counts the pending rows', async () => {
    await insert();
    await insert({ familyId: '' });
    await insert({ familyId: crypto.randomUUID() });
    const detected = await oauthTokenFamilyId.detect?.({ crowi } as never);
    expect(detected?.counts).toEqual({ remaining: 2 });
  });

  it('dry-run revokes nothing and records nothing', async () => {
    const h = await insert();
    await new MigrationRunner(crowi, { dryRun: true }).apply(oauthTokenFamilyId);
    expect(await revokedAt(h)).toBeNull();
    expect(await MigrationApplication().countDocuments({ migrationId: 'oauth-token-family-id' })).toBe(0);
  });

  it('is registered, runs at boot, and a second boot is clean', async () => {
    expect(allMigrations).toContain(oauthTokenFamilyId);
    const h = await insert();
    const registry = new MigrationRegistry([oauthTokenFamilyId]);

    const first = await runBootMigrations(crowi, { registry, policy: 'block' });
    expect(first.appliedBootIds).toEqual(['oauth-token-family-id']);
    expect(await revokedAt(h)).toBeInstanceOf(Date);

    await runBootMigrations(crowi, { registry, policy: 'block' });
    expect(await MigrationApplication().countDocuments({ migrationId: 'oauth-token-family-id' })).toBe(1);
  });

  it('propagates a failure instead of letting boot continue', async () => {
    await insert();
    const spy = jest.spyOn(Refresh(), 'updateMany').mockRejectedValue(new Error('injected') as never);
    try {
      const registry = new MigrationRegistry([oauthTokenFamilyId]);
      await expect(runBootMigrations(crowi, { registry, policy: 'block' })).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
