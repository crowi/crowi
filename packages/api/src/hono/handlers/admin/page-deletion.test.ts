import { Types } from 'mongoose';
import request from 'supertest';

import type { PageDeletionRecordModel } from 'src/models/page-deletion-record';
import { app, crowi } from 'src/test/setup';
import { authHeaders, createPageViaApi, createTestUser } from 'src/test/test-helpers';

describe('Routes /api/admin/page-deletions (Hono)', () => {
  let PageDeletionRecord: PageDeletionRecordModel;
  let adminToken: string;
  let memberToken: string;
  let adminId: string;

  beforeAll(async () => {
    PageDeletionRecord = crowi.model('PageDeletionRecord');
    const admin = await createTestUser({
      name: 'Deletion Admin',
      username: 'deletionAdmin',
      email: 'deletion-admin@example.com',
      admin: true,
    });
    adminToken = admin.accessToken;
    adminId = admin.user._id.toString();

    const member = await createTestUser({
      name: 'Deletion Member',
      username: 'deletionMember',
      email: 'deletion-member@example.com',
      admin: false,
    });
    memberToken = member.accessToken;
  });

  beforeEach(async () => {
    await PageDeletionRecord.deleteMany({});
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/admin/page-deletions');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('rejects a non-admin user with 403', async () => {
    const record = await PageDeletionRecord.create({
      pageId: new Types.ObjectId(),
      path: '/forbidden/recent',
      actor: null,
      deletedAt: new Date(),
      mode: 'user_hard_delete',
    });

    const res = await request(app).get('/api/admin/page-deletions').set(authHeaders(memberToken));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    expect(await PageDeletionRecord.exists({ _id: record._id })).not.toBeNull();
  });

  it('rejects a non-admin path lookup with 403 without changing the record', async () => {
    const record = await PageDeletionRecord.create({
      pageId: new Types.ObjectId(),
      path: '/forbidden/by-path',
      actor: null,
      deletedAt: new Date(),
      mode: 'user_hard_delete',
    });

    const res = await request(app).get('/api/admin/page-deletions/by-path').query({ path: record.path }).set(authHeaders(memberToken));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    expect(await PageDeletionRecord.exists({ _id: record._id })).not.toBeNull();
  });

  it('rejects a non-admin erase with 403 without deleting the targeted record', async () => {
    const record = await PageDeletionRecord.create({
      pageId: new Types.ObjectId(),
      path: '/forbidden/erase',
      actor: null,
      deletedAt: new Date(),
      mode: 'user_hard_delete',
    });

    const res = await request(app).delete('/api/admin/page-deletions').set(authHeaders(memberToken)).send({ recordId: record._id.toString() });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_REQUIRED');
    expect(await PageDeletionRecord.exists({ _id: record._id })).not.toBeNull();
  });

  it('lists recent records newest first and supports pageId lookup without resolving a Page', async () => {
    const firstPageId = new Types.ObjectId();
    const secondPageId = new Types.ObjectId();
    await PageDeletionRecord.create([
      { pageId: firstPageId, path: '/deleted/first', actor: null, deletedAt: new Date('2026-01-01T00:00:00.000Z'), mode: 'user_hard_delete' },
      { pageId: secondPageId, path: '/deleted/second', actor: null, deletedAt: new Date('2026-02-01T00:00:00.000Z'), mode: 'user_hard_delete' },
    ]);

    const recent = await request(app).get('/api/admin/page-deletions').set(authHeaders(adminToken));
    expect(recent.status).toBe(200);
    expect(recent.body.records.map((record: { pageId: string }) => record.pageId)).toEqual([secondPageId.toString(), firstPageId.toString()]);

    const byPageId = await request(app).get('/api/admin/page-deletions').query({ pageId: firstPageId.toString() }).set(authHeaders(adminToken));
    expect(byPageId.status).toBe(200);
    expect(byPageId.body.records).toHaveLength(1);
    expect(byPageId.body.records[0]).toMatchObject({ pageId: firstPageId.toString(), path: '/deleted/first', actor: null });
    expect(byPageId.body.records[0]).not.toHaveProperty('page');
  });

  it('returns every deletion for a reused path newest first even when a current Page exists there', async () => {
    const path = '/reused-path';
    await PageDeletionRecord.create([
      { pageId: new Types.ObjectId(), path, actor: null, deletedAt: new Date('2026-03-01T00:00:00.000Z'), mode: 'user_hard_delete' },
      { pageId: new Types.ObjectId(), path, actor: null, deletedAt: new Date('2026-04-01T00:00:00.000Z'), mode: 'user_hard_delete' },
    ]);
    const currentPage = await createPageViaApi(adminToken, path, 'current page body');

    const res = await request(app).get('/api/admin/page-deletions/by-path').query({ path }).set(authHeaders(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.records.map((record: { deletedAt: string }) => record.deletedAt)).toEqual(['2026-04-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z']);
    expect(res.body.records.every((record: { pageId: string }) => record.pageId !== currentPage._id)).toBe(true);
  });

  it('erases one record and logs only the audit identifiers', async () => {
    const record = await PageDeletionRecord.create({
      pageId: new Types.ObjectId(),
      path: '/private/deleted',
      actor: null,
      deletedAt: new Date('2026-05-01T00:00:00.000Z'),
      mode: 'user_hard_delete',
    });
    const logSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    let res;
    let logCalls: unknown[][] = [];
    try {
      res = await request(app).delete('/api/admin/page-deletions').set(authHeaders(adminToken)).send({ recordId: record._id.toString() });
      logCalls = logSpy.mock.calls.map((args) => [...args]);
    } finally {
      logSpy.mockRestore();
    }
    const logged = logCalls.map((args) => args.join(' ')).join('\n');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deletedCount: 1 });
    expect(await PageDeletionRecord.countDocuments({ _id: record._id })).toBe(0);
    expect(logged).toContain(adminId);
    expect(logged).toContain(record._id.toString());
    expect(logged).not.toContain('/private/deleted');
  });

  it('erases all records for exactly one path', async () => {
    await PageDeletionRecord.create([
      { pageId: new Types.ObjectId(), path: '/erase-this', actor: null, deletedAt: new Date(), mode: 'user_hard_delete' },
      { pageId: new Types.ObjectId(), path: '/erase-this', actor: null, deletedAt: new Date(), mode: 'user_hard_delete' },
      { pageId: new Types.ObjectId(), path: '/keep-this', actor: null, deletedAt: new Date(), mode: 'user_hard_delete' },
    ]);

    const logSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    let res;
    let logCalls: unknown[][] = [];
    try {
      res = await request(app).delete('/api/admin/page-deletions').set(authHeaders(adminToken)).send({ path: '/erase-this' });
      logCalls = logSpy.mock.calls.map((args) => [...args]);
    } finally {
      logSpy.mockRestore();
    }
    const logged = logCalls.map((args) => args.join(' ')).join('\n');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deletedCount: 2 });
    expect(await PageDeletionRecord.countDocuments({ path: '/erase-this' })).toBe(0);
    expect(await PageDeletionRecord.countDocuments({ path: '/keep-this' })).toBe(1);
    expect(logged).toContain(adminId);
    expect(logged).toContain('path=/erase-this');
    expect(logged).not.toContain('/keep-this');
  });

  it('rejects an erase request without a record or path selector', async () => {
    const sentinel = await PageDeletionRecord.create({
      pageId: new Types.ObjectId(),
      path: '/keep-on-invalid-erase',
      actor: null,
      deletedAt: new Date(),
      mode: 'user_hard_delete',
    });

    const res = await request(app).delete('/api/admin/page-deletions').set(authHeaders(adminToken)).send({});

    expect(res.status).toBe(400);
    expect(await PageDeletionRecord.exists({ _id: sentinel._id })).not.toBeNull();
  });
});
