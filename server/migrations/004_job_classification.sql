CREATE TABLE public.job_classifications (
  company_id uuid NOT NULL, job_id uuid NOT NULL, version integer NOT NULL CHECK (version>0),
  data jsonb NOT NULL, basis_job_version integer NOT NULL CHECK (basis_job_version>0), basis_job_snapshot jsonb NOT NULL,
  rules_version text NOT NULL, catalog_version text NOT NULL,
  created_by text NOT NULL REFERENCES public."user"(id), created_by_name text NOT NULL, created_at timestamptz NOT NULL,
  updated_by text NOT NULL REFERENCES public."user"(id), updated_by_name text NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (company_id,job_id), FOREIGN KEY(company_id,job_id) REFERENCES public.jobs(company_id,id)
);
CREATE TABLE public.classification_audit_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), company_id uuid NOT NULL, job_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES public."user"(id), actor_name text NOT NULL,
  action text NOT NULL CHECK(action IN ('classification.created','classification.updated')),
  occurred_at timestamptz NOT NULL, target_version integer NOT NULL CHECK(target_version>0),
  request_id text NOT NULL CHECK(length(btrim(request_id))>0), before_data jsonb, after_data jsonb NOT NULL,
  FOREIGN KEY(company_id,job_id) REFERENCES public.job_classifications(company_id,job_id),
  UNIQUE(company_id,job_id,target_version)
);
ALTER TABLE public.job_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classification_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY classification_read ON public.job_classifications FOR SELECT USING (
  EXISTS(SELECT 1 FROM public.memberships m WHERE m.company_id=job_classifications.company_id));
CREATE POLICY classification_create ON public.job_classifications FOR INSERT WITH CHECK (
  EXISTS(SELECT 1 FROM public.memberships m WHERE m.company_id=job_classifications.company_id AND m.role IN ('owner','manager')));
CREATE POLICY classification_update ON public.job_classifications FOR UPDATE USING (
  EXISTS(SELECT 1 FROM public.memberships m WHERE m.company_id=job_classifications.company_id AND m.role IN ('owner','manager')))
  WITH CHECK(EXISTS(SELECT 1 FROM public.memberships m WHERE m.company_id=job_classifications.company_id AND m.role IN ('owner','manager')));
CREATE POLICY classification_audit_read ON public.classification_audit_events FOR SELECT USING (
  EXISTS(SELECT 1 FROM public.memberships m WHERE m.company_id=classification_audit_events.company_id AND m.role IN ('owner','manager')));
REVOKE ALL ON public.job_classifications,public.classification_audit_events FROM PUBLIC;

