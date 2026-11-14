import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { getMigrations } from 'better-auth/db/migration'
import { buildApp } from '../server/app.ts'
import { readConfig } from '../server/config.ts'
import { assertRuntimeRole, createPool, transaction } from '../server/db.ts'
import { HttpError, normalizeJob } from '../server/jobs.ts'
import { authOptions, createAuth } from '../server/auth.ts'
import { migrate } from '../server/migrate.ts'

const dbName = `construction_test_${randomBytes(6).toString('hex')}`
const adminUrl = new URL(process.env.DATABASE_ADMIN_URL)
const appUrl = new URL(process.env.DATABASE_URL)
if (adminUrl.hostname !== '127.0.0.1' || appUrl.hostname !== '127.0.0.1') throw new Error('Integration tests require a local database')
const baseUrl = new URL(adminUrl)
baseUrl.pathname = '/postgres'
adminUrl.pathname = `/${dbName}`
appUrl.pathname = `/${dbName}`
const control = createPool(baseUrl.href)
const owner = createPool(adminUrl.href)
const runtime = createPool(appUrl.href)
const config = readConfig({ ...process.env, DATABASE_URL: appUrl.href })
const companies = [randomUUID(), randomUUID()]
const password = randomBytes(24).toString('base64url')
let app, auth, accountA, accountB, viewer, cookieA, cookieB, cookieViewer, job
const input = { name: '民間修繕テスト', siteAddress: '東京都 テスト用所在地', customerName: '試験発注者', workDescription: '玄関ドア修繕', plannedStart: '2026-11-01', plannedEnd: '2026-11-03' }
const url = (company = companies[0], suffix = '') => `/api/companies/${company}/jobs${suffix}`
const req = (method, endpoint, payload, cookie = cookieA, extra = {}) => app.inject({ method, url: endpoint,
  headers: { origin: config.origin, ...(cookie ? { cookie } : {}), ...extra }, ...(payload === undefined ? {} : { payload }) })
const create = (body = input, key = randomUUID(), cookie = cookieA, company = companies[0]) => req('POST', url(company), body, cookie, { 'idempotency-key': key })

before(async () => {
  await control.query(`CREATE DATABASE ${dbName}`)
  await migrate(owner, config, process.env.DB_APP_PASSWORD)
  await migrate(owner, config, process.env.DB_APP_PASSWORD)
  auth = createAuth(owner, config, true)
  const provision = async (email, name) => (await auth.api.signUpEmail({ body: { email, name, password } })).user
  accountA = await provision('a@tests.invalid', 'A担当者')
  accountB = await provision('b@tests.invalid', 'B担当者')
  viewer = await provision('viewer@tests.invalid', '閲覧者')
  await owner.query("INSERT INTO companies(id,name) VALUES($1,'会社A'),($2,'会社B')", companies)
  await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'manager'),($1,$5,'viewer')", [companies[0], accountA.id, companies[1], accountB.id, viewer.id])
  app = await buildApp(runtime, config)
  const login = async (email) => {
    const response = await req('POST', '/api/auth/sign-in/email', { email, password }, null)
    assert.equal(response.statusCode, 200, response.body)
    const cookies = response.headers['set-cookie']
    assert.ok(cookies)
    assert.match(String(cookies), /HttpOnly/i)
    assert.match(String(cookies), /SameSite=Lax/i)
    return (Array.isArray(cookies) ? cookies : [cookies]).map(v => v.split(';')[0]).join('; ')
  }
  cookieA = await login(accountA.email)
  cookieB = await login(accountB.email)
  cookieViewer = await login(viewer.email)
})

after(async () => {
  await app?.close()
  await runtime.end()
  await owner.end()
  // The random test-only name is never taken from user input or a runtime database URL.
  assert.match(dbName, /^construction_test_[a-f0-9]{12}$/)
  await control.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  await control.end()
})

