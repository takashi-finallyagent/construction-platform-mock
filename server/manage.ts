import { readConfig } from './config.ts'
import { createPool } from './db.ts'
import { migrate } from './migrate.ts'
import { provisionCompany, recoverProvision, ProvisionError } from './provision.ts'

const config = readConfig()
const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required for administration, not for the API')
const pool = createPool(adminUrl)
try {
  const command = process.argv[2]
  if (command === 'migrate') {
    await migrate(pool, config, process.env.DB_APP_PASSWORD ?? '')
    console.log('Database migrations complete')
  } else if (command === 'provision' || command === 'recover-provision') {
    const { ADMIN_ACTOR: actor, ADMIN_REASON: reason } = process.env
    if (!actor?.trim() || !reason?.trim()) throw new ProvisionError('ADMIN_ACTOR_AND_REASON_REQUIRED')
    const { ACCOUNT_EMAIL: email, ACCOUNT_NAME: name, ACCOUNT_PASSWORD: password, COMPANY_NAME: companyName } = process.env
    if (!companyName) throw new ProvisionError('COMPANY_NAME_REQUIRED')
    let result
    if (command === 'provision') {
      if (!email || !name || !password) throw new ProvisionError('ACCOUNT_INPUT_REQUIRED')
      result = await provisionCompany(pool, config, { email, name, password, companyName })
    } else {
      if (!process.env.ACCOUNT_USER_ID) throw new ProvisionError('EXPLICIT_ACCOUNT_USER_ID_REQUIRED')
      result = await recoverProvision(pool, process.env.ACCOUNT_USER_ID, companyName)
    }
    console.log(JSON.stringify({ action: command, actor, reason, at: new Date().toISOString(), ...result, status: 'completed' }))
  } else {
    throw new Error('Use migrate, provision or recover-provision')
  }
} catch (error) {
  console.error(JSON.stringify({ action: process.argv[2], actor: process.env.ADMIN_ACTOR ?? null, at: new Date().toISOString(),
    reason: process.env.ADMIN_REASON ?? null,
    status: 'failed', code: error instanceof ProvisionError ? error.code : 'ADMIN_COMMAND_FAILED',
    userId: error instanceof ProvisionError ? error.userId : undefined }))
  process.exitCode = 1
} finally { await pool.end() }
