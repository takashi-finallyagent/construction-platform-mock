-- Preserve historical payment facts. Only records appended by this write require evidence.
-- The existing workflow guard validates structure, append-only history and job-owned files first.
CREATE FUNCTION public.guard_payment_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE previous_count integer:=0; payment jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN previous_count:=pg_catalog.jsonb_array_length(OLD.data->'payments'); END IF;
  FOR payment IN SELECT value FROM pg_catalog.jsonb_array_elements(NEW.data->'payments') WITH ORDINALITY x(value,n)
    WHERE n>previous_count LOOP
    IF pg_catalog.jsonb_typeof(payment->'evidenceIds') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(payment->'evidenceIds')<1 THEN
      RAISE EXCEPTION 'New payment/reversal requires evidence' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_payment_evidence() FROM PUBLIC;
-- PostgreSQL orders triggers of the same event by name: after workflows_guard_write,
-- before the AFTER audit trigger. A rejected append rolls the complete write back.
CREATE TRIGGER workflows_payment_evidence BEFORE INSERT OR UPDATE ON public.job_workflows
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_evidence();
