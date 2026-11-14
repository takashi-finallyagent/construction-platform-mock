import type { Pool } from 'pg'

// Kept separate so the legacy audit checks retain their exact table/function counts.
export async function assertWorkflowRole(pool: Pool) {
  const {rows}=await pool.query(`WITH reachable AS (
      SELECT oid FROM pg_roles WHERE oid=current_user::regrole OR pg_has_role(current_user,oid,'USAGE') OR pg_has_role(current_user,oid,'SET')
    ), business AS (
      SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('job_workflows','workflow_audit_events','job_files')
    ), functions AS (
      SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.oid IN (
        to_regprocedure('public.normalize_workflow_json(jsonb,text)'),to_regprocedure('public.validate_workflow_dates(jsonb,text)'),
        to_regprocedure('public.workflow_document_total(jsonb)'),to_regprocedure('public.validate_workflow_structure(jsonb)'),to_regprocedure('public.validate_workflow_contract_gate(jsonb,integer,public.job_classifications)'),
        to_regprocedure('public.guard_workflow_write()'),to_regprocedure('public.audit_workflow_write()'),to_regprocedure('public.guard_file_write()'),to_regprocedure('public.guard_payment_evidence()'))
    ) SELECT
      (SELECT count(*)=3 AND bool_and(relrowsecurity AND relkind='r' AND relowner NOT IN (SELECT oid FROM reachable)) FROM business) AS protected_tables,
      NOT EXISTS(SELECT FROM business b CROSS JOIN reachable r WHERE has_table_privilege(r.oid,b.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR (b.relname='workflow_audit_events' AND has_any_column_privilege(r.oid,b.oid,'INSERT,UPDATE'))
        OR (b.relname='job_files' AND has_any_column_privilege(r.oid,b.oid,'UPDATE'))
        OR EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=b.oid AND a.attnum>0 AND NOT a.attisdropped AND (
          (b.relname='job_workflows' AND ((a.attname NOT IN ('company_id','job_id','version','data','basis_job_version','classification_version') AND has_column_privilege(r.oid,b.oid,a.attnum,'INSERT'))
            OR (a.attname NOT IN ('version','data','basis_job_version','classification_version') AND has_column_privilege(r.oid,b.oid,a.attnum,'UPDATE'))))
          OR (b.relname='job_files' AND a.attname NOT IN ('id','company_id','job_id','name','content_type','size','sha256','kind','storage_key') AND has_column_privilege(r.oid,b.oid,a.attnum,'INSERT'))))) AS limited_dml,
      (SELECT count(*)=9 AND bool_and(p.prosecdef=(p.proname IN ('guard_workflow_write','audit_workflow_write','guard_file_write'))
        AND p.proowner NOT IN (SELECT oid FROM reachable) AND COALESCE(p.proconfig @> ARRAY['search_path=""'],false)
        AND NOT EXISTS(SELECT FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
        AND NOT EXISTS(SELECT FROM reachable r WHERE has_function_privilege(r.oid,p.oid,'EXECUTE'))) FROM functions p) AS protected_functions,
      (SELECT count(*)=4 AND bool_and(t.tgenabled='O' AND t.tgqual IS NULL AND t.tgattr::text='' AND (
        (t.tgname='workflows_guard_write' AND b.relname='job_workflows' AND t.tgtype=31 AND t.tgfoid=to_regprocedure('public.guard_workflow_write()'))
        OR (t.tgname='workflows_audit_write' AND b.relname='job_workflows' AND t.tgtype=21 AND t.tgfoid=to_regprocedure('public.audit_workflow_write()'))
        OR (t.tgname='workflows_payment_evidence' AND b.relname='job_workflows' AND t.tgtype=23 AND t.tgfoid=to_regprocedure('public.guard_payment_evidence()'))
        OR (t.tgname='files_guard_write' AND b.relname='job_files' AND t.tgtype=31 AND t.tgfoid=to_regprocedure('public.guard_file_write()'))))
        FROM pg_trigger t JOIN business b ON b.oid=t.tgrelid WHERE t.tgname IN ('workflows_guard_write','workflows_audit_write','files_guard_write','workflows_payment_evidence')) AS protected_triggers`)
  if (rows.length!==1 || Object.values(rows[0]).some(v=>v!==true)) throw new Error('API requires migrated workflow/file tables, protected audit/RLS and non-owner runtime privileges')
}
