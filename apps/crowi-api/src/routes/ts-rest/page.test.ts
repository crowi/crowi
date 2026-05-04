import request from 'supertest';
import { app, crowi, Fixture } from 'src/test/setup';
import { createJwtUtil } from 'src/util/jwt';

describe('Routes /api/v2/pages (ts-rest createPage)', () => {
  let User;
  let Page;
  let Revision;
  let testUser;
  let accessToken: string;

  beforeAll(async () => {
    User = crowi.model('User');
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');

    const userFixture = [{ name: 'CreatePage Test', username: 'createPageTester', email: 'create-page-tester@example.com' }];
    const users = await Fixture.generate('User', userFixture);
    testUser = users[0];

    // Force user to active so jwtAuth allows it through.
    testUser.status = User.STATUS_ACTIVE;
    await testUser.save();

    const jwtUtil = createJwtUtil(crowi);
    const tokens = jwtUtil.generateTokens(testUser);
    accessToken = tokens.accessToken;
  });

  afterEach(async () => {
    // Clean up pages and revisions created by tests so each test starts clean.
    await Page.deleteMany({ path: { $regex: '^/ts-rest-create-test/' } });
    await Revision.deleteMany({ path: { $regex: '^/ts-rest-create-test/' } });
  });

  describe('POST /api/v2/pages', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/v2/pages')
        .send({ path: '/ts-rest-create-test/no-auth', body: '# hello' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('creates a new page when authenticated and returns 200 with the page', async () => {
      const path = '/ts-rest-create-test/basic';
      const body = '# created via ts-rest';

      const res = await request(app)
        .post('/api/v2/pages')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Content-Type', 'application/json')
        .send({ path, body });

      expect(res.status).toBe(200);
      expect(res.body.page).toBeDefined();
      expect(res.body.page.path).toBe(path);
      expect(res.body.page._id).toBeDefined();
      // creator should be populated to a user object since populatePageData runs after create.
      expect(res.body.page.creator).toBeDefined();
      expect(res.body.page.creator.username).toBe('createPageTester');
      // revision should be populated and contain the body we sent.
      expect(res.body.page.revision).toBeDefined();
      expect(res.body.page.revision.body).toBe(body);
      expect(res.body.page.revision.author).toBeDefined();
      expect(res.body.page.revision.author.username).toBe('createPageTester');

      // Verify Page + Revision were both written to MongoDB and linked.
      const pageDoc = await Page.findOne({ path });
      expect(pageDoc).not.toBeNull();
      expect(pageDoc.revision).toBeDefined();
      const revisionDoc = await Revision.findById(pageDoc.revision);
      expect(revisionDoc).not.toBeNull();
      expect(revisionDoc.body).toBe(body);
      expect(revisionDoc.path).toBe(path);
    });

    it('returns 400 PAGE_EXISTS when posting to an existing path twice', async () => {
      const path = '/ts-rest-create-test/duplicate';
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      };

      const first = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# first' });
      expect(first.status).toBe(200);

      const second = await request(app).post('/api/v2/pages').set(headers).send({ path, body: '# second' });
      expect(second.status).toBe(400);
      expect(second.body.error.code).toBe('PAGE_EXISTS');
    });
  });
});