test('fails closed when production uses HTTP, weak secrets or admin credentials', () => {
  assert.throws(() => readConfig({ ...process.env, NODE_ENV: 'production' }))
  assert.throws(() => readConfig({ ...process.env, BETTER_AUTH_SECRET: 'secret' }))
  assert.throws(() => readConfig({ ...process.env, APP_ORIGIN: 'http://0.0.0.0:5173' }))
})
test('API refuses to run with DB owner privileges', async () => { await assert.rejects(buildApp(owner, config), /non-owner/) })
test('unauthenticated and fabricated cookies cannot read jobs', async () => {
  assert.equal((await req('GET', url(), undefined, null)).statusCode, 401)
  assert.equal((await req('GET', '/api/me', undefined, 'construction.session_token=forged')).statusCode, 401)
})
test('public sign-up and unsupported auth endpoints are unavailable', async () => {
  assert.equal((await req('POST', '/api/auth/sign-up/email', { email: 'x@tests.invalid', password, name: 'x' }, null)).statusCode, 404)
  assert.equal((await req('POST', '/api/auth/delete-user', {}, cookieA)).statusCode, 404)
})
test('foreign and missing origins cannot mutate or sign in', async () => {
  assert.equal((await create(input, randomUUID(), cookieA)).statusCode, 201)
  assert.equal((await req('POST', url(), input, cookieA, { origin: 'https://evil.invalid', 'idempotency-key': randomUUID() })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', payload: { email: accountA.email, password } })).statusCode, 403)
})
test('me returns only active memberships and does not cache private data', async () => {
  const res = await req('GET', '/api/me')
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().companies.length, 1)
  assert.equal(res.json().companies[0].id, companies[0])
  assert.equal(res.headers['cache-control'], 'no-store')
})
test('create commits job and one server-attributed history entry', async () => {
  const res = await create()
  assert.equal(res.statusCode, 201, res.body)
  job = res.json()
  assert.equal(job.version, 1)
  assert.equal(job.createdBy, accountA.id)
  const events = (await req('GET', url(companies[0], `/${job.id}/audit`))).json().events
  assert.equal(events.length, 1)
  assert.equal(events[0].actorId, accountA.id)
  assert.equal(events[0].afterData.name, input.name)
  assert.ok(events[0].occurredAt)
})
test('duplicate creation retries return the same result and conflicting content is rejected', async () => {
  const key = randomUUID()
  const one = await create(input, key)
  const two = await create(input, key)
  assert.equal(one.statusCode, 201)
  assert.equal(two.statusCode, 200)
  assert.equal(one.json().id, two.json().id)
  assert.equal((await create({ ...input, name: '変更' }, key)).statusCode, 409)
})
test('other company cannot list, read, modify, or read history by guessed IDs', async () => {
  for (const endpoint of [url(), url(companies[0], `/${job.id}`), url(companies[0], `/${job.id}/audit`), url(companies[1], `/${job.id}`)]) {
    assert.equal((await req('GET', endpoint, undefined, cookieB)).statusCode, 404)
  }
  assert.equal((await req('PATCH', url(companies[0], `/${job.id}`), { ...input, version: 1 }, cookieB)).statusCode, 404)
})
test('concurrent create retries commit exactly one job', async () => {
  const key = randomUUID()
  const responses = await Promise.all([create(input, key), create(input, key)])
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 201])
  assert.equal(responses[0].json().id, responses[1].json().id)
  const id = responses[0].json().id
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM audit_events WHERE target_id=$1', [id])).rows[0].count, 1)
})
test('simultaneous updates cannot silently overwrite each other', async () => {
  const created = (await create()).json()
  const responses = await Promise.all([
    req('PATCH', url(companies[0], `/${created.id}`), { ...input, name: '更新A', version: 1 }),
    req('PATCH', url(companies[0], `/${created.id}`), { ...input, name: '更新B', version: 1 }),
  ])
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 409])
  assert.equal((await req('GET', url(companies[0], `/${created.id}`))).json().version, 2)
})
test('viewer can read but cannot create, edit, or inspect audit history', async () => {
  assert.equal((await req('GET', url(), undefined, cookieViewer)).statusCode, 200)
  assert.equal((await create(input, randomUUID(), cookieViewer)).statusCode, 403)
  assert.equal((await req('PATCH', url(companies[0], `/${job.id}`), { ...input, version: 1 }, cookieViewer)).statusCode, 403)
  assert.equal((await req('GET', url(companies[0], `/${job.id}/audit`), undefined, cookieViewer)).statusCode, 403)
})
test('invalid input, date inversion, overflow, unknown keys and role injection are rejected', async () => {
  for (const patch of [{ name: '  ' }, { name: 'a'.repeat(121) }, { plannedEnd: '2026-10-01' }, { plannedStart: '2026-02-30' }, { role: 'owner' }, { companyId: companies[1] }, { version: 9 }]) {
    assert.equal((await create({ ...input, ...patch })).statusCode, 400, JSON.stringify(patch))
  }
  assert.equal((await req('GET', `${url()}?limit=999`)).statusCode, 400)
})
test('optimistic concurrency rejects stale edits and records before and after', async () => {
  const res = await req('PATCH', url(companies[0], `/${job.id}`), { ...input, name: '更新済み工事', version: 1 })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().version, 2)
  assert.equal((await req('PATCH', url(companies[0], `/${job.id}`), { ...input, version: 1 })).statusCode, 409)
  const events = (await req('GET', url(companies[0], `/${job.id}/audit`))).json().events
  assert.equal(events.length, 2)
  assert.equal(events[0].beforeData.name, input.name)
  assert.equal(events[0].afterData.name, '更新済み工事')
})
test('database itself isolates companies even if an API query omits tenant filters', async () => {
  const rows = await transaction(runtime, accountB.id, async client => (await client.query('SELECT * FROM jobs')).rows)
  assert.equal(rows.length, 0)
  const noActor = await runtime.query('SELECT * FROM jobs')
  assert.equal(noActor.rowCount, 0)
})
test('runtime role cannot rewrite history or elevate membership or change job ownership', async () => {
  await assert.rejects(transaction(runtime, accountA.id, c => c.query('UPDATE audit_events SET action=$1 WHERE target_id=$2', ['job.created', job.id])), e => e.code === '42501')
  await assert.rejects(transaction(runtime, accountA.id, c => c.query('DELETE FROM audit_events WHERE target_id=$1', [job.id])), e => e.code === '42501')
  await assert.rejects(transaction(runtime, viewer.id, c => c.query("UPDATE memberships SET role='owner' WHERE user_id=$1", [viewer.id])), e => e.code === '42501')
  await assert.rejects(transaction(runtime, accountA.id, c => c.query('UPDATE jobs SET company_id=$1 WHERE id=$2', [companies[1], job.id])), e => e.code === '42501')
})
test('audit trigger failure rolls back jobs, history and creation requests', async () => {
  const counts = async () => (await owner.query(`SELECT (SELECT count(*) FROM jobs) AS jobs,
    (SELECT count(*) FROM audit_events) AS audit, (SELECT count(*) FROM creation_requests) AS requests`)).rows[0]
  const countBefore = await counts()
  const previous = (await req('GET', url(companies[0], `/${job.id}`))).json()
  await owner.query(`CREATE FUNCTION public.test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test audit failure'; END; $$`)
  await owner.query('CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION public.test_fail_audit()')
  try {
    assert.equal((await create()).statusCode, 500)
    assert.equal((await req('PATCH', url(companies[0], `/${job.id}`), { ...input, version: previous.version })).statusCode, 500)
    assert.deepEqual(await counts(), countBefore)
    assert.deepEqual((await req('GET', url(companies[0], `/${job.id}`))).json(), previous)
  } finally {
    await owner.query('DROP TRIGGER test_fail_audit ON audit_events')
    await owner.query('DROP FUNCTION public.test_fail_audit()')
  }
})

