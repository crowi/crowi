import { createHash, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';

import Crowi from 'src/crowi';
import type { PageDocument, RenameTreeResult } from 'src/models/page';
import type { PageHistoryEventSource } from 'src/models/page-history-event';
import type { PageHistoryOperationDocument } from 'src/models/page-history-operation';
import { mapWithConcurrency, RENAME_TREE_CONCURRENCY } from 'src/util/map-with-concurrency';

import {
  type StrandedTransitionAction,
  completeOperation,
  createPageHistoryOperation,
  deriveMemberKey,
  hasOperationCompletionEvidence,
  resolvePageHistoryOperation,
} from '../operation';
import { type ResumeExpectation, classifyResume } from '../transition';
import { renamePageCommand } from './rename';

export interface SubtreeRenameInput {
  page: PageDocument | null;
  pageId: Types.ObjectId | null;
  memberPages?: PageDocument[];
  fromPath?: string;
  toPath: string;
  actor: Types.ObjectId | null;
  user: unknown;
  source: PageHistoryEventSource;
  idempotencyKey: string;
  requestFingerprint: string;
  createRedirectPage: boolean;
}

export type SubtreeRenameOutcome =
  | { status: 'fingerprint-mismatch'; operation: PageHistoryOperationDocument }
  | ({ status: 'completed'; operation: PageHistoryOperationDocument; replayed: boolean } & RenameTreeResult);

type MemberOutcome = { ok: true; page: PageDocument } | { ok: false; oldPath: string; error: string };

export { deriveMemberKey } from '../operation';

const memberFailure = (oldPath: string): MemberOutcome => ({ ok: false, oldPath, error: `Failed to update page (${oldPath}).` });

async function outcomeFromSettledMember(
  crowi: Crowi,
  pageId: Types.ObjectId,
  oldPath: string,
  operation: PageHistoryOperationDocument,
  preferredPage?: PageDocument,
): Promise<MemberOutcome> {
  if (operation.result?.status !== 'succeeded') return memberFailure(oldPath);
  const page = preferredPage ?? ((await crowi.model('Page').findById(pageId).exec()) as PageDocument | null);
  return page == null ? memberFailure(oldPath) : { ok: true, page };
}

/**
 * The last thing either of `outcomeFromCurrentMember`'s two callers (the
 * `incomplete` branch and the `catch` around a mid-flight exception) does
 * before giving up on a member. It must not report failure on `result ==
 * null` alone: the grouped `PageHistoryEvent` — not `PageHistoryOperation.result`
 * — is the durable proof a move landed, and the two are separate writes with
 * a window between them (RFC-0021 "Member result authority"). Delegating to
 * `settleMemberFailureFromDurableState` (which checks that evidence first)
 * makes this invariant hold regardless of how many call sites there are.
 */
async function outcomeFromCurrentMember(
  crowi: Crowi,
  pageId: Types.ObjectId,
  oldPath: string,
  key: { actor: Types.ObjectId | null; command: 'subtree_rename_member'; idempotencyKey: string },
): Promise<MemberOutcome> {
  let operation: PageHistoryOperationDocument | null;
  try {
    operation = (await crowi.model('PageHistoryOperation').findOne(key).exec()) as PageHistoryOperationDocument | null;
  } catch {
    // A failed reconciliation read is still not evidence that the member can
    // be settled. The repair sweep will classify its durable state later.
    return memberFailure(oldPath);
  }
  if (operation == null) return memberFailure(oldPath);
  if (operation.result != null) return outcomeFromSettledMember(crowi, pageId, oldPath, operation);
  return settleMemberFailureFromDurableState(crowi, pageId, oldPath, operation);
}

const expectationFromMember = (operation: PageHistoryOperationDocument): ResumeExpectation => ({
  operationId: operation.operationId,
  fromPath: operation.fromPath ?? '',
  toPath: operation.toPath ?? '',
  fromStatus: operation.fromStatus ?? null,
  fromStatusPresent: operation.fromStatusPresent === true,
  toStatus: operation.toStatus ?? null,
});

async function settleMemberFailureFromDurableState(
  crowi: Crowi,
  pageId: Types.ObjectId,
  oldPath: string,
  operation: PageHistoryOperationDocument,
): Promise<MemberOutcome> {
  if (await hasOperationCompletionEvidence(crowi, operation)) {
    const settled = await completeOperation(crowi, operation.operationId, { status: 'succeeded' });
    return outcomeFromSettledMember(crowi, pageId, oldPath, settled);
  }
  const page = (await crowi.model('Page').findById(pageId).exec()) as PageDocument | null;
  const decision = classifyResume(page, expectationFromMember(operation));

  switch (decision.decision) {
    case 'page-missing':
      await completeOperation(crowi, operation.operationId, { status: 'moot' });
      return memberFailure(oldPath);
    case 'already-settled':
    case 'not-entered':
    case 'resume-own':
    case 'owned-elsewhere':
    case 'indeterminate':
      return memberFailure(oldPath);
  }
}

async function clearDestination(crowi: Crowi, pageId: Types.ObjectId, toPath: string, user: unknown): Promise<boolean> {
  const Page = crowi.model('Page');
  const occupant = (await Page.findOne({ path: toPath }).exec()) as PageDocument | null;
  if (occupant == null || occupant._id.equals(pageId)) return true;
  if (!occupant.isUnlinkable(user)) return false;
  try {
    await occupant.unlink(user);
    return true;
  } catch {
    return false;
  }
}

async function executeMember(
  crowi: Crowi,
  root: PageHistoryOperationDocument,
  input: SubtreeRenameInput,
  pageId: Types.ObjectId,
  fromPath: string,
  toPath: string,
  moveAllowed = true,
): Promise<MemberOutcome> {
  const Page = crowi.model('Page');
  const key = {
    actor: input.actor,
    command: 'subtree_rename_member' as const,
    idempotencyKey: deriveMemberKey(input.idempotencyKey, pageId),
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ pageId: String(pageId), fromPath, toPath }))
    .digest('hex');
  let resolution = await resolvePageHistoryOperation(crowi, key, fingerprint);
  let operation: PageHistoryOperationDocument;
  let createdFromMiss = false;

  if (resolution.kind === 'miss') {
    const page = (await Page.findById(pageId).exec()) as PageDocument | null;
    const created = await createPageHistoryOperation(crowi, {
      ...key,
      operationId: randomUUID(),
      requestFingerprint: fingerprint,
      page: pageId,
      fromPath,
      toPath,
      fromStatus: page?.status ?? null,
      fromStatusPresent: page?.status != null,
      toStatus: page?.status ?? null,
      createRedirect: !toPath.endsWith('/') && input.createRedirectPage,
      source: input.source,
    });
    if (created.kind === 'created') {
      operation = created.operation;
      createdFromMiss = true;
    } else {
      resolution = created.resolution;
      if (resolution.kind === 'fingerprint-mismatch') return memberFailure(fromPath);
      if (resolution.kind === 'miss') throw new Error('The winning subtree member operation disappeared before it could be read.');
      operation = resolution.operation;
    }
  } else {
    if (resolution.kind === 'fingerprint-mismatch') return memberFailure(fromPath);
    operation = resolution.operation;
  }

  if (operation.result != null) {
    return outcomeFromSettledMember(crowi, pageId, operation.fromPath ?? fromPath, operation);
  }

  const durableFromPath = operation.fromPath ?? fromPath;
  const durableToPath = operation.toPath ?? toPath;
  if (!moveAllowed) {
    return settleMemberFailureFromDurableState(crowi, pageId, durableFromPath, operation);
  }

  if (createdFromMiss && !(await clearDestination(crowi, pageId, durableToPath, input.user))) {
    return settleMemberFailureFromDurableState(crowi, pageId, durableFromPath, operation);
  }

  const page = (await Page.findById(pageId).exec()) as PageDocument | null;
  if (page == null) {
    return settleMemberFailureFromDurableState(crowi, pageId, durableFromPath, operation);
  }
  const outcome = await renamePageCommand(crowi, {
    page,
    fromPath: durableFromPath,
    toPath: durableToPath,
    fromStatus: operation.fromStatus ?? null,
    fromStatusPresent: operation.fromStatusPresent === true,
    operationId: operation.operationId,
    eventOperationId: root.groupOperationId,
    subtree: true,
    actor: operation.actor,
    user: input.user,
    source: operation.source ?? input.source,
    createRedirectPage: operation.createRedirect === true,
  });
  if (
    (outcome.status === 'committed' || outcome.status === 'already-settled') &&
    (await hasOperationCompletionEvidence(crowi, operation, { eventOperationId: root.groupOperationId }))
  ) {
    const settled = await completeOperation(crowi, operation.operationId, { status: 'succeeded' });
    return outcomeFromSettledMember(crowi, pageId, durableFromPath, settled, outcome.page);
  }
  if (outcome.status !== 'incomplete') {
    return settleMemberFailureFromDurableState(crowi, pageId, durableFromPath, operation);
  }
  return outcomeFromCurrentMember(crowi, pageId, durableFromPath, key);
}

