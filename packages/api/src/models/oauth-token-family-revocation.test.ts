import crypto from 'node:crypto';

import mongoose from 'mongoose';

import type { OAuthTokenFamilyRevocationModel } from 'src/models/oauth-token-family-revocation';
import { familyRevocationKey } from 'src/models/oauth-token-family-revocation';
import { crowi } from 'src/test/setup';

describe('OAuthTokenFamilyRevocation', () => {
  const ObjectId = mongoose.Types.ObjectId;
  let Rev: OAuthTokenFamilyRevocationModel;

  beforeAll(() => {
    Rev = crowi.model('OAuthTokenFamilyRevocation');
  });

  beforeEach(async () => {
    await Rev.deleteMany({});
  });

  it('keys a record by owner and family', () => {
    const userId = new ObjectId();
    expect(familyRevocationKey('fam', userId)).toBe(`${userId.toHexString()}:fam`);
  });

  it('upserts one record, keeping the first revokedAt on repeat and concurrent calls', async () => {
    const userId = new ObjectId();
    const familyId = crypto.randomUUID();
    const first = new Date('2026-01-01T00:00:00Z');
    await Rev.markRevoked(familyId, userId, first);
    await Promise.all([Rev.markRevoked(familyId, userId, new Date()), Rev.markRevoked(familyId, userId, new Date())]);

    const rows = await Rev.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(familyRevocationKey(familyId, userId));
    expect(rows[0].revokedAt.getTime()).toBe(first.getTime());
  });

  it('separates owners that share a family string', async () => {
    const familyId = crypto.randomUUID();
    const a = new ObjectId();
    const b = new ObjectId();
    await Rev.markRevoked(familyId, a, new Date());
    expect(await Rev.isRevoked(familyId, a)).toBe(true);
    expect(await Rev.isRevoked(familyId, b)).toBe(false);
    expect(await Rev.isRevoked(crypto.randomUUID(), a)).toBe(false);
  });

  it('treats a duplicate-key race as success only when the record exists', async () => {
    const userId = new ObjectId();
    const familyId = crypto.randomUUID();
    const dup = Object.assign(new Error('dup'), { code: 11000 });

    const spy = jest.spyOn(Rev, 'updateOne').mockRejectedValue(dup as never);
    try {
      await expect(Rev.markRevoked(familyId, userId, new Date())).rejects.toThrow('dup');
      await Rev.collection.insertOne({ _id: familyRevocationKey(familyId, userId), familyId, userId, revokedAt: new Date() } as never);
      await expect(Rev.markRevoked(familyId, userId, new Date())).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('propagates other write errors', async () => {
    const spy = jest.spyOn(Rev, 'updateOne').mockRejectedValue(new Error('boom') as never);
    try {
      await expect(Rev.markRevoked('f', new ObjectId(), new Date())).rejects.toThrow('boom');
    } finally {
      spy.mockRestore();
    }
  });

  it('throws on a read failure instead of reporting "not revoked"', async () => {
    const spy = jest.spyOn(Rev, 'exists').mockImplementation((() => {
      throw new Error('read failed');
    }) as never);
    try {
      await expect(Rev.isRevoked('f', new ObjectId())).rejects.toThrow('read failed');
    } finally {
      spy.mockRestore();
    }
  });

  it('reads from the primary', async () => {
    const readSpy = jest.fn().mockResolvedValue({ _id: 'x' });
    const spy = jest.spyOn(Rev, 'exists').mockReturnValue({ read: readSpy } as never);
    try {
      expect(await Rev.isRevoked('f', new ObjectId())).toBe(true);
      expect(readSpy).toHaveBeenCalledWith('primary');
    } finally {
      spy.mockRestore();
    }
  });

  it('passes no write concern to the upsert', async () => {
    const spy = jest.spyOn(Rev, 'updateOne');
    try {
      await Rev.markRevoked('f', new ObjectId(), new Date());
      const options = spy.mock.calls[0][2] as Record<string, unknown>;
      expect(options).toEqual({ upsert: true });
      expect(options).not.toHaveProperty('writeConcern');
    } finally {
      spy.mockRestore();
    }
  });

  it('declares no TTL index', () => {
    const ttl = Rev.schema.indexes().find(([, opts]) => (opts as { expireAfterSeconds?: number }).expireAfterSeconds !== undefined);
    expect(ttl).toBeUndefined();
    expect(Rev.schema.options.expires).toBeUndefined();
  });
});
