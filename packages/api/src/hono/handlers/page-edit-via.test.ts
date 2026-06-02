import request from 'supertest';

import { app, crowi } from 'src/test/setup';
import type { UserDocument } from 'src/models/user';
import { createJwtUtil } from 'src/util/jwt';

/**
 * RFC-0010 — a revision records the channel it was authored through
 * (`editVia`: web / oauth / pat) so the history view can flag API-token
 * edits. This walks the full chain: handler reads `authContext.kind` →
 * `Page.{create,update}Page` → `Revision.prepareRevision` → list response.
 */
const seedUser = (suffix: string) =>
  new Promise<UserDocument>((resolve, reject) => {
    const User = crowi.model('User');
    User.createUserByEmailAndPassword(
      `Via ${suffix}`,
      `via-${suffix}`,
      `via-${suffix}@example.com`,
      'password123',
      'en',
      async (err: Error | null, user: UserDocument) => {
        if (err) return reject(err);
        user.status = User.STATUS_ACTIVE;
        await user.save();
        resolve(user);
      },
    );
  });

const latestRevisionEditVia = async (token: string, pageId: string): Promise<string | undefined> => {
  const res = await request(app).get(`/api/v2/pages/${pageId}/revisions`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.revisions[0]?.editVia;
};

describe('RFC-0010 — revision editVia (history "app" chip)', () => {
  it('records editVia=oauth for an OAuth-token edit and exposes it in the revision list', async () => {
    const user = await seedUser('oauth');
    const jwt = createJwtUtil(crowi);
    const oauthToken = jwt.signOauthAccessToken({ user, scopes: ['pages:read', 'pages:write'], clientId: 'crowi-cli' });

    const create = await request(app).post('/api/v2/pages').set('Authorization', `Bearer ${oauthToken}`).send({ path: '/via-oauth', body: '# via oauth' });
    expect(create.status).toBe(200);
    const pageId = create.body.page._id as string;

    expect(await latestRevisionEditVia(oauthToken, pageId)).toBe('oauth');

    // A subsequent external edit on the same page also records oauth.
    const revisionId = create.body.page.revision._id as string;
    const update = await request(app)
      .put('/api/v2/pages')
      .set('Authorization', `Bearer ${oauthToken}`)
      .send({ page_id: pageId, revision_id: revisionId, body: '# via oauth v2' });
    expect(update.status).toBe(200);
    expect(await latestRevisionEditVia(oauthToken, pageId)).toBe('oauth');
  });

  it('records editVia=web for a browser-session edit (no chip)', async () => {
    const user = await seedUser('web');
    const webToken = createJwtUtil(crowi).generateTokens(user).accessToken;

    const create = await request(app).post('/api/v2/pages').set('Authorization', `Bearer ${webToken}`).send({ path: '/via-web', body: '# via web' });
    expect(create.status).toBe(200);
    const pageId = create.body.page._id as string;

    expect(await latestRevisionEditVia(webToken, pageId)).toBe('web');
  });
});
