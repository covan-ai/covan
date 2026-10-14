/**
 * Lists of ids, cut to a size a URL can carry.
 *
 * PostgREST puts an `in` filter in the query string, and a uuid is 36
 * characters: a few hundred of them is a URL the gateway answers with 414
 * before PostgREST sees it. The purge and account closure both built one list
 * of everything — so past about 220 expired rows the purge stopped for every
 * tenant, and closing an account with that many bundles left their files
 * behind. A hundred per request keeps every URL a few kilobytes long.
 */
export const IN_LIST_SIZE = 100;

export function chunked<T>(items: readonly T[], size: number = IN_LIST_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every row a read returns, page by page.
 *
 * PostgREST stops a read at `max_rows` (1000) and says nothing when it does.
 * `page(from, to)` builds the same query with `.range(from, to)` on the end;
 * this asks again until a page comes back short. Null on the first error, so a
 * caller can tell "none" from "could not tell".
 */
export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[] | null> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) return null;
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return rows;
  }
}
