/** Cursor pagination over an in-memory array. Cursors are opaque offsets. */
export function paginate<T>(
  items: readonly T[],
  { cursor, limit = 20 }: { cursor?: string; limit?: number },
): { items: T[]; nextCursor: string | null } {
  const start = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10) || 0 : 0
  const page = items.slice(start, start + limit)
  const next = start + limit
  return { items: page, nextCursor: next < items.length ? Buffer.from(String(next)).toString('base64url') : null }
}
