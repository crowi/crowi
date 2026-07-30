import request from 'supertest';
import { app, crowi } from 'src/test/setup';
import type { UserModel } from 'src/models/user';

/**
 * feature-user-identity-uniqueness §d — the unique index is the final defence
 * behind the per-path `findOne` pre-checks. This exercises the E11000 → 409
 * mapping on representative write paths without a fragile real race.
 *
 * Trick: the pre-check `findOne` is case-SENSITIVE, but the unique index is
 * case-INSENSITIVE (collation strength 2). Registering `Foo@…` while
 * `foo@…` exists therefore slips past the pre-check and is caught by the index
 * — a deterministic stand-in for the concurrent-insert race the index guards.
 */

describe('uniqueness E11000 mapping (Hono write paths)', () => {
  const User = () => crowi.model('User') as UserModel;
  const Config = () => crowi.model('Config');

  beforeAll(async () => {
    await (User() as UserModel).createIndexes();
    await Config().deleteMany({ ns: 'crowi' });
    await (Config() as { applicationInstall: () => Promise<unknown> }).applicationInstall();
    await crowi.getConfigService().load();
  });

  afterAll(async () => {
    await User().deleteMany({ email: { $regex: /e11000test/i } });
    await Config().deleteMany({ ns: 'crowi' });
    await crowi.getConfigService().load();
  });

  it('register: case-only email collision returns 409 EMAIL_TAKEN (not 500)', async () => {
    await new (User() as UserModel)({
      name: 'Existing',
      username: 'e11000test-existing',
      email: 'lower-e11000test@example.com',
      status: User().STATUS_ACTIVE,
    }).save();

    const res = await request(app)
      .post('/api/auth/register')
      // Same address, different case — misses the case-sensitive pre-check,
      // hits the case-insensitive unique index.
      .send({ name: 'New', username: 'e11000test-new', email: 'Lower-e11000test@example.com', password: 'Password!1' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('register: case-only username collision returns 409 USERNAME_TAKEN (not 500)', async () => {
    await new (User() as UserModel)({
      name: 'Existing',
      username: 'E11000test-Name',
      email: 'name-existing-e11000test@example.com',
      status: User().STATUS_ACTIVE,
    }).save();

    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New', username: 'e11000test-name', email: 'name-new-e11000test@example.com', password: 'Password!1' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('USERNAME_TAKEN');
  });
});
