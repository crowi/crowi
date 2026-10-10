import { faker } from '@faker-js/faker';
import mongoose from 'mongoose';
import { ArtifactInternalError } from 'src/artifact/ingest';
import { seedStoredArtifactPage } from 'src/test/artifact-fixtures';
import { crowi, Fixture, randomUsername } from 'src/test/setup';
import { getRawRevisionPointer, resolveCurrentPageBodyKind } from './page-body-write';

describe('page-body-write (R-1 current body kind resolver)', () => {
  let Page;
  let Revision;
  let user;

  beforeAll(async () => {
    Page = crowi.model('Page');
    Revision = crowi.model('Revision');
    const users = await Fixture.generate('User', [{ name: faker.person.fullName(), username: randomUsername(), email: faker.internet.email() }]);
    user = users[0];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const newPage = (suffix: string) =>
    Page.create({
      path: `/page-body-write-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      creator: user._id,
      lastUpdateUser: user._id,
      grant: 1,
      status: 'published',
      grantedUsers: [user._id],
    });

  const pageWithMarkdownRevision = async (suffix: string) => {
    const page = await newPage(suffix);
    const revision = await Revision.prepareRevision(page, 'body', user, { contentType: 'markdown' });
    await Page.pushRevision(page, revision, user);
    return { pageId: page._id, revisionId: revision._id };
  };

  test('a pointerless Page resolves to markdown with no revision id', async () => {
    const page = await newPage('pointerless');
    expect(getRawRevisionPointer(page)).toBeNull();
    await expect(resolveCurrentPageBodyKind(crowi, page, null)).resolves.toEqual({ revisionId: null, contentType: 'markdown' });
  });

  test('a populated Revision is read without any additional query', async () => {
    const { pageId, revisionId } = await pageWithMarkdownRevision('populated');
    const page = await Page.findById(pageId).populate('revision');
    const findById = jest.spyOn(Revision, 'findById');

    const raw = getRawRevisionPointer(page);
    expect(String(raw)).toBe(String(revisionId));
    await expect(resolveCurrentPageBodyKind(crowi, page, raw)).resolves.toEqual({ revisionId: String(revisionId), contentType: 'markdown' });
    expect(findById).not.toHaveBeenCalled();
  });

  test('an unpopulated pointer costs exactly one metadata query and never reads the body', async () => {
    const { pageId, revisionId } = await pageWithMarkdownRevision('raw');
    const page = await Page.findById(pageId);
    const findById = jest.spyOn(Revision, 'findById');
    const select = jest.spyOn(mongoose.Query.prototype, 'select');

    const raw = getRawRevisionPointer(page);
    expect(String(raw)).toBe(String(revisionId));
    await expect(resolveCurrentPageBodyKind(crowi, page, raw)).resolves.toEqual({ revisionId: String(revisionId), contentType: 'markdown' });
    expect(findById).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith('_id contentType');
  });

  test('a populate that dropped contentType from its projection falls back to a metadata query instead of reading legacy markdown', async () => {
    const { pageId } = await seedStoredArtifactPage({ path: `/page-body-write-projection-${Date.now()}`, body: '<html></html>', userId: user._id });
    const page = await Page.findById(pageId).populate({ path: 'revision', select: 'path body' });
    const raw = getRawRevisionPointer(page);
    await expect(resolveCurrentPageBodyKind(crowi, page, raw)).resolves.toMatchObject({ contentType: 'artifact' });
  });

  test('a Revision stored without contentType is legacy markdown', async () => {
    const { pageId, revisionId } = await pageWithMarkdownRevision('legacy');
    await Revision.collection.updateOne({ _id: revisionId }, { $unset: { contentType: '' } });
    const page = await Page.findById(pageId);
    await expect(resolveCurrentPageBodyKind(crowi, page, getRawRevisionPointer(page))).resolves.toEqual({
      revisionId: String(revisionId),
      contentType: 'markdown',
    });
  });

  test('an artifact Revision resolves to artifact regardless of the Page hint', async () => {
    const { pageId } = await seedStoredArtifactPage({
      path: `/page-body-write-artifact-${Date.now()}`,
      body: '<html></html>',
      userId: user._id,
      pageContentType: null,
    });
    const page = await Page.findById(pageId);
    await expect(resolveCurrentPageBodyKind(crowi, page, getRawRevisionPointer(page))).resolves.toMatchObject({ contentType: 'artifact' });
  });

  test('a dangling pointer is an internal error, also after a populate that comes back empty', async () => {
    const page = await newPage('dangling');
    const missing = new mongoose.Types.ObjectId();
    await Page.collection.updateOne({ _id: page._id }, { $set: { revision: missing } });

    const unpopulated = await Page.findById(page._id);
    await expect(resolveCurrentPageBodyKind(crowi, unpopulated, getRawRevisionPointer(unpopulated))).rejects.toThrow(ArtifactInternalError);

    const populated = await Page.findById(page._id).populate('revision');
    expect(populated.revision).toBeNull();
    // The raw pointer survives the empty populate, so it is never mistaken for "no pointer".
    expect(String(getRawRevisionPointer(populated))).toBe(String(missing));
    await expect(resolveCurrentPageBodyKind(crowi, populated, getRawRevisionPointer(populated))).rejects.toThrow(ArtifactInternalError);
  });

  test.each([
    ['null', null],
    ['an unknown kind', 'rogue'],
  ])('a stored contentType of %s is an internal error, not markdown', async (_label, stored) => {
    const { pageId, revisionId } = await pageWithMarkdownRevision('invalid-kind');
    await Revision.collection.updateOne({ _id: revisionId }, { $set: { contentType: stored } });
    const page = await Page.findById(pageId);
    await expect(resolveCurrentPageBodyKind(crowi, page, getRawRevisionPointer(page))).rejects.toThrow(ArtifactInternalError);
  });

  test('a populated Revision whose id differs from the raw pointer is an internal error', async () => {
    const { pageId } = await pageWithMarkdownRevision('mismatch');
    const page = await Page.findById(pageId).populate('revision');
    await expect(resolveCurrentPageBodyKind(crowi, page, new mongoose.Types.ObjectId())).rejects.toThrow(ArtifactInternalError);
  });
});
