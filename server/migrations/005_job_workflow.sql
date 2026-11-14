CREATE TABLE public.job_workflows (
  company_id uuid NOT NULL, job_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  basis_job_version integer NOT NULL CHECK(basis_job_version>0), classification_version integer CHECK(classification_version>0),
  data jsonb NOT NULL, updated_at timestamptz NOT NULL, updated_by text NOT NULL REFERENCES public."user"(id),
  PRIMARY KEY(company_id,job_id), FOREIGN KEY(company_id,job_id) REFERENCES public.jobs(company_id,id)
);
CREATE TABLE public.workflow_audit_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), company_id uuid NOT NULL, job_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), actor_id text NOT NULL REFERENCES public."user"(id), actor_name text NOT NULL,
  occurred_at timestamptz NOT NULL, request_id text NOT NULL CHECK(length(btrim(request_id))>0), before_data jsonb, after_data jsonb NOT NULL,
  FOREIGN KEY(company_id,job_id) REFERENCES public.job_workflows(company_id,job_id), UNIQUE(company_id,job_id,version)
);
CREATE TABLE public.job_files (
  id uuid PRIMARY KEY, company_id uuid NOT NULL, job_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 240 AND name !~ '[[:cntrl:]/\\]' AND name NOT IN ('.','..')),
  content_type text NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size integer NOT NULL CHECK(size BETWEEN 1 AND 12582912), sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK(kind IN ('photo','evidence') AND (kind<>'photo' OR content_type<>'application/pdf')),
  storage_key uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL, created_by text NOT NULL REFERENCES public."user"(id),
  created_by_name text NOT NULL, request_id text NOT NULL CHECK(length(btrim(request_id))>0),
  FOREIGN KEY(company_id,job_id) REFERENCES public.jobs(company_id,id)
);
ALTER TABLE public.job_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_read ON public.job_workflows FOR SELECT USING (EXISTS(SELECT FROM public.memberships m WHERE m.company_id=job_workflows.company_id));
CREATE POLICY workflow_insert ON public.job_workflows FOR INSERT WITH CHECK (EXISTS(SELECT FROM public.memberships m WHERE m.company_id=job_workflows.company_id AND m.role IN ('owner','manager')));
CREATE POLICY workflow_update ON public.job_workflows FOR UPDATE USING (EXISTS(SELECT FROM public.memberships m WHERE m.company_id=job_workflows.company_id AND m.role IN ('owner','manager')))
  WITH CHECK (EXISTS(SELECT FROM public.memberships m WHERE m.company_id=job_workflows.company_id AND m.role IN ('owner','manager')));
CREATE POLICY workflow_audit_read ON public.workflow_audit_events FOR SELECT USING (EXISTS(SELECT FROM public.memberships m WHERE m.company_id=workflow_audit_events.company_id AND m.role IN ('owner','manager')));
CREATE POLICY files_read ON public.job_files FOR SELECT USING (EXISTS(SELECT FROM public.memberships m WHERE m.company_id=job_files.company_id));
CREATE POLICY files_insert ON public.job_files FOR INSERT WITH CHECK (EXISTS(SELECT FROM public.memberships m WHERE m.company_id=job_files.company_id AND m.role IN ('owner','manager')));
REVOKE ALL ON public.job_workflows,public.workflow_audit_events,public.job_files FROM PUBLIC;

