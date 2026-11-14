CREATE TABLE companies (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE memberships (
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id text NOT NULL REFERENCES "user"(id),
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'viewer')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  site_address text NOT NULL CHECK (length(btrim(site_address)) BETWEEN 1 AND 250),
  customer_name text NOT NULL CHECK (length(btrim(customer_name)) BETWEEN 1 AND 120),
  work_description text NOT NULL CHECK (length(btrim(work_description)) BETWEEN 1 AND 2000),
  planned_start date,
  planned_end date,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL REFERENCES "user"(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (planned_start IS NULL OR planned_end IS NULL OR planned_end >= planned_start)
);
CREATE INDEX jobs_company_created ON jobs(company_id, created_at DESC, id DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  actor_id text NOT NULL REFERENCES "user"(id),
  action text NOT NULL CHECK (action IN ('job.created', 'job.updated')),
  target_id uuid NOT NULL REFERENCES jobs(id),
  before_data jsonb,
  after_data jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_events_target ON audit_events(company_id, target_id, occurred_at DESC);

CREATE TABLE creation_requests (
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id text NOT NULL REFERENCES "user"(id),
  request_key uuid NOT NULL,
  body_hash text NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id),
  response_data jsonb NOT NULL,
  PRIMARY KEY (company_id, user_id, request_key)
);

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE creation_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY memberships_self ON memberships FOR SELECT
  USING (user_id = current_setting('app.user_id', true) AND active);
CREATE POLICY companies_member ON companies FOR SELECT USING
  (EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = companies.id));
CREATE POLICY jobs_read ON jobs FOR SELECT USING
  (EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = jobs.company_id));
CREATE POLICY jobs_create ON jobs FOR INSERT WITH CHECK
  (created_by = current_setting('app.user_id', true) AND EXISTS
    (SELECT 1 FROM memberships m WHERE m.company_id = jobs.company_id AND m.role IN ('owner', 'manager')));
CREATE POLICY jobs_update ON jobs FOR UPDATE USING
  (EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = jobs.company_id AND m.role IN ('owner', 'manager')))
  WITH CHECK (EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = jobs.company_id AND m.role IN ('owner', 'manager')));
CREATE POLICY audit_read ON audit_events FOR SELECT USING
  (EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = audit_events.company_id AND m.role IN ('owner', 'manager')));
CREATE POLICY audit_create ON audit_events FOR INSERT WITH CHECK
  (actor_id = current_setting('app.user_id', true) AND EXISTS
    (SELECT 1 FROM memberships m WHERE m.company_id = audit_events.company_id AND m.role IN ('owner', 'manager'))
    AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = target_id AND j.company_id = audit_events.company_id));
CREATE POLICY requests_read ON creation_requests FOR SELECT USING
  (user_id = current_setting('app.user_id', true) AND EXISTS
    (SELECT 1 FROM memberships m WHERE m.company_id = creation_requests.company_id AND m.role IN ('owner', 'manager')));
CREATE POLICY requests_create ON creation_requests FOR INSERT WITH CHECK
  (user_id = current_setting('app.user_id', true) AND EXISTS
    (SELECT 1 FROM memberships m WHERE m.company_id = creation_requests.company_id AND m.role IN ('owner', 'manager')));

REVOKE ALL ON companies, memberships, jobs, audit_events, creation_requests FROM PUBLIC;
