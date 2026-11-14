import { readFile } from 'node:fs/promises'
import { getMigrations } from 'better-auth/db/migration'
import type { Pool } from 'pg'
import { authOptions } from './auth.ts'
import type { Config } from './config.ts'

export async function migrate(pool: Pool, config: Config, appPassword: string) {
  if (appPassword.length < 24 || !/^[A-Za-z0-9_-]+$/.test(appPassword)) throw new Error('DB_APP_PASSWORD requires 24+ random URL-safe characters')
  const client = await pool.connect()
  let locked = false
  let inTransaction = false
  let destroy = false
  let failed = false
  let failure: unknown
  try {
    await client.query('SELECT pg_advisory_lock(71022001)')
    locked = true
    const { runMigrations } = await getMigrations(authOptions(pool, config))
    await runMigrations()
    await client.query('BEGIN')
    inTransaction = true
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    for (const [version, file] of [[1, '001_foundation.sql'], [2, '002_membership_lock.sql'], [3, '003_job_audit.sql'], [4, '004_job_classification.sql'], [5, '005_job_workflow.sql'], [6, '006_payment_evidence.sql']] as const) {
      const applied = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [version])
      if (!applied.rowCount) {
        await client.query(await readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8'))
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version])
      }
    }
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'construction_app'")
    // The role name is fixed; the secret is strictly constrained above and never logged.
    if (!role.rowCount) await client.query(`CREATE ROLE construction_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await client.query('REVOKE CREATE ON SCHEMA public FROM construction_app')
    await client.query('GRANT USAGE ON SCHEMA public TO construction_app')
    await client.query('REVOKE ALL ON companies, memberships, jobs, audit_events, creation_requests, job_classifications, classification_audit_events FROM construction_app')
    await client.query('REVOKE ALL ON job_workflows, workflow_audit_events, job_files FROM construction_app')
    // Table-level REVOKE does not remove pre-existing column grants.
    const columns = await client.query(`SELECT table_name, column_name FROM information_schema.column_privileges
      WHERE table_schema='public' AND grantee='construction_app'
      AND table_name IN ('companies','memberships','jobs','audit_events','creation_requests','job_classifications','classification_audit_events','job_workflows','workflow_audit_events','job_files')`)
    for (const row of columns.rows) {
      const ident = (value: string) => `"${value.replaceAll('"', '""')}"`
      await client.query(`REVOKE ALL (${ident(row.column_name)}) ON public.${ident(row.table_name)} FROM construction_app`)
    }
    await client.query('GRANT SELECT ON companies, memberships TO construction_app')
    await client.query('GRANT EXECUTE ON FUNCTION public.lock_membership(uuid) TO construction_app')
    await client.query('REVOKE ALL ON FUNCTION public.guard_job_write(), public.audit_job_write() FROM construction_app')
    await client.query('GRANT SELECT ON jobs, audit_events, creation_requests TO construction_app')
    await client.query('GRANT INSERT (id, company_id, name, site_address, customer_name, work_description, planned_start, planned_end, created_by) ON jobs TO construction_app')
    await client.query('GRANT INSERT ON creation_requests TO construction_app')
    await client.query('GRANT UPDATE (name, site_address, customer_name, work_description, planned_start, planned_end, version) ON jobs TO construction_app')
    await client.query('GRANT SELECT ON job_classifications, classification_audit_events TO construction_app')
    await client.query('GRANT INSERT (company_id, job_id, version, data, basis_job_version) ON job_classifications TO construction_app')
    await client.query('GRANT UPDATE (version, data, basis_job_version) ON job_classifications TO construction_app')
    await client.query('GRANT SELECT ON job_workflows, workflow_audit_events, job_files TO construction_app')
    await client.query('GRANT INSERT(company_id,job_id,version,data,basis_job_version,classification_version) ON job_workflows TO construction_app')
    await client.query('GRANT UPDATE(version,data,basis_job_version,classification_version) ON job_workflows TO construction_app')
    await client.query('GRANT INSERT(id,company_id,job_id,name,content_type,size,sha256,kind,storage_key) ON job_files TO construction_app')
    await client.query(`REVOKE ALL ON FUNCTION public.normalize_workflow_json(jsonb,text),public.validate_workflow_dates(jsonb,text),public.workflow_document_total(jsonb),
      public.validate_workflow_structure(jsonb),public.validate_workflow_contract_gate(jsonb,integer,public.job_classifications),public.guard_workflow_write(),public.audit_workflow_write(),public.guard_file_write() FROM construction_app`)
    await client.query('REVOKE ALL ON FUNCTION public.guard_payment_evidence() FROM construction_app')
    await client.query(`REVOKE ALL ON FUNCTION public.trim_classification_json(jsonb), public.matches_classification_schema(jsonb,jsonb),
      public.validate_classification_data(jsonb), public.classification_record(public.job_classifications),
      public.guard_classification_write(), public.audit_classification_write() FROM construction_app`)
    await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "user", session, account, verification, "rateLimit" TO construction_app')
    await client.query('COMMIT')
    inTransaction = false
  } catch (error) {
    failed = true
    failure = error
    if (inTransaction) {
      try { await client.query('ROLLBACK') } catch { destroy = true }
    } else if (!locked) { destroy = true }
  }
  let cleanupError: unknown
  if (locked && !destroy) {
    try {
      const result = await client.query('SELECT pg_advisory_unlock(71022001) AS unlocked')
      if (result.rows[0]?.unlocked !== true) throw new Error('Migration lock was not held')
    } catch (error) { destroy = true; cleanupError = error }
  }
  try { client.release(destroy) } catch (error) { cleanupError ??= error }
  if (failed) throw failure
  if (cleanupError) throw cleanupError
}