CREATE FUNCTION public.normalize_workflow_json(v jsonb,k text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE result jsonb; pair record;
BEGIN
  CASE pg_catalog.jsonb_typeof(v)
  WHEN 'string' THEN
    v:=public.trim_classification_json(v);
    IF k IN ('id','fileId','estimateId','originalContractId','contractId','invoiceId','reversesId','evidenceIds','photoIds','companyId','jobId') THEN
      RETURN pg_catalog.to_jsonb(pg_catalog.lower(v#>>'{}'));
    END IF;
    RETURN v;
  WHEN 'array' THEN
    SELECT COALESCE(pg_catalog.jsonb_agg(public.normalize_workflow_json(x.value,k) ORDER BY x.ordinality),'[]'::jsonb)
      INTO result FROM pg_catalog.jsonb_array_elements(v) WITH ORDINALITY x(value,ordinality); RETURN result;
  WHEN 'object' THEN
    result:='{}';
    FOR pair IN SELECT * FROM pg_catalog.jsonb_each(v) LOOP
      result:=result || pg_catalog.jsonb_build_object(pair.key,public.normalize_workflow_json(pair.value,pair.key));
    END LOOP; RETURN result;
  ELSE RETURN v;
  END CASE;
END;
$$;
CREATE FUNCTION public.validate_workflow_dates(v jsonb,k text DEFAULT '') RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE pair record; item jsonb; t text;
BEGIN
  IF pg_catalog.jsonb_typeof(v)='object' THEN
    FOR pair IN SELECT * FROM pg_catalog.jsonb_each(v) LOOP PERFORM public.validate_workflow_dates(pair.value,pair.key); END LOOP;
  ELSIF pg_catalog.jsonb_typeof(v)='array' THEN
    FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(v) LOOP PERFORM public.validate_workflow_dates(item,k); END LOOP;
  ELSIF pg_catalog.jsonb_typeof(v)='string' THEN
    t:=v#>>'{}';
    IF k IN ('issuedOn','validUntil','effectiveDate','reviewedOn','eventDate','paidOn','startsOn','endsOn','plannedStart','plannedEnd','dueOn','startDate','endDate','handoverDate') AND t<>'' THEN
      IF t !~ '^[12][0-9]{3}-[0-9]{2}-[0-9]{2}$' OR pg_catalog.to_char(t::date,'YYYY-MM-DD')<>t THEN RAISE EXCEPTION 'Invalid date'; END IF;
      IF k IN ('reviewedOn','eventDate','paidOn') AND t::date>(pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date THEN RAISE EXCEPTION 'Future event'; END IF;
    ELSIF k IN ('capturedAt','issuedAt','createdAt','updatedAt') AND t<>'' THEN
      IF t !~ '^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$'
        OR pg_catalog.to_char(t::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD')<>pg_catalog.substr(t,1,10)
        OR (k='capturedAt' AND t::timestamptz>pg_catalog.clock_timestamp()) THEN RAISE EXCEPTION 'Invalid timestamp'; END IF;
    ELSIF k IN ('timeFrom','timeTo') AND t<>'' AND t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RAISE EXCEPTION 'Invalid time';
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid workflow date/time' USING ERRCODE='23514';
END;
$$;
CREATE FUNCTION public.workflow_document_total(d jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE subtotal numeric; total numeric;
BEGIN
  SELECT COALESCE(sum(pg_catalog.trunc((x.value->>'quantity')::numeric*(x.value->>'unitPrice')::numeric)),0) INTO subtotal
    FROM pg_catalog.jsonb_array_elements(d->'items') x;
  total:=subtotal+pg_catalog.floor((subtotal*(d->>'taxRate')::numeric+CASE d->>'rounding' WHEN 'round' THEN 50 WHEN 'ceil' THEN 99 ELSE 0 END)/100);
  IF total>999999999999 THEN RAISE EXCEPTION 'Workflow total overflow' USING ERRCODE='23514'; END IF;
  RETURN total;
END;
$$;
CREATE FUNCTION public.validate_workflow_structure(d jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE schema_doc jsonb:=$schema${"type":"object","additionalProperties":false,"required":["schemaVersion","reviews","estimates","contracts","contractEvents","tasks","photos","notices","reports","invoices","payments","milestones","laborInsurance"],"properties":{"schemaVersion":{"type":"integer","enum":[1]},"reviews":{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","issueId","classificationVersion","jobVersion","conclusion","reviewedOn","evidenceIds","note"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"issueId":{"type":"string","minLength":1,"maxLength":300},"classificationVersion":{"type":"integer"},"jobVersion":{"type":"integer"},"conclusion":{"type":"string","enum":["confirmed","not_applicable","needs_action"]},"reviewedOn":{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},"evidenceIds":{"type":"array","maxItems":200,"items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"uniqueItems":true},"note":{"type":"string","maxLength":2000}}}},"estimates":{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","status","issuedAt","issuedBy","basis","title","recipient","recipientAddress","issuer","issuerAddress","issuedOn","validUntil","items","taxRate","rounding","notes"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"status":{"type":"string","enum":["draft","issued"]},"issuedAt":{"anyOf":[{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},{"type":"null"}]},"issuedBy":{"anyOf":[{"type":"string","maxLength":200},{"type":"null"}]},"basis":{"anyOf":[{"type":"object","additionalProperties":false,"required":["job","classificationVersion"],"properties":{"job":{"type":"object","additionalProperties":false,"required":["id","companyId","version","name","siteAddress","customerName","workDescription","plannedStart","plannedEnd","createdAt","updatedAt","createdBy"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"companyId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"integer"},"name":{"type":"string","maxLength":120},"siteAddress":{"type":"string","maxLength":250},"customerName":{"type":"string","maxLength":120},"workDescription":{"type":"string","maxLength":2000},"plannedStart":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"plannedEnd":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"createdAt":{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},"updatedAt":{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},"createdBy":{"type":"string","maxLength":200}}},"classificationVersion":{"anyOf":[{"type":"integer"},{"type":"null"}]}}},{"type":"null"}]},"title":{"type":"string","maxLength":200},"recipient":{"type":"string","maxLength":200},"recipientAddress":{"type":"string","maxLength":500},"issuer":{"type":"string","maxLength":200},"issuerAddress":{"type":"string","maxLength":500},"issuedOn":{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},"validUntil":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"items":{"type":"array","maxItems":100,"items":{"type":"object","additionalProperties":false,"required":["id","description","category","quantity","unit","unitPrice"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"description":{"type":"string","maxLength":500},"category":{"type":"string","enum":["material","labor","welfare","safety","retirement","other"]},"quantity":{"type":"string","pattern":"^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,2})?$"},"unit":{"type":"string","maxLength":30},"unitPrice":{"type":"string","pattern":"^(0|[1-9][0-9]{0,11})$"}}}},"taxRate":{"type":"string","enum":["10","8","0"]},"rounding":{"type":"string","enum":["floor","round","ceil"]},"notes":{"type":"string","maxLength":2000}}}},"contracts":{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","status","issuedAt","issuedBy","basis","title","estimateId","kind","originalContractId","changeReason","effectiveDate","partyRole","counterparty","terms"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"status":{"type":"string","enum":["draft","issued"]},"issuedAt":{"anyOf":[{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},{"type":"null"}]},"issuedBy":{"anyOf":[{"type":"string","maxLength":200},{"type":"null"}]},"basis":{"anyOf":[{"type":"object","additionalProperties":false,"required":["job","classificationVersion"],"properties":{"job":{"type":"object","additionalProperties":false,"required":["id","companyId","version","name","siteAddress","customerName","workDescription","plannedStart","plannedEnd","createdAt","updatedAt","createdBy"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"companyId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"integer"},"name":{"type":"string","maxLength":120},"siteAddress":{"type":"string","maxLength":250},"customerName":{"type":"string","maxLength":120},"workDescription":{"type":"string","maxLength":2000},"plannedStart":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"plannedEnd":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"createdAt":{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},"updatedAt":{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},"createdBy":{"type":"string","maxLength":200}}},"classificationVersion":{"anyOf":[{"type":"integer"},{"type":"null"}]}}},{"type":"null"}]},"title":{"type":"string","maxLength":200},"estimateId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"kind":{"type":"string","enum":["initial","change"]},"originalContractId":{"anyOf":[{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"changeReason":{"type":"string","maxLength":2000},"effectiveDate":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"partyRole":{"type":"string","enum":["receiving","ordering"]},"counterparty":{"type":"string","maxLength":200},"terms":{"type":"object","additionalProperties":false,"required":["scope","exclusions","startDate","endDate","handoverDate","workingHours","nonWorkingDays","paymentTerms","inspectionTerms","changeTerms","priceChangeTerms","suppliedTerms","thirdPartyDamageTerms","forceMajeureTerms","delayTerms","defectTerms","disputeTerms","riskNotice"],"properties":{"scope":{"type":"string","maxLength":2000},"exclusions":{"type":"string","maxLength":2000},"startDate":{"type":"string","maxLength":2000},"endDate":{"type":"string","maxLength":2000},"handoverDate":{"type":"string","maxLength":2000},"workingHours":{"type":"string","maxLength":2000},"nonWorkingDays":{"type":"string","maxLength":2000},"paymentTerms":{"type":"string","maxLength":2000},"inspectionTerms":{"type":"string","maxLength":2000},"changeTerms":{"type":"string","maxLength":2000},"priceChangeTerms":{"type":"string","maxLength":2000},"suppliedTerms":{"type":"string","maxLength":2000},"thirdPartyDamageTerms":{"type":"string","maxLength":2000},"forceMajeureTerms":{"type":"string","maxLength":2000},"delayTerms":{"type":"string","maxLength":2000},"defectTerms":{"type":"string","maxLength":2000},"disputeTerms":{"type":"string","maxLength":2000},"riskNotice":{"type":"string","maxLength":2000}}}}}},"contractEvents":{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","contractId","type","eventDate","counterparty","evidenceIds","note"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"contractId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"type":{"type":"string","enum":["delivered","accepted","change_requested","cancelled"]},"eventDate":{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},"counterparty":{"type":"string","maxLength":200},"evidenceIds":{"type":"array","maxItems":200,"items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"uniqueItems":true},"note":{"type":"string","maxLength":2000}}}},"tasks":{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","title","company","startsOn","endsOn","status","note"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"title":{"type":"string","maxLength":200},"company":{"type":"string","maxLength":200},"startsOn":{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},"endsOn":{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},"status":{"type":"string","enum":["planned","active","done"]},"note":{"type":"string","maxLength":2000}}}},"photos":{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","fileId","phase","caption","capturedAt","source"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"fileId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"phase":{"type":"string","enum":["before","during","after"]},"caption":{"type":"string","maxLength":1000},"capturedAt":{"anyOf":[{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},{"type":"null"}]},"source":{"type":"string","enum":["camera","device-camera","upload"]}}}},"notices":{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","status","issuedAt","issuedBy","basis","kind","title","recipient","startsOn","endsOn","timeFrom","timeTo","impacts","contactName","contactPhone","message"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"status":{"type":"string","enum":["draft","issued"]},"issuedAt":{"anyOf":[{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},{"type":"null"}]},"issuedBy":{"anyOf":[{"type":"string","maxLength":200},{"type":"null"}]},"basis":{"anyOf":[{"type":"object","additionalProperties":false,"required":["job","classificationVersion"],"properties":{"job":{"type":"object","additionalProperties":false,"required":["id","companyId","version","name","siteAddress","customerName","workDescription","plannedStart","plannedEnd","createdAt","updatedAt","createdBy"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"companyId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"integer"},"name":{"type":"string","maxLength":120},"siteAddress":{"type":"string","maxLength":250},"customerName":{"type":"string","maxLength":120},"workDescription":{"type":"string","maxLength":2000},"plannedStart":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"plannedEnd":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"createdAt":{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},"updatedAt":{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},"createdBy":{"type":"string","maxLength":200}}},"classificationVersion":{"anyOf":[{"type":"integer"},{"type":"null"}]}}},{"type":"null"}]},"kind":{"type":"string","enum":["construction","change","delay","cancel","complete"]},"title":{"type":"string","maxLength":200},"recipient":{"type":"string","maxLength":200},"startsOn":{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},"endsOn":{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},"timeFrom":{"type":"string","pattern":"^([0-2][0-9]:[0-5][0-9]|)$"},"timeTo":{"type":"string","pattern":"^([0-2][0-9]:[0-5][0-9]|)$"},"impacts":{"type":"array","maxItems":20,"items":{"type":"string","maxLength":300}},"contactName":{"type":"string","maxLength":200},"contactPhone":{"type":"string","maxLength":100},"message":{"type":"string","maxLength":4000}}}},"reports":{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","status","issuedAt","issuedBy","basis","title","photoIds","photoSnapshot","notes"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"status":{"type":"string","enum":["draft","issued"]},"issuedAt":{"anyOf":[{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},{"type":"null"}]},"issuedBy":{"anyOf":[{"type":"string","maxLength":200},{"type":"null"}]},"basis":{"anyOf":[{"type":"object","additionalProperties":false,"required":["job","classificationVersion"],"properties":{"job":{"type":"object","additionalProperties":false,"required":["id","companyId","version","name","siteAddress","customerName","workDescription","plannedStart","plannedEnd","createdAt","updatedAt","createdBy"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"companyId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"integer"},"name":{"type":"string","maxLength":120},"siteAddress":{"type":"string","maxLength":250},"customerName":{"type":"string","maxLength":120},"workDescription":{"type":"string","maxLength":2000},"plannedStart":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"plannedEnd":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"createdAt":{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},"updatedAt":{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},"createdBy":{"type":"string","maxLength":200}}},"classificationVersion":{"anyOf":[{"type":"integer"},{"type":"null"}]}}},{"type":"null"}]},"title":{"type":"string","maxLength":200},"photoIds":{"type":"array","maxItems":200,"items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"uniqueItems":true},"photoSnapshot":{"anyOf":[{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","fileId","phase","caption","capturedAt","source"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"fileId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"phase":{"type":"string","enum":["before","during","after"]},"caption":{"type":"string","maxLength":1000},"capturedAt":{"anyOf":[{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},{"type":"null"}]},"source":{"type":"string","enum":["camera","device-camera","upload"]}}}},{"type":"null"}]},"notes":{"type":"string","maxLength":2000}}}},"invoices":{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","status","issuedAt","issuedBy","basis","number","direction","contractId","recipient","issuer","issuedOn","dueOn","bank","registrationNumber","items","taxRate","rounding","notes"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"status":{"type":"string","enum":["draft","issued"]},"issuedAt":{"anyOf":[{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},{"type":"null"}]},"issuedBy":{"anyOf":[{"type":"string","maxLength":200},{"type":"null"}]},"basis":{"anyOf":[{"type":"object","additionalProperties":false,"required":["job","classificationVersion"],"properties":{"job":{"type":"object","additionalProperties":false,"required":["id","companyId","version","name","siteAddress","customerName","workDescription","plannedStart","plannedEnd","createdAt","updatedAt","createdBy"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"companyId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"integer"},"name":{"type":"string","maxLength":120},"siteAddress":{"type":"string","maxLength":250},"customerName":{"type":"string","maxLength":120},"workDescription":{"type":"string","maxLength":2000},"plannedStart":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"plannedEnd":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"createdAt":{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},"updatedAt":{"type":"string","pattern":"^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$"},"createdBy":{"type":"string","maxLength":200}}},"classificationVersion":{"anyOf":[{"type":"integer"},{"type":"null"}]}}},{"type":"null"}]},"number":{"type":"string","maxLength":100},"direction":{"type":"string","enum":["receivable","payable"]},"contractId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"recipient":{"type":"string","maxLength":200},"issuer":{"type":"string","maxLength":200},"issuedOn":{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},"dueOn":{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},"bank":{"type":"string","maxLength":1000},"registrationNumber":{"type":"string","maxLength":100},"items":{"type":"array","maxItems":100,"items":{"type":"object","additionalProperties":false,"required":["id","description","category","quantity","unit","unitPrice"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"description":{"type":"string","maxLength":500},"category":{"type":"string","enum":["material","labor","welfare","safety","retirement","other"]},"quantity":{"type":"string","pattern":"^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,2})?$"},"unit":{"type":"string","maxLength":30},"unitPrice":{"type":"string","pattern":"^(0|[1-9][0-9]{0,11})$"}}}},"taxRate":{"type":"string","enum":["10","8","0"]},"rounding":{"type":"string","enum":["floor","round","ceil"]},"notes":{"type":"string","maxLength":2000}}}},"payments":{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","invoiceId","type","reversesId","paidOn","amountYen","method","reference","evidenceIds","note"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"invoiceId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"type":{"type":"string","enum":["payment","reversal"]},"reversesId":{"anyOf":[{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"paidOn":{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},"amountYen":{"type":"string","pattern":"^(0|[1-9][0-9]{0,11})$"},"method":{"type":"string","maxLength":200},"reference":{"type":"string","maxLength":300},"evidenceIds":{"type":"array","maxItems":200,"items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"uniqueItems":true},"note":{"type":"string","maxLength":2000}}}},"milestones":{"type":"array","maxItems":200,"items":{"type":"object","additionalProperties":false,"required":["id","contractId","type","eventDate","amountYen","evidenceIds","note"],"properties":{"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"contractId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"type":{"type":"string","enum":["completion_notice","inspection","handover_offer","handover","upstream_receipt"]},"eventDate":{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},"amountYen":{"anyOf":[{"type":"string","pattern":"^(0|[1-9][0-9]{0,11})$"},{"type":"null"}]},"evidenceIds":{"type":"array","maxItems":200,"items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"uniqueItems":true},"note":{"type":"string","maxLength":2000}}}},"laborInsurance":{"type":"object","additionalProperties":false,"required":["arrangement","principalName","insuranceNumber","startsOn","endsOn","evidenceIds","note"],"properties":{"arrangement":{"type":"string","enum":["unknown","blanket","individual"]},"principalName":{"type":"string","maxLength":200},"insuranceNumber":{"type":"string","maxLength":100},"startsOn":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"endsOn":{"anyOf":[{"type":"string","pattern":"^([12][0-9]{3}-[0-9]{2}-[0-9]{2}|)$"},{"type":"null"}]},"evidenceIds":{"type":"array","maxItems":200,"items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"uniqueItems":true},"note":{"type":"string","maxLength":2000}}}}}$schema$::jsonb;
BEGIN
  IF d IS NULL OR NOT public.matches_classification_schema(d,schema_doc) THEN
    RAISE EXCEPTION 'Invalid workflow structure' USING ERRCODE='23514';
  END IF;
  PERFORM public.validate_workflow_dates(d);