test('direct SQL always records actual OLD/NEW, including same-value updates', async () => {
  const id = randomUUID()
  const trace = randomUUID()
  await transaction(runtime, accountA.id, async c => {
    await c.query(`INSERT INTO jobs(id,company_id,name,site_address,customer_name,work_description,created_by)
      VALUES($1,$2,'SQL job','site','customer','work',$3)`, [id, companies[0], accountA.id])
    await c.query('UPDATE jobs SET name=name, version=version+1 WHERE id=$1', [id])
    await c.query("UPDATE jobs SET name='SQL changed', version=version+1 WHERE id=$1", [id])
  }, trace)
  const response = await req('GET', url(companies[0], `/${id}/audit`))
  assert.equal(response.statusCode, 200, response.body)
  const { events, nextCursor } = response.json()
  assert.deepEqual(events.map(e => e.targetVersion), [3, 2, 1])
  assert.equal(nextCursor, null)
  assert.ok(events.every(e => e.requestId === trace && e.actorName === accountA.name && e.actorId === accountA.id))
  assert.equal(events[0].beforeData.name, 'SQL job')
  assert.equal(events[0].afterData.name, 'SQL changed')
  assert.equal(events[1].beforeData.name, events[1].afterData.name)
  assert.equal(events[2].beforeData, null)
  assert.equal(events[2].afterData.createdAt, events[2].afterData.updatedAt)
  assert.deepEqual(events[0].afterData, (await req('GET', url(companies[0], `/${id}`))).json())
  await assert.rejects(transaction(runtime, accountA.id, async c => {
    await c.query("SELECT set_config('app.request_id','',true)")
    await c.query('UPDATE jobs SET version=version+1 WHERE id=$1', [id])
  }), e => e.code === '23514')
})

