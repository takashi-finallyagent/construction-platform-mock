import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { getMigrations } from 'better-auth/db/migration'
import { authOptions, createAuth } from '../server/auth.ts'
import { readConfig } from '../server/config.ts'
import { assertRuntimeRole, createPool, transaction } from '../server/db.ts'
import { migrate } from '../server/migrate.ts'

test('classification migration preserves populated version-003 jobs and history without inventing classifications', async () => {
  const dbName = `classification_upgrade_${randomBytes(6).toString('hex')}`
  const adminUrl = new URL(process.env.DATABASE_ADMIN_URL)
  const runtimeUrl = new URL(process.env.DATABASE_URL)
  assert.equal(adminUrl.hostname, '127.0.0.1', 'Only a local fixture database is allowed')
  assert.equal(runtimeUrl.hostname, '127.0.0.1', 'Only a local fixture database is allowed')
  const controlUrl = new URL(adminUrl)
  controlUrl.pathname = '/postgres'
  adminUrl.pathname = `/${dbName}`
  runtimeUrl.pathname = `/${dbName}`
  const control = createPool(controlUrl.href)
  const owner = createPool(adminUrl.href)
  const runtime = createPool(runtimeUrl.href)
  const config = readConfig({ ...process.env, DATABASE_URL: runtimeUrl.href })
  let created = false
  try {
    await control.query(`CREATE DATABASE ${dbName}`)
    created = true
    const authMigration = await getMigrations(authOptions(owner, config))
    await authMigration.runMigrations()
    for (const file of ['001_foundation.sql', '002_membership_lock.sql', '003_job_audit.sql']) {
      await owner.query(await readFile(new URL(`../server/migrations/${file}`, import.meta.url), 'utf8'))
    }
    await owner.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    await owner.query('INSERT INTO schema_migrations(version) VALUES(1),(2),(3)')
    const auth = createAuth(owner, config, true)
    const user = (await auth.api.signUpEmail({ body: {
      email: `upgrade-${randomBytes(8).toString('hex')}@tests.invalid`,
      password: randomBytes(30).toString('base64url'), name: '移行試験 記録者',
    } })).user
    const company = randomUUID(), job = randomUUID()
    await owner.query("INSERT INTO companies(id,name) VALUES($1,'移行試験会社')", [company])
    await owner.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')", [company, user.id])
    await transaction(owner, user.id, async client => {
      await client.query(`INSERT INTO jobs(id,company_id,name,site_address,customer_name,work_description,planned_start,planned_end,created_by)
        VALUES($1,$2,'移行前の修繕工事','試験用所在地','試験発注者','扉の修繕','2026-11-01','2026-11-03',$3)`, [job, company, user.id])
      await client.query("UPDATE jobs SET work_description='扉と錠前の修繕',version=version+1 WHERE id=$1", [job])
    })
    const snapshot = async () => ({
      companies: (await owner.query('SELECT * FROM companies ORDER BY id')).rows,
      memberships: (await owner.query('SELECT * FROM memberships ORDER BY company_id,user_id')).rows,
      jobs: (await owner.query('SELECT * FROM jobs ORDER BY id')).rows,
      audit: (await owner.query('SELECT * FROM audit_events ORDER BY target_id,target_version')).rows,
    })
    const before = await snapshot()
    assert.equal(before.jobs[0].version, 2)
    assert.equal(before.audit.length, 2)
    await migrate(owner, config, process.env.DB_APP_PASSWORD)
    await assertRuntimeRole(runtime)
    assert.deepEqual(await snapshot(), before)
    assert.equal((await owner.query('SELECT count(*)::integer AS count FROM job_classifications')).rows[0].count, 0)
    assert.equal((await owner.query('SELECT count(*)::integer AS count FROM classification_audit_events')).rows[0].count, 0)
    const migrations = (await owner.query('SELECT version,applied_at FROM schema_migrations ORDER BY version')).rows
    assert.ok(migrations.some(row => row.version === 4), 'Classification migration 004 must be applied')
    await migrate(owner, config, process.env.DB_APP_PASSWORD)
    await assertRuntimeRole(runtime)
    assert.deepEqual(await snapshot(), before)
    assert.deepEqual((await owner.query('SELECT version,applied_at FROM schema_migrations ORDER BY version')).rows, migrations)
  } finally {
    await runtime.end()
    await owner.end()
    try {
      if (created) {
        assert.match(dbName, /^classification_upgrade_[a-f0-9]{12}$/)
        await control.query(`DROP DATABASE ${dbName} WITH (FORCE)`)
      }
    } finally { await control.end() }
  }
})
