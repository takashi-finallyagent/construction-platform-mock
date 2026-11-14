ALTER TABLE public.jobs ADD CONSTRAINT jobs_company_id_unique UNIQUE (company_id, id);
ALTER TABLE public.audit_events ADD CONSTRAINT audit_events_company_job_fk
  FOREIGN KEY (company_id, target_id) REFERENCES public.jobs(company_id, id);
ALTER TABLE public.creation_requests ADD CONSTRAINT creation_requests_company_job_fk
  FOREIGN KEY (company_id, job_id) REFERENCES public.jobs(company_id, id);

ALTER TABLE public.audit_events
  ADD COLUMN actor_name text,
  ADD COLUMN target_version integer,
  ADD COLUMN request_id text;

-- Old rows have no historical name/request ID. Keep their snapshots and mark the backfill.
-- Invalid or duplicate historical versions deliberately fail migration instead of inventing history.
UPDATE public.audit_events a SET actor_name=u.name,
  target_version=(a.after_data->>'version')::integer,
  request_id='legacy:' || a.id::text
FROM public."user" u WHERE u.id=a.actor_id;
ALTER TABLE public.audit_events
  ALTER COLUMN actor_name SET NOT NULL,
  ALTER COLUMN target_version SET NOT NULL,
  ALTER COLUMN request_id SET NOT NULL,
  ADD CONSTRAINT audit_events_positive_version CHECK (target_version > 0),
  ADD CONSTRAINT audit_events_request_id_present CHECK (length(btrim(request_id)) > 0),
  ADD CONSTRAINT audit_events_company_target_version_unique UNIQUE (company_id, target_id, target_version);
DROP POLICY audit_create ON public.audit_events;

CREATE FUNCTION public.guard_job_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor text := pg_catalog.current_setting('app.user_id', true);
  request_id text := pg_catalog.current_setting('app.request_id', true);
  actor_role text;
BEGIN
  IF actor IS NULL OR pg_catalog.btrim(actor) = '' OR request_id IS NULL OR pg_catalog.btrim(request_id) = '' THEN
    RAISE EXCEPTION 'Job writes require actor and request context' USING ERRCODE='23514';
  END IF;
  SELECT m.role INTO actor_role FROM public.lock_membership(NEW.company_id) m;
  IF actor_role IS NULL OR actor_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Job write not authorized' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version IS DISTINCT FROM 1 OR NEW.created_by IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'Invalid initial job version or creator' USING ERRCODE='23514';
    END IF;
    NEW.created_at := pg_catalog.clock_timestamp();
    NEW.updated_at := NEW.created_at;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
      OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
      RAISE EXCEPTION 'Job identity and timestamps are database controlled' USING ERRCODE='23514';
    END IF;
    IF OLD.version = 2147483647 OR NEW.version IS DISTINCT FROM OLD.version + 1 THEN
      RAISE EXCEPTION 'Job version must advance by exactly one' USING ERRCODE='23514';
    END IF;
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_job_write() FROM PUBLIC;

CREATE FUNCTION public.audit_job_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor text := pg_catalog.current_setting('app.user_id', true);
  request_id text := pg_catalog.current_setting('app.request_id', true);
  actor_name text;
  previous_data jsonb;
  current_data jsonb;
BEGIN
  IF actor IS NULL OR pg_catalog.btrim(actor) = '' OR request_id IS NULL OR pg_catalog.btrim(request_id) = '' THEN
    RAISE EXCEPTION 'Job audit requires actor and request context' USING ERRCODE='23514';
  END IF;
  SELECT u.name INTO STRICT actor_name FROM public."user" u WHERE u.id=actor;
  current_data := pg_catalog.jsonb_build_object(
    'id',NEW.id, 'companyId',NEW.company_id, 'name',NEW.name, 'siteAddress',NEW.site_address,
    'customerName',NEW.customer_name, 'workDescription',NEW.work_description,
    'plannedStart',pg_catalog.to_char(NEW.planned_start,'YYYY-MM-DD'),
    'plannedEnd',pg_catalog.to_char(NEW.planned_end,'YYYY-MM-DD'),
    'version',NEW.version, 'createdBy',NEW.created_by,
    'createdAt',pg_catalog.to_char(NEW.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',pg_catalog.to_char(NEW.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF TG_OP = 'UPDATE' THEN
    previous_data := pg_catalog.jsonb_build_object(
      'id',OLD.id, 'companyId',OLD.company_id, 'name',OLD.name, 'siteAddress',OLD.site_address,
      'customerName',OLD.customer_name, 'workDescription',OLD.work_description,
      'plannedStart',pg_catalog.to_char(OLD.planned_start,'YYYY-MM-DD'),
      'plannedEnd',pg_catalog.to_char(OLD.planned_end,'YYYY-MM-DD'),
      'version',OLD.version, 'createdBy',OLD.created_by,
      'createdAt',pg_catalog.to_char(OLD.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt',pg_catalog.to_char(OLD.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  END IF;
  INSERT INTO public.audit_events(id,company_id,actor_id,actor_name,action,target_id,target_version,request_id,before_data,after_data)
  VALUES (pg_catalog.gen_random_uuid(),NEW.company_id,actor,actor_name,
    CASE WHEN TG_OP='INSERT' THEN 'job.created' ELSE 'job.updated' END,
    NEW.id,NEW.version,request_id,previous_data,current_data);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_job_write() FROM PUBLIC;

CREATE TRIGGER jobs_guard_write BEFORE INSERT OR UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.guard_job_write();
CREATE TRIGGER jobs_audit_write AFTER INSERT OR UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.audit_job_write();

-- The role may not exist yet on a fresh install; migrate.ts applies the final ACL as well.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname='construction_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_events FROM construction_app;
    REVOKE ALL ON FUNCTION public.guard_job_write(), public.audit_job_write() FROM construction_app;
  END IF;
END;
$$;