test('runtime cannot invent history, disable triggers or choose version and timestamps', async () => {
  const created = (await create()).json()
  for (const sql of [
    'INSERT INTO audit_events SELECT * FROM audit_events LIMIT 1',
    'TRUNCATE audit_events',
    'ALTER TABLE jobs DISABLE TRIGGER jobs_audit_write',
    "UPDATE jobs SET updated_at='2000-01-01',version=version+1",
    "UPDATE jobs SET created_at='2000-01-01',version=version+1",
    'SELECT public.audit_job_write()',
  ]) await assert.rejects(transaction(runtime, accountA.id, c => c.query(sql)), e => e.code === '42501', sql)
  for (const version of [1, 0, 100, 2147483647]) {
    await assert.rejects(transaction(runtime, accountA.id, c => c.query('UPDATE jobs SET version=$1 WHERE id=$2', [version, created.id])), e => e.code === '23514')
  }
  await assert.rejects(transaction(runtime, accountA.id, c => c.query(`INSERT INTO jobs(id,company_id,name,site_address,customer_name,work_description,created_by,version)
    VALUES($1,$2,'job','site','customer','work',$3,7)`, [randomUUID(), companies[0], accountA.id])), e => e.code === '42501')
  // Owner access in this isolated DB exercises the trigger beyond the runtime column ACL.
  for (const assignment of ["created_at='2000-01-01'", "updated_at='2000-01-01'", "created_by='forged'", 'id=gen_random_uuid()', 'version=7']) {
    await assert.rejects(transaction(owner, accountA.id, c => c.query(`UPDATE jobs SET ${assignment} WHERE id=$1`, [created.id])), e => e.code === '23514')
  }
  assert.equal((await req('GET', url(companies[0], `/${created.id}`))).json().version, 1)
})

test('audit and creation requests enforce company/job composite foreign keys', async () => {
  await assert.rejects(owner.query(`INSERT INTO creation_requests(company_id,user_id,request_key,body_hash,job_id,response_data)
    VALUES($1,$2,$3,'test',$4,'{}')`, [companies[1], accountB.id, randomUUID(), job.id]), e => e.code === '23503')
  await assert.rejects(owner.query(`INSERT INTO audit_events(id,company_id,actor_id,actor_name,action,target_id,target_version,request_id,after_data)
    VALUES($1,$2,$3,'test','job.updated',$4,100,'test','{}')`, [randomUUID(), companies[1], accountA.id, job.id]), e => e.code === '23503')
  await assert.rejects(owner.query(`INSERT INTO audit_events(id,company_id,actor_id,actor_name,action,target_id,target_version,request_id,after_data)
    SELECT $1,company_id,actor_id,actor_name,action,target_id,target_version,request_id,after_data FROM audit_events WHERE target_id=$2 LIMIT 1`,
  [randomUUID(), job.id]), e => e.code === '23505')
})