async function createRoot(crowi: Crowi, input: SubtreeRenameInput): Promise<PageHistoryOperationDocument | SubtreeRenameOutcome> {
  const Page = crowi.model('Page');
  let members = input.memberPages;
  if (members == null) {
    if (input.page == null) throw new Error('A first subtree delivery requires its member pages.');
    const oldRoot = input.page.path;
    const descendantRoot = oldRoot.endsWith('/') ? oldRoot : `${oldRoot}/`;
    const selfPaths = new Set([oldRoot, oldRoot.replace(/\/+$/, '')]);
    const subtree = (await Page.findListByStartWith(descendantRoot, input.user, { limit: 0 })) as PageDocument[];
    members = [input.page, ...subtree.filter((page) => !selfPaths.has(page.path))];
  }
  const operationId = randomUUID();
  const created = await createPageHistoryOperation(crowi, {
    actor: input.actor,
    command: 'subtree_rename',
    idempotencyKey: input.idempotencyKey,
    operationId,
    requestFingerprint: input.requestFingerprint,
    memberPageIds: members.map((page) => page._id),
    groupOperationId: randomUUID(),
  });
  if (created.kind === 'created') return created.operation;
  if (created.resolution.kind === 'fingerprint-mismatch') return { status: 'fingerprint-mismatch', operation: created.resolution.operation };
  if (created.resolution.kind === 'miss') throw new Error('The winning subtree root operation disappeared before it could be read.');
  return created.resolution.operation;
}