CREATE FUNCTION public.trim_classification_json(v jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE result jsonb; pair record;
BEGIN
  CASE pg_catalog.jsonb_typeof(v)
  WHEN 'string' THEN
    -- ECMAScript String.trim whitespace, including BOM and Unicode separators.
    RETURN pg_catalog.to_jsonb(pg_catalog.btrim(v#>>'{}',
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));
  WHEN 'array' THEN
    SELECT COALESCE(pg_catalog.jsonb_agg(public.trim_classification_json(x.value) ORDER BY x.ordinality),'[]'::jsonb)
      INTO result FROM pg_catalog.jsonb_array_elements(v) WITH ORDINALITY x(value,ordinality);
    RETURN result;
  WHEN 'object' THEN
    result:='{}'::jsonb;
    FOR pair IN SELECT * FROM pg_catalog.jsonb_each(v) LOOP
      result:=result || pg_catalog.jsonb_build_object(pair.key,public.trim_classification_json(pair.value));
    END LOOP;
    RETURN result;
  ELSE RETURN v;
  END CASE;
END;
$$;
CREATE FUNCTION public.matches_classification_schema(v jsonb,s jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE pair record; item jsonb; kind text:=pg_catalog.jsonb_typeof(v);
BEGIN
  IF s IS NULL OR pg_catalog.jsonb_typeof(s)<>'object' OR EXISTS(
    SELECT FROM pg_catalog.jsonb_object_keys(s) k WHERE k NOT IN
      ('type','anyOf','enum','properties','required','additionalProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','pattern')) THEN
    RAISE EXCEPTION 'Unsupported classification schema' USING ERRCODE='23514';
  END IF;
  IF s ? 'anyOf' THEN
    IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(s))<>1 THEN
      RAISE EXCEPTION 'Unsupported classification union schema' USING ERRCODE='23514';
    END IF;
    FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(s->'anyOf') LOOP
      IF public.matches_classification_schema(v,item) THEN RETURN true; END IF;
    END LOOP;
    RETURN false;
  END IF;
  IF COALESCE(s->>'type','') NOT IN ('integer','object','array','string','null') THEN
    RAISE EXCEPTION 'Unsupported classification schema type' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT FROM pg_catalog.jsonb_object_keys(s) k WHERE NOT k=ANY(CASE s->>'type'
    WHEN 'object' THEN ARRAY['type','enum','properties','required','additionalProperties']
    WHEN 'array' THEN ARRAY['type','enum','items','minItems','maxItems','uniqueItems']
    WHEN 'string' THEN ARRAY['type','enum','minLength','maxLength','pattern']
    ELSE ARRAY['type','enum'] END)) THEN
    RAISE EXCEPTION 'Unsupported classification schema keyword for type' USING ERRCODE='23514';
  END IF;
  IF s ? 'enum' AND NOT EXISTS(SELECT FROM pg_catalog.jsonb_array_elements(s->'enum') x WHERE x.value=v) THEN RETURN false; END IF;
  IF s->>'type'='integer' THEN
    IF kind IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    RETURN kind='number' AND (v#>>'{}')::numeric=pg_catalog.trunc((v#>>'{}')::numeric);
  END IF;
  IF kind IS DISTINCT FROM s->>'type' THEN RETURN false; END IF;
  CASE kind
  WHEN 'object' THEN
    IF s->'additionalProperties' IS DISTINCT FROM 'false'::jsonb OR pg_catalog.jsonb_typeof(s->'properties') IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(s->'required') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Unsupported classification object schema' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(v))<>pg_catalog.jsonb_array_length(s->'required') THEN RETURN false; END IF;
    FOR pair IN SELECT * FROM pg_catalog.jsonb_each(s->'properties') LOOP
      IF NOT v ? pair.key OR NOT public.matches_classification_schema(v->pair.key,pair.value) THEN RETURN false; END IF;
    END LOOP;
  WHEN 'array' THEN
    IF pg_catalog.jsonb_array_length(v)<COALESCE((s->>'minItems')::integer,0)
      OR pg_catalog.jsonb_array_length(v)>COALESCE((s->>'maxItems')::integer,2147483647) THEN RETURN false; END IF;
    IF s->>'uniqueItems'='true' AND
      (SELECT count(*)<>count(DISTINCT value) FROM pg_catalog.jsonb_array_elements(v)) THEN RETURN false; END IF;
    FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(v) LOOP
      IF NOT public.matches_classification_schema(item,s->'items') THEN RETURN false; END IF;
    END LOOP;
  WHEN 'string' THEN
    IF pg_catalog.length(v#>>'{}')<COALESCE((s->>'minLength')::integer,0)
      OR pg_catalog.length(v#>>'{}')>COALESCE((s->>'maxLength')::integer,2147483647)
      OR (s ? 'pattern' AND (v#>>'{}') !~ (s->>'pattern')) THEN RETURN false; END IF;
  ELSE NULL;
  END CASE;
  RETURN true;
END;
$$;
CREATE FUNCTION public.validate_classification_data(input jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE
  d jsonb:=public.trim_classification_json(input);
  schema_doc jsonb:=$schema${"type":"object","additionalProperties":false,"required":["schemaVersion","context","workItems","amounts","permit","conditions","note"],"properties":{"schemaVersion":{"type":"integer","enum":[1]},"context":{"type":"object","additionalProperties":false,"required":["market","companyRole","workKind","targetKind"],"properties":{"market":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["private","public"]},"reason":{"type":"null"}}}]},"companyRole":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["prime_contractor","subcontractor","owner","other"]},"reason":{"type":"null"}}}]},"workKind":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["repair","renovation","demolition","new_build","other"]},"reason":{"type":"null"}}}]},"targetKind":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["building","structure","other"]},"reason":{"type":"null"}}}]}}},"workItems":{"type":"array","minItems":0,"maxItems":12,"items":{"type":"object","additionalProperties":false,"required":["id","description","tradeCandidates","relationship","parentItemId"],"properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"description":{"type":"string","minLength":1,"maxLength":300},"tradeCandidates":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"array","minItems":1,"maxItems":29,"uniqueItems":true,"items":{"type":"string","enum":["civil_general","building_general","carpentry","plastering","scaffolding_earthwork_concrete","stone","roofing","electrical","plumbing","tile_brick_block","steel_structure","reinforcing_steel","paving","dredging","sheet_metal","glass","painting","waterproofing","interior_finishing","machinery_installation","thermal_insulation","telecommunications","landscaping","well_drilling","fittings","water_facilities","fire_protection","sanitation_facilities","demolition"]}},"reason":{"type":"null"}}}]},"relationship":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["primary","ancillary","independent"]},"reason":{"type":"null"}}}]},"parentItemId":{"anyOf":[{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},{"type":"null"}]}}}},"amounts":{"type":"object","additionalProperties":false,"required":["contract","suppliedMaterials","suppliedMaterialValue","suppliedMaterialTransport","splitContracts","relatedContractValue","splitReason","subcontracting","subcontractTotal"],"properties":{"contract":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"object","additionalProperties":false,"required":["yen","taxBasis"],"properties":{"yen":{"type":"string","pattern":"^(0|[1-9][0-9]{0,11})$"},"taxBasis":{"type":"string","enum":["tax_included","tax_excluded","unknown"]}}},"reason":{"type":"null"}}}]},"suppliedMaterials":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["yes","no"]},"reason":{"type":"null"}}}]},"suppliedMaterialValue":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"object","additionalProperties":false,"required":["yen","taxBasis"],"properties":{"yen":{"type":"string","pattern":"^(0|[1-9][0-9]{0,11})$"},"taxBasis":{"type":"string","enum":["tax_included","tax_excluded","unknown"]}}},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["not_applicable"]},"value":{"type":"null"},"reason":{"type":"string","minLength":1,"maxLength":300}}}]},"suppliedMaterialTransport":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"object","additionalProperties":false,"required":["yen","taxBasis"],"properties":{"yen":{"type":"string","pattern":"^(0|[1-9][0-9]{0,11})$"},"taxBasis":{"type":"string","enum":["tax_included","tax_excluded","unknown"]}}},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["not_applicable"]},"value":{"type":"null"},"reason":{"type":"string","minLength":1,"maxLength":300}}}]},"splitContracts":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["yes","no"]},"reason":{"type":"null"}}}]},"relatedContractValue":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"object","additionalProperties":false,"required":["yen","taxBasis"],"properties":{"yen":{"type":"string","pattern":"^(0|[1-9][0-9]{0,11})$"},"taxBasis":{"type":"string","enum":["tax_included","tax_excluded","unknown"]}}},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["not_applicable"]},"value":{"type":"null"},"reason":{"type":"string","minLength":1,"maxLength":300}}}]},"splitReason":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","minLength":1,"maxLength":500},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["not_applicable"]},"value":{"type":"null"},"reason":{"type":"string","minLength":1,"maxLength":300}}}]},"subcontracting":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["yes","no"]},"reason":{"type":"null"}}}]},"subcontractTotal":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"object","additionalProperties":false,"required":["yen","taxBasis"],"properties":{"yen":{"type":"string","pattern":"^(0|[1-9][0-9]{0,11})$"},"taxBasis":{"type":"string","enum":["tax_included","tax_excluded","unknown"]}}},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["not_applicable"]},"value":{"type":"null"},"reason":{"type":"string","minLength":1,"maxLength":300}}}]}}},"permit":{"type":"object","additionalProperties":false,"required":["declaration","reportedTrades","note"],"properties":{"declaration":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["held","not_held","renewal_pending"]},"reason":{"type":"null"}}}]},"reportedTrades":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"array","minItems":1,"maxItems":29,"uniqueItems":true,"items":{"type":"string","enum":["civil_general","building_general","carpentry","plastering","scaffolding_earthwork_concrete","stone","roofing","electrical","plumbing","tile_brick_block","steel_structure","reinforcing_steel","paving","dredging","sheet_metal","glass","painting","waterproofing","interior_finishing","machinery_installation","thermal_insulation","telecommunications","landscaping","well_drilling","fittings","water_facilities","fire_protection","sanitation_facilities","demolition"]}},"reason":{"type":"null"}}}]},"note":{"type":"string","minLength":0,"maxLength":1000}}},"conditions":{"type":"object","additionalProperties":false,"required":["electricalWork","existingStructureWork","demolitionWork","specifiedMaterials","constructionWaste","structuralChange"],"properties":{"electricalWork":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["yes","no"]},"reason":{"type":"null"}}}]},"existingStructureWork":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["yes","no"]},"reason":{"type":"null"}}}]},"demolitionWork":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["yes","no"]},"reason":{"type":"null"}}}]},"specifiedMaterials":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["yes","no"]},"reason":{"type":"null"}}}]},"constructionWaste":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["yes","no"]},"reason":{"type":"null"}}}]},"structuralChange":{"anyOf":[{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["unanswered","unknown"]},"value":{"type":"null"},"reason":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["state","value","reason"],"properties":{"state":{"type":"string","enum":["known"]},"value":{"type":"string","enum":["yes","no"]},"reason":{"type":"null"}}}]}}},"note":{"type":"string","minLength":0,"maxLength":2000}}}$schema$::jsonb;
  item jsonb; parent jsonb; field_name text; parent_name text; child jsonb; no_parent boolean;
  items jsonb:='[]'::jsonb;
