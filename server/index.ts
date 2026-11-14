import { buildApp } from './app.ts'
import { readConfig } from './config.ts'
import { createPool } from './db.ts'

const config = readConfig()
const pool = createPool(config.databaseUrl)
try {
  const app = await buildApp(pool, config, true)
  await app.listen({ port: config.port, host: '127.0.0.1' })
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await app.close()
    await pool.end()
  }
  process.on('SIGINT', () => { close().catch(() => { process.exitCode = 1 }) })
  process.on('SIGTERM', () => { close().catch(() => { process.exitCode = 1 }) })
} catch {
  console.error('API startup failed. Check configuration, database availability and migrations.')
  await pool.end()
  process.exitCode = 1
}
