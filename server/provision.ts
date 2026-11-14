import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createAuth } from './auth.ts'
import type { Config } from './config.ts'
import { transaction } from './db.ts'

export class ProvisionError extends Error {
  code: string
  userId?: string
  constructor(code: string, userId?: string) { super(code); this.code = code; this.userId = userId }
}

function companyName(value: string) {
  const name = value.trim()
  if (!name || name.length > 120) throw new ProvisionError('INVALID_COMPANY_NAME')
  return name
}

async function locked<T>(pool: Pool, email: string, work: () => Promise<T>) {
  const client = await pool.connect()
  let acquired = false
  let destroy = false
  try {
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 71023))', [email])
      acquired = true
    } catch (error) { destroy = true; throw error }
    return await work()
  } finally {
    try {
      if (acquired) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 71023))', [email])
    } catch {
      destroy = true
      console.error('Provision lock connection could not be released; connection discarded')
    } finally { client.release(destroy) }
  }
}

async function attachNewCompany(pool: Pool, userId: string, name: string) {
  return transaction(pool, userId, async client => {
    const account = await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId])
    if (!account.rowCount) throw new ProvisionError('ACCOUNT_NOT_FOUND')
    const credential = await client.query('SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"=$2 AND password IS NOT NULL', [userId, 'credential'])
    if (!credential.rowCount) throw new ProvisionError('ACCOUNT_CREDENTIALS_NOT_CONFIRMED', userId)
    if ((await client.query('SELECT 1 FROM memberships WHERE user_id=$1', [userId])).rowCount) {
      throw new ProvisionError('ACCOUNT_ALREADY_ASSIGNED', userId)
    }
    const companyId = randomUUID()
    await client.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, name])
    await client.query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'owner')", [companyId, userId])
    return { companyId, userId }
  })
}

export async function provisionCompany(pool: Pool, config: Config, input: { email: string; name: string; password: string; companyName: string }) {
  const name = companyName(input.companyName)
  const email = input.email.trim().toLowerCase()
  if (!email || !input.name.trim() || input.password.length < 12 || input.password.length > 128) throw new ProvisionError('INVALID_ACCOUNT_INPUT')
  return locked(pool, email, async () => {
    const existing = await pool.query('SELECT id FROM "user" WHERE email=$1', [email])
    if (existing.rowCount) throw new ProvisionError('ACCOUNT_EXISTS_USE_EXPLICIT_RECOVERY', existing.rows[0].id)
    const result = await createAuth(pool, config, true).api.signUpEmail({ body: { email, name: input.name.trim(), password: input.password } })
    // Never attach a synthetic sign-up response (used to prevent account enumeration).
    const actual = await pool.query('SELECT id FROM "user" WHERE id=$1 AND email=$2', [result.user.id, email])
    if (!actual.rowCount) throw new ProvisionError('ACCOUNT_CREATION_NOT_CONFIRMED')
    try { return await attachNewCompany(pool, result.user.id, name) }
    catch { throw new ProvisionError('UNASSIGNED_ACCOUNT_REQUIRES_RECOVERY', result.user.id) }
  })
}

export async function recoverProvision(pool: Pool, userId: string, name: string) {
  const normalized = companyName(name)
  const account = await pool.query('SELECT email FROM "user" WHERE id=$1', [userId])
  if (!account.rowCount) throw new ProvisionError('ACCOUNT_NOT_FOUND')
  return locked(pool, account.rows[0].email, () => attachNewCompany(pool, userId, normalized))
}
