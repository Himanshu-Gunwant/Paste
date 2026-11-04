import { createTwoFilesPatch } from 'diff';
import { MAX_REVISIONS_PER_PASTE } from '../config/constants.js';
import { AppError } from '../lib/errors.js';
import { sha256Hex } from './hash.js';
import { revisionRepository } from '../repositories/revision.repository.js';
import { pasteRepository } from '../repositories/paste.repository.js';
import { prisma } from '../lib/prisma.js';
import { requireManageable } from './paste.service.js';
import { authorizePasteRead, type GetPasteOptions } from './paste.service.js';
import type { PasteWithAuthor } from './paste.service.js';
import type { AuthContext } from '../types/auth.js';

/**
 * Revision reads and restore (docs/ARCHITECTURE.md §4 E, §11).
 * Visibility: revisions are readable by anyone who can read the paste —
 * full policy + password gate, but NEVER consuming burns or counting views.
 * Restore is append-only: copying an old snapshot appends a NEW revision.
 */

export async function listRevisions(
  idOrSlug: string,
  auth: AuthContext,
  options: GetPasteOptions = {},
): Promise<{ paste: PasteWithAuthor; data: Awaited<ReturnType<typeof revisionRepository.listForPaste>> }> {
  const { paste } = await authorizePasteRead(idOrSlug, auth, options);
  const data = await revisionRepository.listForPaste(paste.id);
  return { paste, data };
}

export async function getRevision(
  idOrSlug: string,
  revisionNo: number,
  auth: AuthContext,
  options: GetPasteOptions = {},
): Promise<{ paste: PasteWithAuthor; revision: NonNullable<Awaited<ReturnType<typeof revisionRepository.findByNo>>> }> {
  const { paste } = await authorizePasteRead(idOrSlug, auth, options);
  const revision = await revisionRepository.findByNo(paste.id, revisionNo);
  if (!revision) throw AppError.notFound('Revision not found');
  return { paste, revision };
}

export interface RevisionDiff {
  from: number;
  to: number;
  diff: string;
}

export async function diffRevisions(
  idOrSlug: string,
  fromNo: number,
  toNo: number,
  auth: AuthContext,
  options: GetPasteOptions = {},
): Promise<{ paste: PasteWithAuthor; diff: RevisionDiff }> {
  const { paste } = await authorizePasteRead(idOrSlug, auth, options);
  if (fromNo === toNo) throw AppError.validation('from and to revisions must differ');
  const from = await revisionRepository.findByNo(paste.id, fromNo);
  const to = await revisionRepository.findByNo(paste.id, toNo);
  if (!from || !to) throw AppError.notFound('Revision not found');

  const patch = createTwoFilesPatch(
    `revision-${from.revisionNo}`,
    `revision-${to.revisionNo}`,
    from.content,
    to.content,
    undefined,
    undefined,
    { context: 3 },
  );
  return { paste, diff: { from: from.revisionNo, to: to.revisionNo, diff: patch } };
}

export async function restoreRevision(
  idOrSlug: string,
  revisionNo: number,
  auth: AuthContext,
  managementToken?: string,
): Promise<{ paste: PasteWithAuthor; restored: boolean }> {
  const paste = await requireManageable(idOrSlug, auth, managementToken);
  const revision = await revisionRepository.findByNo(paste.id, revisionNo);
  if (!revision) throw AppError.notFound('Revision not found');

  const metadataUnchanged =
    (revision.title ?? null) === paste.title &&
    (revision.description ?? null) === paste.description &&
    (revision.language ?? null) === paste.language;
  if (sha256Hex(revision.content) === paste.contentHash && metadataUnchanged) {
    return { paste, restored: false }; // already identical — no history noise
  }

  const nextNo = paste.latestRevisionNo + 1;
  const editorId = auth.kind === 'anonymous' ? null : auth.user.id;
  const updated = await prisma.$transaction(async (tx) => {
    const result = await pasteRepository.update(
      paste.id,
      {
        content: revision.content,
        contentSize: revision.contentSize,
        contentHash: sha256Hex(revision.content),
        title: revision.title,
        description: revision.description,
        language: revision.language,
        latestRevisionNo: nextNo,
      },
      tx,
    );
    await pasteRepository.createRevision(
      {
        pasteId: paste.id,
        revisionNo: nextNo,
        title: revision.title,
        description: revision.description,
        language: revision.language,
        content: revision.content,
        contentSize: revision.contentSize,
        editorId,
      },
      tx,
    );
    if (nextNo > MAX_REVISIONS_PER_PASTE) {
      await pasteRepository.deleteRevision(paste.id, nextNo - MAX_REVISIONS_PER_PASTE, tx);
    }
    return result;
  });
  const fresh = await pasteRepository.findByIdOrSlug(paste.id);
  return { paste: fresh ?? (updated as PasteWithAuthor), restored: true };
}
