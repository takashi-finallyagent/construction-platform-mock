export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (key: string) => {
    const value = env[key]?.trim()
    if (!value) throw new Error(`${key} is required`)
    return value
  }
  const origin = new URL(required('APP_ORIGIN'))
  const production = env.NODE_ENV === 'production'
  if (production && (env.DATABASE_ADMIN_URL || env.DB_APP_PASSWORD)) {
    throw new Error('Do not give database administration credentials to the production API process')
  }
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('APP_ORIGIN must be an origin without a path or credentials')
  }
  if (production ? origin.protocol !== 'https:' : !['https:', 'http:'].includes(origin.protocol)) {
    throw new Error('Production requires HTTPS')
  }
  if (!production && origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new Error('Development HTTP must use loopback')
  }
  const secret = required('BETTER_AUTH_SECRET')
  if (secret.length < 32 || /^(change|example|secret)/i.test(secret)) throw new Error('Use a random authentication secret (32+ characters)')
  const port = Number(env.API_PORT ?? 3100)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid API_PORT')
  return { origin: origin.origin, production, secret, databaseUrl: required('DATABASE_URL'), port }
}

export type Config = ReturnType<typeof readConfig>
