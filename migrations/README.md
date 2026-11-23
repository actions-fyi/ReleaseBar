# D1 migrations

SQL files in this folder are the schema of the D1 database behind the `DB` binding. `npm run deploy` applies the ones the database has not seen, in file name order, before it deploys the Worker; Wrangler records them in the database's `d1_migrations` table.

- A migration is applied once and never edited afterwards: a change is a new file with the next number.
- [docs/data-model.md](../docs/data-model.md) says which table holds what.
- A migration must leave the Worker that is live working: the deploy applies it before the new Worker replaces the old one, and a preview build (`npm run deploy:preview`) applies none. Add tables and columns first; remove what the old code read in a later deploy.
- SQLite can't add a `CHECK` to an existing column: `0004_checks.sql` rebuilds each table under a new name, copies the rows, drops the old table, renames the new one and creates its indexes again.
- To try migrations locally: `npx wrangler d1 migrations apply DB --local`.