END;
$$;

-- Mirrors the current issue derivation for the contract gate only. No approval/compliance flag is stored.
CREATE FUNCTION public.validate_workflow_contract_gate(d jsonb,jv integer,c public.job_classifications) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE
  cd jsonb:=c.data; item jsonb; pair record; answer jsonb; latest jsonb; money_field text; prefix text; issue text;
  required_issues text[]:=ARRAY['PERMIT_REVIEW:/permit','AMOUNT_BASIS_REVIEW:/amounts','ASBESTOS_REVIEW:/conditions/existingStructureWork','REGIONAL_REVIEW:','EVIDENCE_REVIEW:'];
  supplied boolean; split boolean; subcontracts boolean; electrical boolean:=false; general_building boolean:=false;
BEGIN
  IF c.job_id IS NULL OR c.basis_job_version IS DISTINCT FROM jv OR c.rules_version<>'p04-2026-10-23.1' OR c.catalog_version<>'construction-trades-2026-10-23.1'
    OR cd#>>'{context,market,state}'<>'known' OR cd#>>'{context,market,value}'<>'private'
    OR cd#>>'{context,workKind,state}'<>'known' OR cd#>>'{context,workKind,value}' NOT IN ('repair','renovation')
    OR cd#>>'{context,companyRole,state}'<>'known' OR cd#>>'{context,companyRole,value}' NOT IN ('prime_contractor','subcontractor')
    OR cd#>>'{context,targetKind,state}'<>'known' OR cd#>>'{context,targetKind,value}' NOT IN ('building','structure') THEN
    RAISE EXCEPTION 'Contract needs current in-scope classification' USING ERRCODE='23514'; END IF;
  IF pg_catalog.jsonb_array_length(cd->'workItems')=0 THEN RAISE EXCEPTION 'Contract scope unanswered' USING ERRCODE='23514'; END IF;
  FOR pair IN SELECT value,n FROM pg_catalog.jsonb_array_elements(cd->'workItems') WITH ORDINALITY x(value,n) LOOP
    item:=pair.value;prefix:='/workItems/' || (pair.n-1)::text;
    IF item#>>'{tradeCandidates,state}'<>'known' OR item#>>'{relationship,state}'<>'known' THEN RAISE EXCEPTION 'Contract trade unanswered' USING ERRCODE='23514'; END IF;
    required_issues:=pg_catalog.array_append(required_issues,'TRADE_REVIEW:' || prefix);
    IF item#>'{tradeCandidates,value}' ?| ARRAY['civil_general','building_general'] THEN required_issues:=pg_catalog.array_append(required_issues,'GENERAL_TRADE_REVIEW:' || prefix || '/tradeCandidates'); END IF;
    IF item#>>'{relationship,value}'='ancillary' THEN required_issues:=pg_catalog.array_append(required_issues,'ANCILLARY_REVIEW:' || prefix || '/relationship'); END IF;
    electrical:=electrical OR item#>'{tradeCandidates,value}' ? 'electrical';
    general_building:=general_building OR item#>'{tradeCandidates,value}' ? 'building_general';
  END LOOP;
  FOR pair IN SELECT * FROM pg_catalog.jsonb_each(cd->'conditions') LOOP
    IF pair.value->>'state'<>'known' THEN RAISE EXCEPTION 'Contract condition unanswered/unknown' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOREACH money_field IN ARRAY ARRAY['suppliedMaterials','splitContracts','subcontracting'] LOOP
    IF cd#>>ARRAY['amounts',money_field,'state']<>'known' THEN RAISE EXCEPTION 'Contract amount condition unanswered' USING ERRCODE='23514'; END IF;
  END LOOP;
  supplied:=cd#>>'{amounts,suppliedMaterials,value}'<>'no';split:=cd#>>'{amounts,splitContracts,value}'<>'no';subcontracts:=cd#>>'{amounts,subcontracting,value}'<>'no';
  FOREACH money_field IN ARRAY ARRAY['contract','suppliedMaterialValue','suppliedMaterialTransport','relatedContractValue','subcontractTotal'] LOOP
    answer:=cd->'amounts'->money_field;
    IF money_field='contract' OR (money_field IN ('suppliedMaterialValue','suppliedMaterialTransport') AND supplied)
      OR (money_field='relatedContractValue' AND split) OR (money_field='subcontractTotal' AND subcontracts) THEN
      IF answer->>'state'<>'known' OR answer#>>'{value,taxBasis}'='unknown' THEN RAISE EXCEPTION 'Contract amount unanswered/unknown' USING ERRCODE='23514'; END IF;
    END IF;
    IF answer->>'state'='known' AND answer#>>'{value,taxBasis}'='tax_excluded' THEN required_issues:=pg_catalog.array_append(required_issues,'TAX_BASIS_REVIEW:/amounts/' || money_field); END IF;
  END LOOP;
  IF split AND cd#>>'{amounts,splitReason,state}'<>'known' THEN RAISE EXCEPTION 'Split contract reason unanswered' USING ERRCODE='23514'; END IF;
  IF cd#>>'{permit,declaration,state}'<>'known' OR (cd#>>'{permit,declaration,value}'<>'not_held' AND cd#>>'{permit,reportedTrades,state}'<>'known') THEN
    RAISE EXCEPTION 'Permit declaration unanswered' USING ERRCODE='23514'; END IF;
  IF supplied THEN required_issues:=pg_catalog.array_append(required_issues,'SUPPLIED_MATERIAL_REVIEW:/amounts/suppliedMaterials'); END IF;
  IF split THEN required_issues:=pg_catalog.array_append(required_issues,'SPLIT_CONTRACT_REVIEW:/amounts/splitContracts'); END IF;
  IF subcontracts THEN required_issues:=pg_catalog.array_append(required_issues,'SUBCONTRACT_REVIEW:/amounts/subcontracting'); END IF;
  IF electrical OR cd#>>'{conditions,electricalWork,value}'<>'no' THEN required_issues:=pg_catalog.array_append(required_issues,'ELECTRICAL_REVIEW:/conditions/electricalWork'); END IF;
  IF cd#>>'{conditions,specifiedMaterials,value}'<>'no' OR cd#>>'{conditions,demolitionWork,value}'<>'no' THEN required_issues:=pg_catalog.array_append(required_issues,'RECYCLING_REVIEW:/conditions/specifiedMaterials'); END IF;
  IF cd#>>'{conditions,constructionWaste,value}'<>'no' OR cd#>>'{conditions,demolitionWork,value}'='yes' THEN required_issues:=pg_catalog.array_append(required_issues,'WASTE_REVIEW:/conditions/constructionWaste'); END IF;
  IF general_building OR cd#>>'{conditions,structuralChange,value}'<>'no' THEN required_issues:=pg_catalog.array_append(required_issues,'BUILDING_REVIEW:/conditions/structuralChange'); END IF;
  FOREACH issue IN ARRAY required_issues LOOP
    SELECT value INTO latest FROM pg_catalog.jsonb_array_elements(d->'reviews') WITH ORDINALITY x(value,n)
      WHERE value->>'issueId'=issue AND (value->>'jobVersion')::numeric=jv AND (value->>'classificationVersion')::numeric=c.version ORDER BY n DESC LIMIT 1;
    IF latest IS NULL OR latest->>'conclusion' NOT IN ('confirmed','not_applicable') OR latest->>'note'='' OR pg_catalog.jsonb_array_length(latest->'evidenceIds')=0 THEN
      RAISE EXCEPTION 'Contract review unresolved: %',issue USING ERRCODE='23514'; END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_workflow_contract_gate(jsonb,integer,public.job_classifications) FROM PUBLIC;