export async function subtreeRenameCommand(crowi: Crowi, input: SubtreeRenameInput): Promise<SubtreeRenameOutcome> {
  const Page = crowi.model('Page');
  const rootKey = { actor: input.actor, command: 'subtree_rename', idempotencyKey: input.idempotencyKey };
  const initial = await resolvePageHistoryOperation(crowi, rootKey, input.requestFingerprint);
  if (initial.kind === 'fingerprint-mismatch') return { status: 'fingerprint-mismatch', operation: initial.operation };

  const replayed = initial.kind !== 'miss';
  const rootOrOutcome = initial.kind === 'miss' ? await createRoot(crowi, input) : initial.operation;
  if ('status' in rootOrOutcome) return rootOrOutcome;
  const root = rootOrOutcome;
  const memberIds = root.memberPageIds ?? [];

  const existingRootMember =
    input.pageId == null
      ? null
      : ((await crowi
          .model('PageHistoryOperation')
          .findOne({ actor: input.actor, command: 'subtree_rename_member', idempotencyKey: deriveMemberKey(input.idempotencyKey, input.pageId) })
          // Primary: this feeds the same from/to fallback chain as the member
          // fan-out's own lookup below, so a lagging secondary read here would
          // be just as wrong.
          .read('primary')
          .exec()) as PageHistoryOperationDocument | null);
  const oldRoot = existingRootMember?.fromPath ?? input.fromPath ?? input.page?.path;
  if (oldRoot == null) throw new Error('The subtree root path is unavailable before its first member record was created.');
  const newRoot = existingRootMember?.toPath ?? input.toPath;
  const oldBase = oldRoot.replace(/\/+$/, '');
  const newBase = newRoot.replace(/\/+$/, '');

  const outcomes = await mapWithConcurrency(memberIds, RENAME_TREE_CONCURRENCY, async (pageId) => {
    const key = { actor: input.actor, command: 'subtree_rename_member' as const, idempotencyKey: deriveMemberKey(input.idempotencyKey, pageId) };
    let fromPath = oldRoot;
    try {
      // Page before operation: whichever side of a concurrent enter CAS this
      // read lands on, it is either still pre-move (used as-is below) or the
      // operation the CAS's own creator already wrote wins instead — either
      // way this never derives a moved-to-moved path pair from a stale peek.
      const page = (await Page.findById(pageId).exec()) as PageDocument | null;
      // Primary: this row feeds the fingerprint computed below, so a lagging
      // secondary read could still hand back a miss for a row just written.
      const existing = (await crowi.model('PageHistoryOperation').findOne(key).read('primary').exec()) as PageHistoryOperationDocument | null;
      fromPath = existing?.fromPath ?? page?.path ?? oldRoot;
      const isRoot = input.pageId != null && String(pageId) === String(input.pageId);
      const derivedToPath = isRoot ? newRoot : deriveDestinationPath(fromPath, oldBase, newBase);
      const moveAllowed = existing != null || derivedToPath != null;
      const toPath = existing?.toPath ?? derivedToPath ?? fromPath;
      return await executeMember(crowi, root, input, pageId, fromPath, toPath, moveAllowed);
    } catch {
      return outcomeFromCurrentMember(crowi, pageId, fromPath, key);
    }
  });

  const successes: PageDocument[] = [];
  const failures: { oldPath: string; error: string }[] = [];
  for (const outcome of outcomes) {
    if (outcome.ok) successes.push(outcome.page);
    else failures.push({ oldPath: outcome.oldPath, error: outcome.error });
  }
  await settleSubtreeRootAfterMember(crowi, root);
  const settledRoot = (await crowi.model('PageHistoryOperation').findById(root._id).exec()) as PageHistoryOperationDocument;
  return { status: 'completed', operation: settledRoot, replayed, successes, failures };
}

