import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createPool } from '../server/db.ts'
import { readConfig } from '../server/config.ts'
import { migrate } from '../server/migrate.ts'
import { provisionCompany, recoverProvision } from '../server/provision.ts'

const database = `construction_test_${randomBytes(6).toString('hex')}`
const admin = new URL(process.env.DATABASE_ADMIN_URL)
assert.equal(admin.hostname, '127.0.0.1', 'Provision tests are local only')
const controlUrl = new URL(admin)
controlUrl.pathname = '/postgres'
admin.pathname = `/${database}`
const control = createPool(controlUrl.href)
const pool = createPool(admin.href)
const config = readConfig()
const input = { email: 'new-owner@provision.invalid', name: '発行試験担当者', password: randomBytes(24).toString('base64url'), companyName: '発行試験会社' }
let partialId

before(async () => {
  await control.query(`CREATE DATABASE ${database}`)
  await migrate(pool, config, process.env.DB_APP_PASSWORD)
})
after(async () => {
  await pool.end()
  assert.match(database, /^construction_test_[a-f0-9]{12}$/)
  await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await control.end()
})

test('new account gets exactly one company and owner membership', async () => {
  const result = await provisionCompany(pool, config, input)
  const membership = await pool.query('SELECT company_id,user_id,role FROM memberships WHERE user_id=$1', [result.userId])
  assert.equal(membership.rowCount, 1)
  assert.equal(membership.rows[0].company_id, result.companyId)
  assert.equal(membership.rows[0].role, 'owner')
})
test('existing email cannot create or acquire another company, including case variants', async () => {
  const count = (await pool.query('SELECT count(*) FROM companies')).rows[0].count
  await assert.rejects(provisionCompany(pool, config, { ...input, email: input.email.toUpperCase() }), e => e.code === 'ACCOUNT_EXISTS_USE_EXPLICIT_RECOVERY')
  assert.equal((await pool.query('SELECT count(*) FROM companies')).rows[0].count, count)
})
test('bad company input is rejected before any account is created', async () => {
  const count = (await pool.query('SELECT count(*) FROM "user"')).rows[0].count
  await assert.rejects(provisionCompany(pool, config, { ...input, email: 'invalid@provision.invalid', companyName: ' ' }), e => e.code === 'INVALID_COMPANY_NAME')
  assert.equal((await pool.query('SELECT count(*) FROM "user"')).rows[0].count, count)
})
test('company failure leaves only an identified unassigned account and rolls back company rows', async () => {
  await pool.query(`CREATE FUNCTION fail_provision_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected company failure'; END $$`)
  await pool.query('CREATE TRIGGER fail_provision_test BEFORE INSERT ON companies FOR EACH ROW EXECUTE FUNCTION fail_provision_test()')
  const companiesBefore = (await pool.query('SELECT count(*) FROM companies')).rows[0].count
  try {
    await assert.rejects(provisionCompany(pool, config, { ...input, email: 'partial@provision.invalid' }), e => {
      partialId = e.userId
      return e.code === 'UNASSIGNED_ACCOUNT_REQUIRES_RECOVERY' && typeof partialId === 'string'
    })
    assert.equal((await pool.query('SELECT 1 FROM "user" WHERE id=$1', [partialId])).rowCount, 1)
    assert.equal((await pool.query('SELECT 1 FROM memberships WHERE user_id=$1', [partialId])).rowCount, 0)
    assert.equal((await pool.query('SELECT count(*) FROM companies')).rows[0].count, companiesBefore)
  } finally {
    await pool.query('DROP TRIGGER fail_provision_test ON companies')
    await pool.query('DROP FUNCTION fail_provision_test()')
  }
})
test('retrying new provisioning does not implicitly recover or attach an existing account', async () => {
  await assert.rejects(provisionCompany(pool, config, { ...input, email: 'partial@provision.invalid' }), e => e.code === 'ACCOUNT_EXISTS_USE_EXPLICIT_RECOVERY')
  assert.equal((await pool.query('SELECT 1 FROM memberships WHERE user_id=$1', [partialId])).rowCount, 0)
})
test('explicit recovery attaches the confirmed unassigned account once', async () => {
  const result = await recoverProvision(pool, partialId, '明示復旧会社')
  assert.equal(result.userId, partialId)
  assert.equal((await pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND company_id=$2', [partialId, result.companyId])).rowCount, 1)
  await assert.rejects(recoverProvision(pool, partialId, '二重会社'), e => e.code === 'ACCOUNT_ALREADY_ASSIGNED')
})
test('unknown recovery account is rejected without creating a company', async () => {
  await assert.rejects(recoverProvision(pool, 'not-a-user', '誤復旧'), e => e.code === 'ACCOUNT_NOT_FOUND')
})
test('recovery refuses an account whose credentials are incomplete', async () => {
  const id = 'incomplete-account'
  await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())', [id, '不完全アカウント', 'incomplete@provision.invalid'])
  await assert.rejects(recoverProvision(pool, id, '不完全復旧'), e => e.code === 'ACCOUNT_CREDENTIALS_NOT_CONFIRMED')
  assert.equal((await pool.query('SELECT 1 FROM memberships WHERE user_id=$1', [id])).rowCount, 0)
})
test('concurrent new provisioning creates exactly one account and one company', async () => {
  const requests = await Promise.allSettled([
    provisionCompany(pool, config, { ...input, email: 'concurrent@provision.invalid' }),
    provisionCompany(pool, config, { ...input, email: 'concurrent@provision.invalid' }),
  ])
  assert.equal(requests.filter(r => r.status === 'fulfilled').length, 1)
  const rejected = requests.find(r => r.status === 'rejected')
  assert.equal(rejected.reason.code, 'ACCOUNT_EXISTS_USE_EXPLICIT_RECOVERY')
  const user = (await pool.query('SELECT id FROM "user" WHERE email=$1', ['concurrent@provision.invalid'])).rows[0]
  assert.equal((await pool.query('SELECT 1 FROM memberships WHERE user_id=$1', [user.id])).rowCount, 1)
})