CREATE FUNCTION public.guard_workflow_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor text:=pg_catalog.current_setting('app.user_id',true); req text:=pg_catalog.current_setting('app.request_id',true);
  actor_role text; j public.jobs; c public.job_classifications; cv integer; cj integer; old_data jsonb:='{}'; d jsonb; section text; rec jsonb; old_rec jsonb;
  source jsonb; original jsonb; photo jsonb; snapshot jsonb; f text; ident text; ids text[]:=ARRAY[]::text[]; total numeric; balance numeric;
  job_snapshot jsonb; now_text text:=pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Workflow deletion forbidden' USING ERRCODE='42501'; END IF;
  IF actor IS NULL OR pg_catalog.btrim(actor)='' OR req IS NULL OR pg_catalog.btrim(req)='' THEN RAISE EXCEPTION 'Actor/request required' USING ERRCODE='23514'; END IF;
  SELECT m.role INTO actor_role FROM public.lock_membership(NEW.company_id) m;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','manager') THEN RAISE EXCEPTION 'Workflow write not authorized' USING ERRCODE='42501'; END IF;
  SELECT * INTO j FROM public.jobs WHERE company_id=NEW.company_id AND id=NEW.job_id FOR UPDATE;
  SELECT * INTO c FROM public.job_classifications WHERE company_id=NEW.company_id AND job_id=NEW.job_id;
  cv:=c.version; cj:=c.basis_job_version;
  IF j.id IS NULL OR NEW.basis_job_version IS DISTINCT FROM j.version OR NEW.classification_version IS DISTINCT FROM cv THEN
    RAISE EXCEPTION 'Workflow basis stale' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version IS DISTINCT FROM 1 OR NEW.updated_at IS NOT NULL OR NEW.updated_by IS NOT NULL THEN RAISE EXCEPTION 'Invalid workflow initial metadata' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
      OR NEW.updated_by IS DISTINCT FROM OLD.updated_by OR OLD.version=2147483647 OR NEW.version IS DISTINCT FROM OLD.version+1 THEN
      RAISE EXCEPTION 'Invalid workflow metadata/version' USING ERRCODE='23514';
    END IF;
    old_data:=OLD.data;
  END IF;
  d:=public.normalize_workflow_json(NEW.data);
  PERFORM public.validate_workflow_structure(d);
  job_snapshot:=pg_catalog.jsonb_build_object('id',j.id,'companyId',j.company_id,'version',j.version,'name',j.name,'siteAddress',j.site_address,
    'customerName',j.customer_name,'workDescription',j.work_description,'plannedStart',pg_catalog.to_char(j.planned_start,'YYYY-MM-DD'),
    'plannedEnd',pg_catalog.to_char(j.planned_end,'YYYY-MM-DD'),'createdBy',j.created_by,
    'createdAt',pg_catalog.to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',pg_catalog.to_char(j.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  FOREACH section IN ARRAY ARRAY['reviews','estimates','contracts','contractEvents','tasks','photos','notices','reports','invoices','payments','milestones'] LOOP
    FOR rec IN SELECT value FROM pg_catalog.jsonb_array_elements(d->section) LOOP
      ident:=rec->>'id';
      IF ident=ANY(ids) THEN RAISE EXCEPTION 'Duplicate workflow identity' USING ERRCODE='23514'; END IF;
      ids:=pg_catalog.array_append(ids,ident);
      IF rec ? 'evidenceIds' THEN
        FOR f IN SELECT value FROM pg_catalog.jsonb_array_elements_text(rec->'evidenceIds') LOOP
          IF NOT EXISTS(SELECT FROM public.job_files WHERE company_id=NEW.company_id AND job_id=NEW.job_id AND id=f::uuid) THEN RAISE EXCEPTION 'Evidence not owned by job' USING ERRCODE='23514'; END IF;
        END LOOP;
      END IF;
    END LOOP;
    IF section IN ('reviews','contractEvents','payments','milestones') THEN
      IF pg_catalog.jsonb_array_length(d->section)<pg_catalog.jsonb_array_length(COALESCE(old_data->section,'[]')) OR EXISTS(
        SELECT FROM pg_catalog.jsonb_array_elements(COALESCE(old_data->section,'[]')) WITH ORDINALITY x(value,n)
        WHERE d->section->((x.n-1)::integer) IS DISTINCT FROM x.value) THEN RAISE EXCEPTION 'Workflow history is append only' USING ERRCODE='23514'; END IF;
    END IF;
  END LOOP;
  FOR f IN SELECT value FROM pg_catalog.jsonb_array_elements_text(d#>'{laborInsurance,evidenceIds}') LOOP
    IF NOT EXISTS(SELECT FROM public.job_files WHERE company_id=NEW.company_id AND job_id=NEW.job_id AND id=f::uuid) THEN RAISE EXCEPTION 'Insurance evidence not owned' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF d#>>'{laborInsurance,startsOn}' IS NOT NULL AND d#>>'{laborInsurance,endsOn}' IS NOT NULL
    AND d#>>'{laborInsurance,endsOn}'<d#>>'{laborInsurance,startsOn}' THEN RAISE EXCEPTION 'Insurance dates' USING ERRCODE='23514'; END IF;
  FOR rec IN SELECT value FROM pg_catalog.jsonb_array_elements(d->'reviews') WITH ORDINALITY x(value,n)
    WHERE n>pg_catalog.jsonb_array_length(COALESCE(old_data->'reviews','[]')) LOOP
    IF cv IS NULL OR cj IS DISTINCT FROM j.version OR (rec->>'classificationVersion')::numeric<>cv OR (rec->>'jobVersion')::numeric<>j.version
      OR rec->>'reviewedOn'='' OR rec->>'note'='' OR (rec->>'conclusion'<>'needs_action' AND pg_catalog.jsonb_array_length(rec->'evidenceIds')=0) THEN
      RAISE EXCEPTION 'Review needs current basis, reason and evidence' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR rec IN SELECT value FROM pg_catalog.jsonb_array_elements(d->'photos') LOOP
    IF NOT EXISTS(SELECT FROM public.job_files WHERE company_id=NEW.company_id AND job_id=NEW.job_id AND id=(rec->>'fileId')::uuid AND kind='photo' AND content_type<>'application/pdf') THEN
      RAISE EXCEPTION 'Photo not owned by job' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOREACH section IN ARRAY ARRAY['estimates','contracts','notices','reports','invoices'] LOOP
    FOR old_rec IN SELECT value FROM pg_catalog.jsonb_array_elements(COALESCE(old_data->section,'[]')) WHERE value->>'status'='issued' LOOP
      IF NOT EXISTS(SELECT FROM pg_catalog.jsonb_array_elements(d->section) x WHERE x.value=old_rec) THEN RAISE EXCEPTION 'Issued document immutable' USING ERRCODE='23514'; END IF;
    END LOOP;
    snapshot:='[]';
    FOR rec IN SELECT value FROM pg_catalog.jsonb_array_elements(d->section) LOOP
      SELECT value INTO old_rec FROM pg_catalog.jsonb_array_elements(COALESCE(old_data->section,'[]')) WHERE value->>'id'=rec->>'id';
      IF section IN ('estimates','invoices') THEN
        PERFORM public.workflow_document_total(rec);
        IF (SELECT count(*)<>count(DISTINCT value->>'id') FROM pg_catalog.jsonb_array_elements(rec->'items')) THEN RAISE EXCEPTION 'Duplicate line IDs' USING ERRCODE='23514'; END IF;
      END IF;
      IF section='contracts' THEN
        SELECT value INTO source FROM pg_catalog.jsonb_array_elements(d->'estimates') WHERE value->>'id'=rec->>'estimateId';
        IF source IS NULL THEN RAISE EXCEPTION 'Contract estimate missing' USING ERRCODE='23514'; END IF;
        IF rec->>'kind'='change' THEN
          SELECT value INTO original FROM pg_catalog.jsonb_array_elements(d->'contracts') WHERE value->>'id'=rec->>'originalContractId';
          IF original IS NULL OR original->>'id'=rec->>'id' OR original->>'kind'<>'initial' OR original->>'status'<>'issued'
            OR rec->>'changeReason'='' OR rec->>'effectiveDate' IS NULL OR rec->>'effectiveDate'='' THEN RAISE EXCEPTION 'Invalid contract change source' USING ERRCODE='23514'; END IF;
        ELSIF rec->>'originalContractId' IS NOT NULL OR rec->>'changeReason'<>'' THEN RAISE EXCEPTION 'Unexpected initial contract change fields' USING ERRCODE='23514'; END IF;
      ELSIF section='invoices' THEN
        SELECT value INTO source FROM pg_catalog.jsonb_array_elements(d->'contracts') WHERE value->>'id'=rec->>'contractId';
        IF source IS NULL THEN RAISE EXCEPTION 'Invoice contract missing' USING ERRCODE='23514'; END IF;
        IF (rec->>'direction'='receivable') IS DISTINCT FROM (source->>'partyRole'='receiving') THEN RAISE EXCEPTION 'Invoice direction mismatch' USING ERRCODE='23514'; END IF;
      ELSIF section='reports' THEN
        FOR f IN SELECT value FROM pg_catalog.jsonb_array_elements_text(rec->'photoIds') LOOP
          IF NOT EXISTS(SELECT FROM pg_catalog.jsonb_array_elements(d->'photos') x WHERE x.value->>'id'=f) THEN RAISE EXCEPTION 'Report photo missing' USING ERRCODE='23514'; END IF;
        END LOOP;
      END IF;
      IF rec->>'status'='draft' THEN
        IF rec->>'issuedAt' IS NOT NULL OR rec->>'issuedBy' IS NOT NULL OR rec->>'basis' IS NOT NULL
          OR (section='reports' AND rec->>'photoSnapshot' IS NOT NULL) THEN RAISE EXCEPTION 'Draft publication metadata forbidden' USING ERRCODE='23514'; END IF;
      ELSIF old_rec IS NULL OR old_rec->>'status'<>'issued' THEN
        IF rec->>'issuedAt' IS NOT NULL OR rec->>'issuedBy' IS NOT NULL OR rec->>'basis' IS NOT NULL THEN RAISE EXCEPTION 'Publication metadata is server controlled' USING ERRCODE='23514'; END IF;
        IF section IN ('estimates','contracts','notices','reports') AND rec->>'title'='' THEN RAISE EXCEPTION 'Document title required' USING ERRCODE='23514'; END IF;
        IF section IN ('estimates','invoices') AND (rec->>'recipient'='' OR rec->>'issuer'='' OR rec->>'issuedOn'=''
          OR pg_catalog.jsonb_array_length(rec->'items')=0 OR EXISTS(SELECT FROM pg_catalog.jsonb_array_elements(rec->'items') x WHERE x.value->>'description'='' OR x.value->>'unit'='')) THEN RAISE EXCEPTION 'Incomplete priced document' USING ERRCODE='23514'; END IF;
        IF section='estimates' AND (rec->>'recipientAddress'='' OR rec->>'issuerAddress'='' OR (rec->>'validUntil' IS NOT NULL AND rec->>'validUntil'<>'' AND rec->>'validUntil'<rec->>'issuedOn')) THEN RAISE EXCEPTION 'Estimate addresses/validity required' USING ERRCODE='23514'; END IF;
        IF section='contracts' THEN
          PERFORM public.validate_workflow_contract_gate(d,j.version,c);
          IF source->>'status'<>'issued' OR rec->>'counterparty'='' OR rec->>'counterparty' IS DISTINCT FROM (CASE rec->>'partyRole' WHEN 'receiving' THEN source->>'recipient' ELSE source->>'issuer' END)
            OR rec->>'effectiveDate' IS NULL OR rec->>'effectiveDate'=''
            OR EXISTS(SELECT FROM pg_catalog.jsonb_each_text(rec->'terms') x WHERE x.value='' AND x.key NOT IN ('exclusions','nonWorkingDays'))
            OR rec#>>'{terms,endDate}'<rec#>>'{terms,startDate}' OR rec#>>'{terms,handoverDate}'<rec#>>'{terms,endDate}' THEN RAISE EXCEPTION 'Contract terms/source incomplete' USING ERRCODE='23514'; END IF;
        ELSIF section='invoices' THEN
          IF source->>'status'<>'issued' OR rec->>'number'='' OR rec->>'dueOn'='' OR rec->>'dueOn'<rec->>'issuedOn' OR rec->>'bank'='' THEN RAISE EXCEPTION 'Invoice incomplete' USING ERRCODE='23514'; END IF;
        ELSIF section='notices' THEN
          IF rec->>'recipient'='' OR rec->>'startsOn'='' OR rec->>'endsOn'='' OR rec->>'contactName'='' OR rec->>'contactPhone'='' OR rec->>'message'='' THEN RAISE EXCEPTION 'Notice incomplete' USING ERRCODE='23514'; END IF;
        ELSIF section='reports' THEN
          IF pg_catalog.jsonb_array_length(rec->'photoIds')=0 OR rec->>'photoSnapshot' IS NOT NULL THEN RAISE EXCEPTION 'Report photos required; snapshot server controlled' USING ERRCODE='23514'; END IF;
          SELECT pg_catalog.jsonb_agg(p.value ORDER BY wanted.n) INTO photo FROM pg_catalog.jsonb_array_elements_text(rec->'photoIds') WITH ORDINALITY wanted(id,n)
            JOIN pg_catalog.jsonb_array_elements(d->'photos') p ON p.value->>'id'=wanted.id;
          rec:=pg_catalog.jsonb_set(rec,'{photoSnapshot}',photo);
        END IF;
        rec:=rec || pg_catalog.jsonb_build_object('issuedAt',now_text,'issuedBy',actor,'basis',pg_catalog.jsonb_build_object('job',job_snapshot,'classificationVersion',cv));
      END IF;
      snapshot:=snapshot || pg_catalog.jsonb_build_array(rec);
    END LOOP;
    d:=pg_catalog.jsonb_set(d,ARRAY[section],snapshot);
  END LOOP;
  FOREACH section IN ARRAY ARRAY['tasks','notices'] LOOP
    FOR rec IN SELECT value FROM pg_catalog.jsonb_array_elements(d->section) LOOP
      IF rec->>'startsOn'<>'' AND rec->>'endsOn'<>'' AND rec->>'endsOn'<rec->>'startsOn' THEN RAISE EXCEPTION 'Invalid task/notice interval' USING ERRCODE='23514'; END IF;
      IF section='notices' AND rec->>'timeFrom'<>'' AND rec->>'timeTo'<>'' AND rec->>'timeTo'<rec->>'timeFrom' THEN RAISE EXCEPTION 'Invalid notice hours' USING ERRCODE='23514'; END IF;
    END LOOP;
  END LOOP;
  FOREACH section IN ARRAY ARRAY['contractEvents','milestones'] LOOP
    FOR rec IN SELECT value FROM pg_catalog.jsonb_array_elements(d->section) LOOP
      IF NOT EXISTS(SELECT FROM pg_catalog.jsonb_array_elements(d->'contracts') x WHERE x.value->>'id'=rec->>'contractId' AND x.value->>'status'='issued')
        OR rec->>'eventDate'='' OR rec->>'note'='' OR pg_catalog.jsonb_array_length(rec->'evidenceIds')=0
        OR (section='contractEvents' AND rec->>'counterparty'='') THEN RAISE EXCEPTION 'Manual event needs issued source/date/reason/evidence' USING ERRCODE='23514'; END IF;
    END LOOP;
  END LOOP;
  FOR rec IN SELECT value FROM pg_catalog.jsonb_array_elements(d->'payments') LOOP
    SELECT value INTO source FROM pg_catalog.jsonb_array_elements(d->'invoices') WHERE value->>'id'=rec->>'invoiceId' AND value->>'status'='issued';
    IF source IS NULL OR rec->>'paidOn'='' OR rec->>'method'='' OR (rec->>'amountYen')::numeric<=0 THEN RAISE EXCEPTION 'Invalid payment source/amount/date' USING ERRCODE='23514'; END IF;
    IF rec->>'type'='reversal' THEN
      SELECT value INTO original FROM pg_catalog.jsonb_array_elements(d->'payments') WHERE value->>'id'=rec->>'reversesId';
      IF original IS NULL OR original->>'type'<>'payment' OR original->>'invoiceId'<>rec->>'invoiceId' OR original->>'amountYen'<>rec->>'amountYen'
        OR rec->>'paidOn'<original->>'paidOn' OR rec->>'note'='' OR pg_catalog.jsonb_array_length(rec->'evidenceIds')=0
        OR (SELECT count(*) FROM pg_catalog.jsonb_array_elements(d->'payments') x WHERE x.value->>'reversesId'=original->>'id')<>1
        OR NOT EXISTS(SELECT FROM pg_catalog.jsonb_array_elements(d->'payments') WITH ORDINALITY a(value,n)
          JOIN pg_catalog.jsonb_array_elements(d->'payments') WITH ORDINALITY b(value,n) ON b.value->>'id'=rec->>'id'
          WHERE a.value->>'id'=original->>'id' AND a.n<b.n) THEN RAISE EXCEPTION 'Invalid/duplicate/cross-invoice reversal' USING ERRCODE='23514'; END IF;
    ELSIF rec->>'reversesId' IS NOT NULL THEN RAISE EXCEPTION 'Payment cannot reverse another payment' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR source IN SELECT value FROM pg_catalog.jsonb_array_elements(d->'invoices') LOOP
    total:=public.workflow_document_total(source); balance:=0;
    FOR rec IN SELECT value FROM pg_catalog.jsonb_array_elements(d->'payments') WHERE value->>'invoiceId'=source->>'id' LOOP
      balance:=balance+CASE rec->>'type' WHEN 'reversal' THEN -1 ELSE 1 END*(rec->>'amountYen')::numeric;
      IF balance<0 OR balance>total THEN RAISE EXCEPTION 'Payment exceeds invoice balance' USING ERRCODE='23514'; END IF;
    END LOOP;
  END LOOP;
  NEW.data:=d; NEW.updated_by:=actor; NEW.updated_at:=pg_catalog.clock_timestamp(); RETURN NEW;
END;
$$;
CREATE FUNCTION public.audit_workflow_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor_name text; previous_data jsonb;
BEGIN
  SELECT name INTO STRICT actor_name FROM public."user" WHERE id=NEW.updated_by;
  IF TG_OP='UPDATE' THEN previous_data:=OLD.data; END IF;
  INSERT INTO public.workflow_audit_events(company_id,job_id,version,actor_id,actor_name,occurred_at,request_id,before_data,after_data)
    VALUES(NEW.company_id,NEW.job_id,NEW.version,NEW.updated_by,actor_name,NEW.updated_at,pg_catalog.current_setting('app.request_id',true),previous_data,NEW.data);
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.guard_file_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=pg_catalog.current_setting('app.user_id',true); req text:=pg_catalog.current_setting('app.request_id',true); actor_role text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Stored files immutable' USING ERRCODE='42501'; END IF;
  IF actor IS NULL OR pg_catalog.btrim(actor)='' OR req IS NULL OR pg_catalog.btrim(req)='' THEN RAISE EXCEPTION 'File requires actor/request' USING ERRCODE='23514'; END IF;
  SELECT m.role INTO actor_role FROM public.lock_membership(NEW.company_id) m;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','manager') THEN RAISE EXCEPTION 'File write unauthorized' USING ERRCODE='42501'; END IF;
  PERFORM id FROM public.jobs WHERE company_id=NEW.company_id AND id=NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'File job missing' USING ERRCODE='23514'; END IF;
  IF NEW.created_at IS NOT NULL OR NEW.created_by IS NOT NULL OR NEW.created_by_name IS NOT NULL OR NEW.request_id IS NOT NULL THEN RAISE EXCEPTION 'File attribution database controlled' USING ERRCODE='23514'; END IF;
  NEW.created_by:=actor; SELECT name INTO STRICT NEW.created_by_name FROM public."user" WHERE id=actor;
  NEW.created_at:=pg_catalog.clock_timestamp(); NEW.request_id:=req; RETURN NEW;
END;
$$;
CREATE TRIGGER workflows_guard_write BEFORE INSERT OR UPDATE OR DELETE ON public.job_workflows FOR EACH ROW EXECUTE FUNCTION public.guard_workflow_write();
CREATE TRIGGER workflows_audit_write AFTER INSERT OR UPDATE ON public.job_workflows FOR EACH ROW EXECUTE FUNCTION public.audit_workflow_write();
CREATE TRIGGER files_guard_write BEFORE INSERT OR UPDATE OR DELETE ON public.job_files FOR EACH ROW EXECUTE FUNCTION public.guard_file_write();
REVOKE ALL ON FUNCTION public.normalize_workflow_json(jsonb,text),public.validate_workflow_dates(jsonb,text),public.workflow_document_total(jsonb),
  public.validate_workflow_structure(jsonb),public.guard_workflow_write(),public.audit_workflow_write(),public.guard_file_write() FROM PUBLIC;