test('102 history entries page to version 1 without duplicates even after a new update', async () => {
  const created = (await create()).json()
  await transaction(runtime, accountA.id, async c => {
    for (let i = 0; i < 101; i++) await c.query('UPDATE jobs SET version=version+1 WHERE id=$1', [created.id])
  })
  // Ordering must depend on target_version, including when timestamps are identical.
  await owner.query("UPDATE audit_events SET occurred_at='2026-01-01' WHERE target_id=$1", [created.id])
  const endpoint = url(companies[0], `/${created.id}/audit`)
  const first = (await req('GET', endpoint)).json()
  assert.equal(first.events.length, 50)
  assert.equal(first.nextCursor, '53')
  await transaction(runtime, accountA.id, c => c.query('UPDATE jobs SET version=version+1 WHERE id=$1', [created.id]))
  const second = (await req('GET', `${endpoint}?limit=50&cursor=${first.nextCursor}`)).json()
  assert.equal(second.events.length, 50)
  assert.equal(second.nextCursor, '3')
  const last = (await req('GET', `${endpoint}?limit=50&cursor=${second.nextCursor}`)).json()
  assert.equal(last.events.length, 2)
  assert.equal(last.nextCursor, null)
  assert.deepEqual([...first.events, ...second.events, ...last.events].map(e => e.targetVersion), Array.from({ length: 102 }, (_, i) => 102 - i))
  assert.deepEqual((await req('GET', `${endpoint}?cursor=1`)).json(), { events: [], nextCursor: null })
  const maxPage = (await req('GET', `${endpoint}?limit=100`)).json()
  assert.equal(maxPage.events.length, 100)
  assert.equal(maxPage.nextCursor, '4')
  for (const query of ['cursor=0','cursor=-1','cursor=1.5','cursor=2147483648','cursor=1e2','cursor=','cursor=1&cursor=2','limit=0','limit=101','limit=true','unexpected=1']) {
    assert.equal((await req('GET', `${endpoint}?${query}`)).statusCode, 400, query)
  }
})

test('actor display names remain snapshots after rename', async () => {
  const created = (await create()).json()
  await owner.query('UPDATE "user" SET name=$1 WHERE id=$2', ['Renamed actor', accountA.id])
  try {
    const updated = await req('PATCH', url(companies[0], `/${created.id}`), { ...input, version: 1 })
    assert.equal(updated.statusCode, 200, updated.body)
    const { events } = (await req('GET', url(companies[0], `/${created.id}/audit`))).json()
    assert.deepEqual(events.map(e => e.actorName), ['Renamed actor', accountA.name])
    assert.ok(events.every(e => e.actorId === accountA.id && /^[a-f0-9-]{36}$/.test(e.requestId)))
    assert.notEqual(events[0].requestId, events[1].requestId)
  } finally { await owner.query('UPDATE "user" SET name=$1 WHERE id=$2', [accountA.name, accountA.id]) }
})

test('uppercase UUID retries share the same advisory lock and create exactly once', async () => {
  const key = randomUUID()
  const lock = await owner.connect()
  let responses
  try {
    await lock.query('BEGIN')
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${companies[0]}/${accountA.id}/${key}`])
    responses = Promise.all([create(input, key), create(input, key.toUpperCase(), cookieA, companies[0].toUpperCase())])
    const deadline = Date.now() + 3000
    let waiting = 0
    while (Date.now() < deadline && waiting < 2) {
      waiting = (await owner.query(`SELECT count(*)::integer AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows[0].count
      if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(waiting, 2, 'both casing variants must wait for the canonical lock')
  } finally {
    await lock.query('ROLLBACK')
    lock.release()
    if (responses) await responses
  }
  const results = await responses
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 201])
  assert.equal(results[0].json().id, results[1].json().id)
})

test('JSON types are strict while numeric query parameters still work', async () => {
  for (const patch of [{ name: 123 }, { customerName: true }, { siteAddress: ['site'] }, { plannedStart: '' }, { plannedEnd: false }, { plannedEnd: 0 }]) {
    assert.equal((await create({ ...input, ...patch })).statusCode, 400, JSON.stringify(patch))
  }
  for (const version of ['2', true, [2], 2.5]) {
    assert.equal((await req('PATCH', url(companies[0], `/${job.id}`), { ...input, version })).statusCode, 400)
  }
  const response = await req('GET', `${url()}?limit=1&offset=1`)
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().jobs.length, 1)
  assert.equal((await create({ ...input, plannedStart: null, plannedEnd: null })).statusCode, 201)
  for (const date of ['2000-13-01', '2000-02-30', 'invalid', '', '1899-12-31', '2200-01-01']) {
    assert.throws(() => normalizeJob({ ...input, plannedStart: date }), e => e instanceof HttpError && e.statusCode === 400)
  }
})

