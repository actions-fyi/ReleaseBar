// The first row of a query that returns at most one.
export function firstRow<Row extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<Row>,
): Row | null {
  return cursor.toArray()[0] ?? null;
}

export function parseStored<Value>(text: string): Value {
  return JSON.parse(text) as Value;
}
