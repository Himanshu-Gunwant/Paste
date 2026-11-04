import type { PasteRevision } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';

/** Snapshot revision reads (Phase 3) — writes live in paste.repository (tx-shared). */
export const revisionRepository = {
  /** Metadata only — content loads via findByNo. */
  listForPaste(pasteId: string): Promise<Omit<PasteRevision, 'content'>[]> {
    return prisma.pasteRevision.findMany({
      where: { pasteId },
      orderBy: { revisionNo: 'desc' },
      select: {
        id: true,
        pasteId: true,
        revisionNo: true,
        title: true,
        description: true,
        language: true,
        contentSize: true,
        editorId: true,
        createdAt: true,
      },
    });
  },

  findByNo(pasteId: string, revisionNo: number): Promise<PasteRevision | null> {
    return prisma.pasteRevision.findUnique({
      where: { pasteId_revisionNo: { pasteId, revisionNo } },
    });
  },

  countForPaste(pasteId: string): Promise<number> {
    return prisma.pasteRevision.count({ where: { pasteId } });
  },
};
