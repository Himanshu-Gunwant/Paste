import { AppError } from '../lib/errors.js';
import { bookmarkRepository } from '../repositories/bookmark.repository.js';
import { pasteRepository } from '../repositories/paste.repository.js';
import { authorizePasteView } from './access-policy.js';
import type { AuthContext } from '../types/auth.js';

/**
 * Bookmarks (docs/ARCHITECTURE.md §4 F): private read-later list, idempotent
 * PUT, viewability-gated add (you cannot bookmark what you cannot see).
 */
export async function addBookmark(idOrSlug: string, auth: AuthContext): Promise<void> {
  if (auth.kind === 'anonymous') throw AppError.unauthorized();
  const paste = await pasteRepository.findByIdOrSlug(idOrSlug);
  if (!paste) throw AppError.notFound();
  const decision = authorizePasteView(paste, { auth });
  if (decision.outcome !== 'ALLOW') throw AppError.notFound();
  await bookmarkRepository.add(auth.user.id, paste.id);
}

export async function removeBookmark(idOrSlug: string, auth: AuthContext): Promise<void> {
  if (auth.kind === 'anonymous') throw AppError.unauthorized();
  const paste = await pasteRepository.findByIdOrSlug(idOrSlug);
  if (!paste) throw AppError.notFound();
  await bookmarkRepository.remove(auth.user.id, paste.id); // idempotent
}

export async function listBookmarks(auth: AuthContext): Promise<
  { pasteId: string; title: string | null; language: string | null; createdAt: Date; addedAt: Date }[]
> {
  if (auth.kind === 'anonymous') throw AppError.unauthorized();
  const bookmarks = await bookmarkRepository.listForUser(auth.user.id);
  return bookmarks.map((bookmark) => ({
    pasteId: bookmark.pasteId,
    title: bookmark.paste.title,
    language: bookmark.paste.language,
    createdAt: bookmark.paste.createdAt,
    addedAt: bookmark.createdAt,
  }));
}