test('startup rejects every unprotected business table and excess runtime privileges', async () => {
  for (const table of ['companies', 'memberships', 'jobs', 'audit_events', 'creation_requests']) {
    await owner.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`)
    try { await assert.rejects(assertRuntimeRole(runtime), /protected audit\/RLS/) }
    finally { await owner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`) }
  }
  for (const [grant, revoke] of [
    ['GRANT CREATE ON SCHEMA public TO construction_app', 'REVOKE CREATE ON SCHEMA public FROM construction_app'],
    ['GRANT INSERT (action) ON audit_events TO construction_app', 'REVOKE INSERT (action) ON audit_events FROM construction_app'],
    ['GRANT UPDATE (updated_at) ON jobs TO construction_app', 'REVOKE UPDATE (updated_at) ON jobs FROM construction_app'],
    ['ALTER TABLE jobs DISABLE TRIGGER jobs_audit_write', 'ALTER TABLE jobs ENABLE TRIGGER jobs_audit_write'],
    ['GRANT EXECUTE ON FUNCTION public.audit_job_write() TO PUBLIC', 'REVOKE EXECUTE ON FUNCTION public.audit_job_write() FROM PUBLIC'],
  ]) {
    await owner.query(grant)
    try { await assert.rejects(assertRuntimeRole(runtime), /limited privileges/) }
    finally { await owner.query(revoke) }
  }
  await assertRuntimeRole(runtime)
})

test('transaction preserves work and commit failures and discards uncertain clients', async () => {
  for (const stage of ['work', 'commit']) {
    const original = new Error(`${stage} failure`)
    const releases = []
    const client = {
      query: async sql => {
        if (sql === 'ROLLBACK') throw new Error('rollback failure')
        if (sql === 'COMMIT' && stage === 'commit') throw original
        return { rows: [] }
      },
      release: destroy => { releases.push(destroy) },
    }
    await assert.rejects(transaction({ connect: async () => client }, 'actor', async () => {
      if (stage === 'work') throw original
      return 'ok'
    }), e => e === original)
    assert.deepEqual(releases, [true])
  }
  const original = new Error('original')
  await assert.rejects(transaction({ connect: async () => ({ query: async () => ({}), release: () => { throw new Error('release failure') } }) },
    'actor', async () => { throw original }), e => e === original)
})

test('migration preserves original failure when rollback or unlock fails and destroys the client', async () => {
  for (const cleanup of ['rollback', 'unlock']) {
    const original = new Error('migration failure')
    const releases = []
    const connect = owner.connect.bind(owner)
    let first = true
    const wrapped = Object.create(owner)
    wrapped.connect = async () => {
      const client = await connect()
      if (!first) return client
      first = false
      return {
        query: async (sql, ...args) => {
          if (sql.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) throw original
          const result = await client.query(sql, ...args)
          if (cleanup === 'rollback' && sql === 'ROLLBACK' || cleanup === 'unlock' && sql.startsWith('SELECT pg_advisory_unlock')) {
            throw new Error(`${cleanup} failure`)
          }
          return result
        },
        release: destroy => { releases.push(destroy); client.release(destroy) },
      }
    }
    await assert.rejects(migrate(wrapped, config, process.env.DB_APP_PASSWORD), e => e === original)
    assert.deepEqual(releases, [true])
  }
})

