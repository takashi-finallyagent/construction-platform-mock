import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { assertWorkflowRole } from './workflow-db.ts'

export function createPool(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 })
  pool.on('error', () => { console.error('Database connection failure; idle client removed') })
  return pool
}

export async function transaction<T>(pool: Pool, userId: string, work: (client: PoolClient) => Promise<T>, requestId: string = randomUUID()): Promise<T> {
  const client = await pool.connect()
  let destroy = false
  let failed = false
  let committing = false
  let value!: T
  let failure: unknown
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.request_id', $2, true)", [userId, requestId])
    value = await work(client)
    committing = true
    await client.query('COMMIT')
  } catch (error) {
    failed = true
    failure = error
    destroy = committing
    try { await client.query('ROLLBACK') } catch { destroy = true }
  }
  try { client.release(destroy) } catch (error) { if (!failed) { failed = true; failure = error } }
  if (failed) throw failure
  return value
}

export async function assertRuntimeRole(pool: Pool) {
  // SET reachability matters even for NOINHERIT roles (PostgreSQL 17).
  const { rows } = await pool.query(`WITH reachable AS (
      SELECT oid, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles
      WHERE oid = current_user::regrole OR pg_has_role(current_user, oid, 'USAGE') OR pg_has_role(current_user, oid, 'SET')
    ), business AS (
      SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('companies','memberships','jobs','audit_events','creation_requests','job_classifications','classification_audit_events')
    ) SELECT
      (SELECT count(*)=7 AND bool_and(relrowsecurity AND relkind='r' AND relowner NOT IN (SELECT oid FROM reachable)) FROM business) AS protected_tables,
      NOT EXISTS (SELECT FROM reachable WHERE rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication) AS limited_roles,
      NOT EXISTS (SELECT FROM reachable r WHERE has_database_privilege(r.oid, current_database(), 'CREATE')
        OR EXISTS (SELECT FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
          AND has_schema_privilege(r.oid, n.oid, 'CREATE'))) AS no_ddl,
      NOT EXISTS (SELECT FROM business b CROSS JOIN reachable r
        WHERE has_table_privilege(r.oid,b.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR (b.relname IN ('companies','memberships','audit_events','classification_audit_events') AND has_any_column_privilege(r.oid,b.oid,'INSERT'))
        OR (b.relname NOT IN ('jobs','job_classifications') AND has_any_column_privilege(r.oid,b.oid,'UPDATE'))
        OR (b.relname='job_classifications' AND EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid=b.oid AND a.attnum>0 AND NOT a.attisdropped
          AND ((a.attname NOT IN ('company_id','job_id','version','data','basis_job_version') AND has_column_privilege(r.oid,b.oid,a.attnum,'INSERT'))
            OR (a.attname NOT IN ('version','data','basis_job_version') AND has_column_privilege(r.oid,b.oid,a.attnum,'UPDATE')))))
        OR (b.relname='jobs' AND EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid=b.oid AND a.attnum>0 AND NOT a.attisdropped
          AND ((a.attname IN ('version','created_at','updated_at') AND has_column_privilege(r.oid,b.oid,a.attnum,'INSERT'))
            OR (a.attname IN ('id','company_id','created_by','created_at','updated_at') AND has_column_privilege(r.oid,b.oid,a.attnum,'UPDATE')))))) AS limited_dml,
      (SELECT count(*)=9 AND bool_and(p.prosecdef = (p.proname IN ('lock_membership','guard_job_write','audit_job_write','guard_classification_write','audit_classification_write'))
        AND p.proowner NOT IN (SELECT oid FROM reachable)
        AND COALESCE(p.proconfig @> ARRAY['search_path=""'],false)
        AND NOT EXISTS (SELECT FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')
        AND (p.proname='lock_membership' OR NOT EXISTS (SELECT FROM reachable r WHERE has_function_privilege(r.oid,p.oid,'EXECUTE'))))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
        AND (p.oid=to_regprocedure('public.lock_membership(uuid)') OR p.oid=to_regprocedure('public.guard_job_write()')
          OR p.oid=to_regprocedure('public.audit_job_write()') OR p.oid=to_regprocedure('public.trim_classification_json(jsonb)')
          OR p.oid=to_regprocedure('public.matches_classification_schema(jsonb,jsonb)') OR p.oid=to_regprocedure('public.validate_classification_data(jsonb)')
          OR p.oid=to_regprocedure('public.classification_record(public.job_classifications)')
          OR p.oid=to_regprocedure('public.guard_classification_write()') OR p.oid=to_regprocedure('public.audit_classification_write()'))) AS protected_functions,
      (SELECT count(*)=4 AND bool_and(t.tgenabled='O' AND t.tgqual IS NULL AND t.tgattr::text=''
        AND ((t.tgname='jobs_guard_write' AND b.relname='jobs' AND t.tgtype=23 AND t.tgfoid=to_regprocedure('public.guard_job_write()'))
          OR (t.tgname='jobs_audit_write' AND b.relname='jobs' AND t.tgtype=21 AND t.tgfoid=to_regprocedure('public.audit_job_write()'))
          OR (t.tgname='classifications_guard_write' AND b.relname='job_classifications' AND t.tgtype=23 AND t.tgfoid=to_regprocedure('public.guard_classification_write()'))
          OR (t.tgname='classifications_audit_write' AND b.relname='job_classifications' AND t.tgtype=21 AND t.tgfoid=to_regprocedure('public.audit_classification_write()'))))
        FROM pg_trigger t JOIN business b ON b.oid=t.tgrelid WHERE b.relname IN ('jobs','job_classifications')
        AND t.tgname IN ('jobs_guard_write','jobs_audit_write','classifications_guard_write','classifications_audit_write')) AS protected_triggers`)
  if (rows.length !== 1 || Object.values(rows[0]).some(value => value !== true)) {
    throw new Error('API requires a migrated database, protected audit/RLS and a non-owner runtime role with limited privileges')
  }
  await assertWorkflowRole(pool)
}