export async function resumeSubtreeMemberCommand(crowi: Crowi, operation: PageHistoryOperationDocument): Promise<StrandedTransitionAction> {
  const root = await findSubtreeRootForMember(crowi, operation);
  if (operation.page == null || root?.groupOperationId == null) return 'blocked';

  const Page = crowi.model('Page');
  const page = (await Page.findById(operation.page).exec()) as PageDocument | null;
  if (page == null || operation.fromPath == null || operation.toPath == null) return 'blocked';
  const outcome = await renamePageCommand(crowi, {
    page,
    fromPath: operation.fromPath,
    toPath: operation.toPath,
    fromStatus: operation.fromStatus ?? null,
    fromStatusPresent: operation.fromStatusPresent === true,
    operationId: operation.operationId,
    eventOperationId: root.groupOperationId,
    subtree: true,
    actor: operation.actor,
    user: operation.actor,
    source: operation.source ?? 'system',
    createRedirectPage: operation.createRedirect === true,
  });
  if (outcome.status !== 'committed' && outcome.status !== 'already-settled') return 'blocked';
  if (!(await hasOperationCompletionEvidence(crowi, operation, { eventOperationId: root.groupOperationId }))) return 'blocked';

  const settledMember = await completeOperation(crowi, operation.operationId, { status: 'succeeded' });
  if (settledMember.result?.status === 'succeeded') await settleSubtreeRootAfterMember(crowi, operation);
  return 'resumed';
}

async function findSubtreeRootForMember(crowi: Crowi, operation: PageHistoryOperationDocument): Promise<PageHistoryOperationDocument | null> {
  if (operation.page == null) return null;
  const roots = (await crowi
    .model('PageHistoryOperation')
    .find({ actor: operation.actor, command: 'subtree_rename', memberPageIds: operation.page })
    .exec()) as PageHistoryOperationDocument[];
  return roots.find((candidate) => deriveMemberKey(candidate.idempotencyKey, operation.page as Types.ObjectId) === operation.idempotencyKey) ?? null;
}

export async function settleSubtreeRootAfterMember(crowi: Crowi, operation: PageHistoryOperationDocument): Promise<boolean> {
  const root = operation.command === 'subtree_rename' ? operation : await findSubtreeRootForMember(crowi, operation);
  if (root == null) return false;
  const memberKeys = (root.memberPageIds ?? []).map((pageId) => deriveMemberKey(root.idempotencyKey, pageId));
  if (memberKeys.length === 0) return false;
  const finishedMembers = await crowi.model('PageHistoryOperation').countDocuments({
    actor: root.actor,
    command: 'subtree_rename_member',
    idempotencyKey: { $in: memberKeys },
    'result.status': { $in: ['succeeded', 'failed', 'moot'] },
  });
  if (finishedMembers !== memberKeys.length) return false;
  await completeOperation(crowi, root.operationId, { status: 'succeeded' });
  return true;
}

function deriveDestinationPath(fromPath: string, oldBase: string, newBase: string): string | null {
  if (fromPath === oldBase) return newBase;
  const descendantPrefix = `${oldBase}/`;
  return fromPath.startsWith(descendantPrefix) ? `${newBase}${fromPath.slice(oldBase.length)}` : null;
}
