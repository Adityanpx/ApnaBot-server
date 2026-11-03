// PostgREST returns at most 1000 rows per request; these helpers read past that.

const PAGE_SIZE = 1000;
const CHUNK_SIZE = 100; // ids per .in() filter, so the request URL stays short

/**
 * Every row of a query. `build(from, to)` returns the (awaitable) range query for that slice;
 * paging stops at the first short page. Throws the query error.
 */
const fetchAllPages = async (build) => {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
};

/**
 * Rows of `table` whose `column` is in `ids`, fetched CHUNK_SIZE ids at a time.
 * `extend(query)` (optional) adds more filters to each chunk's query.
 */
const fetchByIds = async (supabase, table, select, column, ids, extend = (q) => q) => {
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const { data, error } = await extend(
      supabase.from(table).select(select).in(column, ids.slice(i, i + CHUNK_SIZE))
    );
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
};

module.exports = { fetchAllPages, fetchByIds, PAGE_SIZE, CHUNK_SIZE };