test('migration 003 upgrades old history and removes old table and column write grants', async () => {
  const legacyDb = `construction_test_${randomBytes(6).toString('hex')}`
  const legacyAdminUrl = new URL(adminUrl)
  const legacyAppUrl = new URL(appUrl)
  legacyAdminUrl.pathname = legacyAppUrl.pathname = `/${legacyDb}`
  const legacyOwner = createPool(legacyAdminUrl.href)
  const legacyRuntime = createPool(legacyAppUrl.href)
  const legacyConfig = { ...config, databaseUrl: legacyAppUrl.href }
  const companyId = randomUUID()
  const jobId = randomUUID()
  const eventId = randomUUID()
  try {
    await control.query(`CREATE DATABASE ${legacyDb}`)
    const { runMigrations } = await getMigrations(authOptions(legacyOwner, legacyConfig))
    await runMigrations()
    for (const file of ['001_foundation.sql', '002_membership_lock.sql']) {
      await legacyOwner.query(await readFile(new URL(`../server/migrations/${file}`, import.meta.url), 'utf8'))
    }
    await legacyOwner.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    await legacyOwner.query('INSERT INTO schema_migrations(version) VALUES(1),(2)')
    await legacyOwner.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
      VALUES('legacy-actor','Legacy actor','legacy@tests.invalid',false,now(),now())`)
    await legacyOwner.query("INSERT INTO companies(id,name) VALUES($1,'Legacy company')", [companyId])
    await legacyOwner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,'legacy-actor','owner')", [companyId])
    await legacyOwner.query(`INSERT INTO jobs(id,company_id,name,site_address,customer_name,work_description,created_by)
      VALUES($1,$2,'Legacy job','site','customer','work','legacy-actor')`, [jobId, companyId])
    await legacyOwner.query(`INSERT INTO audit_events(id,company_id,actor_id,action,target_id,after_data)
      VALUES($1,$2,'legacy-actor','job.created',$3,'{"version":1,"name":"Legacy job"}')`, [eventId, companyId, jobId])
    await legacyOwner.query('GRANT SELECT, INSERT ON jobs, audit_events, creation_requests TO construction_app')
    await legacyOwner.query('GRANT UPDATE(updated_at) ON jobs TO construction_app')
    await legacyOwner.query('GRANT INSERT(action) ON audit_events TO construction_app')
    await migrate(legacyOwner, legacyConfig, process.env.DB_APP_PASSWORD)
    await migrate(legacyOwner, legacyConfig, process.env.DB_APP_PASSWORD)
    await assertRuntimeRole(legacyRuntime)
    const event = (await legacyOwner.query('SELECT * FROM audit_events WHERE id=$1', [eventId])).rows[0]
    assert.equal(event.actor_name, 'Legacy actor')
    assert.equal(event.target_version, 1)
    assert.equal(event.request_id, `legacy:${eventId}`)
    assert.deepEqual(event.after_data, { version: 1, name: 'Legacy job' })
    await transaction(legacyRuntime, 'legacy-actor', c => c.query('UPDATE jobs SET version=version+1 WHERE id=$1', [jobId]))
    assert.equal((await legacyOwner.query('SELECT count(*)::integer AS count FROM audit_events')).rows[0].count, 2)
    await assert.rejects(legacyRuntime.query('INSERT INTO audit_events SELECT * FROM audit_events LIMIT 1'), e => e.code === '42501')
  } finally {
    await legacyRuntime.end()
    await legacyOwner.end()
    assert.match(legacyDb, /^construction_test_[a-f0-9]{12}$/)
    await control.query(`DROP DATABASE IF EXISTS ${legacyDb} WITH (FORCE)`)
  }
})

test('unknown server failures are 500 and known transient database failures are 503', async () => {
  let failure = new Error('private internal detail')
  const wrapped = Object.create(runtime)
  wrapped.query = (...args) => {
    if (args[0] === 'SELECT 1') throw failure
    return runtime.query(...args)
  }
  const probe = await buildApp(wrapped, config)
  try {
    for (const [code, status] of [[undefined, 500], ['42501', 500], ['ECONNREFUSED', 503], ['40001', 503], ['57014', 503]]) {
      failure = Object.assign(new Error('private internal detail'), { code })
      const response = await probe.inject({ method: 'GET', url: '/api/health' })
      assert.equal(response.statusCode, status)
      assert.ok(!response.body.includes('private internal detail'))
    }
  } finally { await probe.close() }
})
test('membership suspension immediately removes access with an existing session', async () => {
  await owner.query('UPDATE memberships SET active=false WHERE user_id=$1', [viewer.id])
  assert.equal((await req('GET', url(), undefined, cookieViewer)).statusCode, 404)
  assert.deepEqual((await req('GET', '/api/me', undefined, cookieViewer)).json().companies, [])
})
test('session revocation takes effect immediately without cached authorization', async () => {
  await owner.query('DELETE FROM session WHERE "userId"=$1', [accountB.id])
  assert.equal((await req('GET', '/api/me', undefined, cookieB)).statusCode, 401)
})
test('sign out revokes the session rather than only hiding the UI', async () => {
  assert.equal((await req('POST', '/api/auth/sign-out', {}, cookieA)).statusCode, 200)
  assert.equal((await req('GET', url(), undefined, cookieA)).statusCode, 401)
})
test('password failure is generic and login brute force is rate limited', async () => {
  let blocked = false
  for (let i = 0; i < 6; i++) {
    const response = await req('POST', '/api/auth/sign-in/email', { email: 'not-a-user@tests.invalid', password: 'wrong-password-value' }, null)
    assert.ok([401, 429].includes(response.statusCode), response.body)
    if (response.statusCode === 429) blocked = true
  }
  assert.equal(blocked, true)
})