BEGIN
  IF d IS NULL OR NOT public.matches_classification_schema(d,schema_doc) THEN
    RAISE EXCEPTION 'Invalid classification structure' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(d->'workItems') LOOP
    item:=pg_catalog.jsonb_set(item,'{id}',pg_catalog.to_jsonb(pg_catalog.lower(item->>'id')));
    IF item->>'parentItemId' IS NOT NULL THEN
      item:=pg_catalog.jsonb_set(item,'{parentItemId}',pg_catalog.to_jsonb(pg_catalog.lower(item->>'parentItemId')));
    END IF;
    items:=items || pg_catalog.jsonb_build_array(item);
  END LOOP;
  d:=pg_catalog.jsonb_set(d,'{workItems}',items);
  IF (SELECT count(*)<>count(DISTINCT value->>'id') FROM pg_catalog.jsonb_array_elements(items))
    OR (SELECT count(*)>1 FROM pg_catalog.jsonb_array_elements(items) WHERE value#>>'{relationship,value}'='primary') THEN
    RAISE EXCEPTION 'Invalid classification work identities' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(items) LOOP
    IF item#>>'{relationship,value}'='ancillary' THEN
      SELECT value INTO parent FROM pg_catalog.jsonb_array_elements(items) WHERE value->>'id'=item->>'parentItemId';
      IF parent IS NULL OR parent->>'id'=item->>'id'
        OR COALESCE(parent#>>'{relationship,value}','') NOT IN ('primary','independent') THEN
        RAISE EXCEPTION 'Invalid classification parent' USING ERRCODE='23514';
      END IF;
    ELSIF item->>'parentItemId' IS NOT NULL THEN
      RAISE EXCEPTION 'Unexpected classification parent' USING ERRCODE='23514';
    END IF;
  END LOOP;
  FOR field_name,parent_name IN SELECT * FROM (VALUES
    ('suppliedMaterialValue','suppliedMaterials'),('suppliedMaterialTransport','suppliedMaterials'),
    ('relatedContractValue','splitContracts'),('splitReason','splitContracts'),('subcontractTotal','subcontracting')) pairs LOOP
    child:=d->'amounts'->field_name;
    no_parent:=COALESCE(d#>>ARRAY['amounts',parent_name,'value']='no',false);
    IF (no_parent AND child->>'state'='known') OR (NOT no_parent AND child->>'state'='not_applicable') THEN
      RAISE EXCEPTION 'Contradictory classification answer' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF d#>>'{permit,declaration,value}'='not_held' AND d#>>'{permit,reportedTrades,state}'='known' THEN
    RAISE EXCEPTION 'Contradictory permit declaration' USING ERRCODE='23514';
  END IF;
  RETURN d;
END;
$$;
CREATE FUNCTION public.classification_record(c public.job_classifications) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT pg_catalog.jsonb_build_object(
    'companyId',c.company_id,'jobId',c.job_id,'version',c.version,'data',c.data,
    'basisJob',c.basis_job_snapshot,'rulesVersion',c.rules_version,'catalogVersion',c.catalog_version,
    'createdBy',pg_catalog.jsonb_build_object('id',c.created_by,'name',c.created_by_name),
    'updatedBy',pg_catalog.jsonb_build_object('id',c.updated_by,'name',c.updated_by_name),
    'createdAt',pg_catalog.to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',pg_catalog.to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;
CREATE FUNCTION public.guard_classification_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor text:=pg_catalog.current_setting('app.user_id',true);
  req text:=pg_catalog.current_setting('app.request_id',true);
  actor_role text; actor_name text; j public.jobs;
BEGIN
  IF actor IS NULL OR pg_catalog.btrim(actor)='' OR req IS NULL OR pg_catalog.btrim(req)='' THEN
    RAISE EXCEPTION 'Classification requires actor and request context' USING ERRCODE='23514';
  END IF;
  SELECT m.role INTO actor_role FROM public.lock_membership(NEW.company_id) m;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','manager') THEN
    RAISE EXCEPTION 'Classification write not authorized' USING ERRCODE='42501';
  END IF;
  SELECT * INTO j FROM public.jobs WHERE company_id=NEW.company_id AND id=NEW.job_id FOR UPDATE;
  IF j.id IS NULL OR NEW.basis_job_version IS DISTINCT FROM j.version THEN
    RAISE EXCEPTION 'Classification job version mismatch' USING ERRCODE='23514';
  END IF;
  NEW.data:=public.validate_classification_data(NEW.data);
  SELECT u.name INTO STRICT actor_name FROM public."user" u WHERE u.id=actor;
  IF TG_OP='INSERT' THEN
    IF NEW.version IS DISTINCT FROM 1 OR NEW.basis_job_snapshot IS NOT NULL OR NEW.rules_version IS NOT NULL
      OR NEW.catalog_version IS NOT NULL OR NEW.created_by IS NOT NULL OR NEW.created_by_name IS NOT NULL
      OR NEW.created_at IS NOT NULL OR NEW.updated_by IS NOT NULL OR NEW.updated_by_name IS NOT NULL OR NEW.updated_at IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial classification metadata' USING ERRCODE='23514';
    END IF;
    NEW.created_by:=actor; NEW.created_by_name:=actor_name; NEW.created_at:=pg_catalog.clock_timestamp();
  ELSE
    IF OLD.version=2147483647 OR NEW.version IS DISTINCT FROM OLD.version+1 THEN
      RAISE EXCEPTION 'Classification version must advance by one' USING ERRCODE='23514';
    END IF;
    IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
      OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_by_name IS DISTINCT FROM OLD.created_by_name
      OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.updated_by IS DISTINCT FROM OLD.updated_by
      OR NEW.updated_by_name IS DISTINCT FROM OLD.updated_by_name OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
      OR NEW.basis_job_snapshot IS DISTINCT FROM OLD.basis_job_snapshot
      OR NEW.rules_version IS DISTINCT FROM OLD.rules_version OR NEW.catalog_version IS DISTINCT FROM OLD.catalog_version THEN
      RAISE EXCEPTION 'Classification metadata is database controlled' USING ERRCODE='23514';
    END IF;
  END IF;
  NEW.basis_job_snapshot:=pg_catalog.jsonb_build_object('version',j.version,'name',j.name,'siteAddress',j.site_address,
    'customerName',j.customer_name,'workDescription',j.work_description,
    'plannedStart',pg_catalog.to_char(j.planned_start,'YYYY-MM-DD'),'plannedEnd',pg_catalog.to_char(j.planned_end,'YYYY-MM-DD'));
  NEW.rules_version:='p04-2026-10-23.1'; NEW.catalog_version:='construction-trades-2026-10-23.1';
  NEW.updated_by:=actor; NEW.updated_by_name:=actor_name;
  NEW.updated_at:=CASE WHEN TG_OP='INSERT' THEN NEW.created_at ELSE pg_catalog.clock_timestamp() END;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.audit_classification_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO public.classification_audit_events(company_id,job_id,actor_id,actor_name,action,occurred_at,target_version,request_id,before_data,after_data)
  VALUES(NEW.company_id,NEW.job_id,NEW.updated_by,NEW.updated_by_name,
    CASE WHEN TG_OP='INSERT' THEN 'classification.created' ELSE 'classification.updated' END,
    NEW.updated_at,NEW.version,pg_catalog.current_setting('app.request_id',true),
    CASE WHEN TG_OP='UPDATE' THEN public.classification_record(OLD) ELSE NULL END,public.classification_record(NEW));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trim_classification_json(jsonb),public.matches_classification_schema(jsonb,jsonb),
  public.validate_classification_data(jsonb),public.classification_record(public.job_classifications),
  public.guard_classification_write(),public.audit_classification_write() FROM PUBLIC;
CREATE TRIGGER classifications_guard_write BEFORE INSERT OR UPDATE ON public.job_classifications
  FOR EACH ROW EXECUTE FUNCTION public.guard_classification_write();
CREATE TRIGGER classifications_audit_write AFTER INSERT OR UPDATE ON public.job_classifications
  FOR EACH ROW EXECUTE FUNCTION public.audit_classification_write();
