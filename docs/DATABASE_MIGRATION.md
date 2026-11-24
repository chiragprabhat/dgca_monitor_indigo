# Neon PostgreSQL cutover

The Express application and the Python pipeline keep their existing tables in the same PostgreSQL database.

| Source | Default legacy file | Tables |
| --- | --- | --- |
| Express | `backend/node_api/data/dgca-monitoring.db` when started from `backend/node_api` | `updates`, `notifications`, `monitoring_logs`, `config`, `settings_log`, `review_log`, `car_documents`, `car_history`, `car_changes`, `uploaded_documents` |
| Python | `backend/database/dgca_monitor.db` | `publications` |

Use the actual old `DATABASE_PATH` for Express if it was overridden. The SQLite `updates_fts` index and its shadow tables are derived from publication titles and PDF text. PostgreSQL builds its search index from those same columns. Search keeps its query syntax, filters, title weighting, and highlight markers. Stemming, relevance order, and snippet selection can differ between the engines.

The foreign key from notifications to updates and existing primary keys, unique constraints, defaults, text timestamps, and JSON text are preserved. CAR history, reviews, and previous publication references retain their existing application-level relationships. Identity sequences start above the migrated IDs and the original SQLite sequence high-water marks. The upload ordering column preserves the SQLite row order when two uploads share a timestamp.

## Configuration

- **`DATABASE_URL`** is the only new runtime secret. Use the connection URL from Neon. Both backends verify the server certificate and hostname. Use the **direct** endpoint for migration and a **pooled** endpoint for the deployed API. Use a direct URL for notebook cells that use temporary tables.
- For Express, set it in the process environment or append it to `backend/node_api/.env`. For Python and Streamlit, set it in the process environment or append it to `backend/config/.env`. Keep all existing mail, provider, and scheduler values. Create the appropriate local file and its parent directory if needed. Git ignores environment files.
- **`TEST_DATABASE_URL`** is a separate direct connection to a disposable PostgreSQL database for integration tests. The tests create and remove a schema per test. A plain loopback PostgreSQL server may use `?sslmode=disable` explicitly.

## Transfer the data

1. Create an empty Neon database or branch database and copy its direct URL. Run the commands from the repo root using the Python environment from `backend/requirements.txt`. Make a protected directory for the backups. Stop the Express monitor, Python scheduler, scheduled jobs, and any other writers before the final snapshot. Leave the SQLite files and any WAL sidecars in place.
2. Set `DATABASE_URL` in the shell to the direct Neon URL. Run a dry run against the intended Neon target with both SQLite paths. When only one application has an existing database, omit the other flag.

   ```powershell
   python backend/scripts/migrate_sqlite_to_postgres.py --node-sqlite backend/node_api/data/dgca-monitoring.db --python-sqlite backend/database/dgca_monitor.db --backup-dir backend/database/sqlite-backup --dry-run
   ```

3. Check the reported row counts. Rerun the same command without `--dry-run`. The script uses SQLite's backup API to include committed WAL data and leaves the originals in place. Every source row is compared with PostgreSQL before commit. A mismatch, orphaned foreign key, or unexpected table or column aborts the transaction. An identical rerun before applications resume succeeds without duplicating rows. Keep the originals and the generated backup snapshots.
4. Switch the backend processes to the Neon URL. Run `npm ci` in `backend/node_api` and install the updated Python requirements. Start the existing entry points. Compare the Updates, Settings, Activity Log, Search, CARs, and Streamlit pages with legacy data. Check that previous notification decisions and histories are still present before resuming scheduled jobs.
5. If cutover must be reversed, stop the new writers first. The previous application version can reopen the original SQLite files. Preserve and reconcile any writes made in Neon after cutover before restoring service on SQLite.

## Deployment and tests

Keep `DATABASE_URL` server-side. For a Vercel-hosted Express API, set a pooled URL as a server environment variable. The existing app export can serve the HTTP routes. A long-running host is required for Express background timers and jobs that outlive a request. The React client in this checkout still uses its pre-existing localhost API URL, so a remote browser deployment requires its own API-origin configuration. [Express on Vercel](https://vercel.com/docs/frameworks/backend/express)

In the planned GitHub Actions monitoring job, map the repository secret `DATABASE_URL` to the job's environment and install `backend/requirements.txt`. Keep the existing schedule and provider settings. For an Actions job that runs one Python cycle, run the following from `backend`:

```bash
python -c 'from pipeline.scheduler import run_once; result = run_once(); print(result); raise SystemExit(result["status"] == "error")'
```

Run `python -m unittest discover -s tests -t .` from `backend` with `TEST_DATABASE_URL` set to exercise PostgreSQL storage, scheduling, and publication processing.
