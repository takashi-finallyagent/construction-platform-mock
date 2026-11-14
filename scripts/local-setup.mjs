import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseEnv } from 'node:util'
import { createPool } from '../server/db.ts'
import { provisionCompany } from '../server/provision.ts'
import { readConfig } from '../server/config.ts'
import { migrate } from '../server/migrate.ts'

// Local developer bootstrap only. No cloud operations or production credentials.
if (process.env.NODE_ENV === 'production' || process.platform !== 'win32') throw new Error('This helper is for local Windows development only')
const runtime = resolve('.runtime')
await mkdir(runtime, { recursive: true })
const secret = () => randomBytes(36).toString('base64url')
const envPath = resolve('.env')
if (!existsSync(envPath)) {
  const adminPassword = secret()
  const appPassword = secret()
  const value = `APP_ORIGIN=http://127.0.0.1:5173\nAPI_PORT=3100\nDATABASE_URL=postgresql://construction_app:${appPassword}@127.0.0.1:55432/construction\nDATABASE_ADMIN_URL=postgresql://construction_owner:${adminPassword}@127.0.0.1:55432/construction\nDB_APP_PASSWORD=${appPassword}\nBETTER_AUTH_SECRET=${secret()}\n`
  await writeFile(envPath, value, { flag: 'wx', mode: 0o600 })
}
const env = parseEnv(await readFile(envPath, 'utf8'))
const config = readConfig(env)
const adminUrl = new URL(env.DATABASE_ADMIN_URL)
if (adminUrl.hostname !== '127.0.0.1' || adminUrl.port !== '55432' || adminUrl.pathname !== '/construction') throw new Error('Local setup will only operate on 127.0.0.1:55432/construction')
const bin = resolve(runtime, 'pgsql', 'bin')
const data = resolve(runtime, 'pgdata')
const run = (exe, args) => {
  const result = spawnSync(resolve(bin, exe), args, { windowsHide: true, encoding: 'utf8', stdio: exe === 'pg_ctl.exe' ? 'ignore' : 'pipe', timeout: 120000 })
  if (result.error || result.status !== 0) throw new Error(`${exe} failed. Check the local PostgreSQL log. ${result.stderr ?? ''}`)
}
if (!existsSync(resolve(data, 'PG_VERSION'))) {
  const passwordFile = resolve(runtime, 'db-admin-password')
  await writeFile(passwordFile, decodeURIComponent(adminUrl.password), { mode: 0o600 })
  run('initdb.exe', ['-D', data, '-U', 'construction_owner', '-A', 'scram-sha-256', '--pwfile', passwordFile, '--encoding=UTF8', '--locale=C'])
}
const status = spawnSync(resolve(bin, 'pg_ctl.exe'), ['-D', data, 'status'], { windowsHide: true })
if (status.status !== 0) run('pg_ctl.exe', ['-D', data, '-l', resolve(runtime, 'postgres.log'), '-o', '-h 127.0.0.1 -p 55432', '-w', 'start'])
adminUrl.pathname = '/postgres'
const control = createPool(adminUrl.href)
try {
  if (!(await control.query("SELECT 1 FROM pg_database WHERE datname='construction'")).rowCount) await control.query('CREATE DATABASE construction')
} finally { await control.end() }
const owner = createPool(env.DATABASE_ADMIN_URL)
try {
  await migrate(owner, config, env.DB_APP_PASSWORD)
  const email = 'admin@development.invalid'
  if (!(await owner.query('SELECT id FROM "user" WHERE email=$1', [email])).rowCount) {
    const password = secret()
    await provisionCompany(owner, config, { email, name: '開発管理者', password, companyName: '開発検証用会社' })
    await writeFile(resolve(runtime, 'local-access.md'), `# ローカル開発用\n\nURL: http://127.0.0.1:5173/product.html\n\nメール: ${email}\n\nパスワード: ${password}\n\n本番では使用しない。Git管理・共有禁止。\n`, { flag: 'wx', mode: 0o600 })
  }
  console.log('Local database ready. Development access details: .runtime/local-access.md (not tracked by Git).')
} finally { await owner.end() }
