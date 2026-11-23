# D1 migrations

SQL files in this folder are the schema of the D1 database behind the `DB` binding. `npm run deploy` applies the ones the database has not seen, in file name order, before it deploys the Worker; Wrangler records them in the database's `d1_migrations` table.

- A migration is applied once and never edited afterwards: a change is a new file with the next number.
- The file names for steps 7a to 7c of the stack migration are reserved in [docs/data-model.md](../docs/data-model.md).
- A migration must leave the Worker that is live working: the deploy applies it before the new Worker replaces the old one, and a preview build (`npm run deploy:preview`) applies none.
- To try migrations locally: `npx wrangler d1 migrations apply DB --local`.
