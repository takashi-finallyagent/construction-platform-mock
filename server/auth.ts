import { betterAuth, type BetterAuthOptions } from 'better-auth'
import type { Pool } from 'pg'
import type { Config } from './config.ts'

export function authOptions(pool: Pool, config: Config, provisioning = false) {
  return {
    database: pool,
    secret: config.secret,
    baseURL: config.origin,
    basePath: '/api/auth',
    trustedOrigins: [config.origin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !provisioning,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
      cookiePrefix: 'construction',
      useSecureCookies: config.production,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
  } satisfies BetterAuthOptions
}

export function createAuth(pool: Pool, config: Config, provisioning = false) {
  return betterAuth(authOptions(pool, config, provisioning))
}
