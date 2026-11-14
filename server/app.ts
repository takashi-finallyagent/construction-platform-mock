import { createHash, randomUUID } from 'node:crypto'
import Fastify, { LogController } from 'fastify'
import { fromNodeHeaders } from 'better-auth/node'
import type { Pool, PoolClient } from 'pg'
import { createAuth } from './auth.ts'
import type { Config } from './config.ts'
import { assertRuntimeRole, transaction } from './db.ts'
import { HttpError, jobColumns, jobProperties, normalizeJob, type JobInput } from './jobs.ts'
import { registerClassificationRoutes } from './classification-routes.ts'
import { registerWorkflowRoutes } from './workflow-routes.ts'
import { registerFileRoutes } from './file-routes.ts'

const uuid = { type: 'string', format: 'uuid' }
const companyParams = { type: 'object', additionalProperties: false, required: ['companyId'], properties: { companyId: uuid } }
const jobParams = { type: 'object', additionalProperties: false, required: ['companyId', 'jobId'], properties: { companyId: uuid, jobId: uuid } }
type CompanyParams = { companyId: string }
type JobParams = CompanyParams & { jobId: string }
const queryInteger = { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 10 }

function parseQueryInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new HttpError(400, '入力内容を確認してください。')
  return parsed
}

function temporarilyUnavailable(error: { code?: string; message: string }) {
  return !!error.code && (/^08/.test(error.code) || ['40001', '40P01', '55P03', '57014', '53300', '57P01', '57P02', '57P03',
    'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(error.code)) ||
    ['Connection terminated unexpectedly', 'Connection terminated due to connection timeout', 'timeout exceeded when trying to connect'].includes(error.message)
}

async function member(client: PoolClient, companyId: string, write = false) {
  const { rows } = await client.query('SELECT role FROM public.lock_membership($1)', [companyId])
  if (!rows[0]) throw new HttpError(404, '対象が見つかりません。')
  if (write && rows[0].role === 'viewer') throw new HttpError(403, '変更する権限がありません。')
  return rows[0].role as string
}

export async function buildApp(pool: Pool, config: Config, logger = false) {
  await assertRuntimeRole(pool)
  const auth = createAuth(pool, config)
  const app = Fastify({ logger, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 32 * 1024,
    genReqId: () => randomUUID(), requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } })
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== config.origin) {
      return reply.code(403).send({ message: 'この送信元からの操作は許可されていません。' })
    }
  })
  app.setErrorHandler((error: Error & { validation?: unknown; statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ message: error.message })
    if (error.validation || error.statusCode === 400) return reply.code(400).send({ message: '入力内容を確認してください。' })
    if (error.statusCode === 413) return reply.code(413).send({ message: '送信内容が大きすぎます。' })
    if (error.statusCode === 415) return reply.code(415).send({ message: 'この送信形式は使用できません。' })
    request.log.error({ requestId: request.id, code: error.code ?? 'INTERNAL' }, 'Request failed')
    return temporarilyUnavailable(error)
      ? reply.code(503).send({ message: '保存結果を確認できません。時間をおいて保存内容を確認してください。' })
      : reply.code(500).send({ message: '処理中にエラーが発生しました。保存内容を確認してください。' })
  })
  const requestHeaders = (request: { headers: Parameters<typeof fromNodeHeaders>[0]; ip: string }) => {
    const headers = fromNodeHeaders(request.headers)
    headers.delete('x-forwarded-for')
    headers.set('x-real-ip', request.ip)
    return headers
  }
  app.route({
    method: ['GET', 'POST'], url: '/api/auth/*',
    handler: async (request, reply) => {
      const pathname = new URL(request.url, config.origin).pathname
      const allowed = (request.method === 'POST' && ['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(pathname)) ||
        (request.method === 'GET' && pathname === '/api/auth/get-session')
      if (!allowed) return reply.code(404).send({ message: '対象が見つかりません。' })
      const response = await auth.handler(new Request(new URL(request.url, config.origin), {
        method: request.method, headers: requestHeaders(request),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      }))
      reply.code(response.status)
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') reply.header(key, value) })
      const cookies = response.headers.getSetCookie()
      if (cookies.length) reply.header('set-cookie', cookies)
      return reply.send(await response.text())
    },
  })
  app.get('/api/health', async () => { await pool.query('SELECT 1'); return { status: 'ok' } })
  await app.register(async (routes) => {
    routes.decorateRequest('actorId', '')
    routes.addHook('preHandler', async (request, reply) => {
      const session = await auth.api.getSession({ headers: requestHeaders(request) })
      if (!session) return reply.code(401).send({ message: 'ログインしてください。' })
      request.actorId = session.user.id
      const params = request.params as Partial<JobParams>
      if (params.companyId) params.companyId = params.companyId.toLowerCase()
      if (params.jobId) params.jobId = params.jobId.toLowerCase()
    })
    registerClassificationRoutes(routes, pool, member)
    registerWorkflowRoutes(routes, pool, member)
    await registerFileRoutes(routes, pool, member, async request => {
      const session = await auth.api.getSession({ headers: requestHeaders(request) })
      if (!session) throw new HttpError(401, 'ログインしてください。')
      return session.user.id
    })
    routes.get('/api/me', async (request) => transaction(pool, request.actorId, async (client) => {
      const user = await client.query('SELECT id, name, email FROM "user" WHERE id = $1', [request.actorId])
      const companies = await client.query(`SELECT c.id, c.name, m.role FROM companies c JOIN memberships m ON c.id = m.company_id ORDER BY c.name, c.id`)
      return { user: user.rows[0], companies: companies.rows }
    }))
    routes.get<{ Params: CompanyParams; Querystring: { offset?: string; limit?: string } }>('/api/companies/:companyId/jobs', {
      schema: { params: companyParams, querystring: { type: 'object', additionalProperties: false, properties: {
        offset: queryInteger, limit: queryInteger,
      } } },
    }, async (request) => transaction(pool, request.actorId, async (client) => {
      await member(client, request.params.companyId)
      const result = await client.query(`SELECT ${jobColumns} FROM jobs WHERE company_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
        [request.params.companyId, parseQueryInteger(request.query.limit, 50, 1, 100), parseQueryInteger(request.query.offset, 0, 0, 100000)])
      const count = await client.query('SELECT count(*)::integer AS total FROM jobs WHERE company_id = $1', [request.params.companyId])
      return { jobs: result.rows, total: count.rows[0].total }
    }))
    routes.post<{ Params: CompanyParams; Body: JobInput }>('/api/companies/:companyId/jobs', {
      schema: { params: companyParams, body: { type: 'object', additionalProperties: false, required: Object.keys(jobProperties), properties: jobProperties },
        headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': uuid } } },
    }, async (request, reply) => {
      const body = normalizeJob(request.body)
      const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      const key = (request.headers['idempotency-key'] as string).toLowerCase()
      const companyId = request.params.companyId
      const result = await transaction(pool, request.actorId, async (client) => {
        await member(client, companyId, true)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${companyId}/${request.actorId}/${key}`])
        const existing = await client.query('SELECT body_hash, response_data FROM creation_requests WHERE company_id=$1 AND user_id=$2 AND request_key=$3', [companyId, request.actorId, key])
        if (existing.rows[0]) {
          if (existing.rows[0].body_hash !== hash) throw new HttpError(409, '同じ送信番号で内容が変わっています。再度入力内容を確認してください。')
          return { job: existing.rows[0].response_data, status: 200 }
        }
        const job = (await client.query(`INSERT INTO jobs (id, company_id, name, site_address, customer_name, work_description, planned_start, planned_end, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${jobColumns}`,
        [randomUUID(), companyId, body.name, body.siteAddress, body.customerName, body.workDescription, body.plannedStart, body.plannedEnd, request.actorId])).rows[0]
        await client.query('INSERT INTO creation_requests(company_id,user_id,request_key,body_hash,job_id,response_data) VALUES($1,$2,$3,$4,$5,$6)',
          [companyId, request.actorId, key, hash, job.id, JSON.stringify(job)])
        return { job, status: 201 }
      }, request.id)
      return reply.code(result.status).send(result.job)
    })
    routes.get<{ Params: JobParams }>('/api/companies/:companyId/jobs/:jobId', { schema: { params: jobParams } }, async (request) =>
      transaction(pool, request.actorId, async (client) => {
        const { rows } = await client.query(`SELECT ${jobColumns} FROM jobs WHERE company_id=$1 AND id=$2`, [request.params.companyId, request.params.jobId])
        if (!rows[0]) throw new HttpError(404, '対象が見つかりません。')
        return rows[0]
      }))
    routes.patch<{ Params: JobParams; Body: JobInput & { version: number } }>('/api/companies/:companyId/jobs/:jobId', {
      schema: { params: jobParams, body: { type: 'object', additionalProperties: false, required: [...Object.keys(jobProperties), 'version'],
        properties: { ...jobProperties, version: { type: 'integer', minimum: 1, maximum: 2147483646 } } } },
    }, async (request) => {
      const body = normalizeJob(request.body)
      return transaction(pool, request.actorId, async (client) => {
        await member(client, request.params.companyId, true)
        const previous = (await client.query(`SELECT ${jobColumns} FROM jobs WHERE company_id=$1 AND id=$2 FOR UPDATE`, [request.params.companyId, request.params.jobId])).rows[0]
        if (!previous) throw new HttpError(404, '対象が見つかりません。')
        if (previous.version !== request.body.version) throw new HttpError(409, '別の更新がありました。前回の送信結果は不明なため、最新の保存内容を確認してください。')
        const job = (await client.query(`UPDATE jobs SET name=$3, site_address=$4, customer_name=$5, work_description=$6, planned_start=$7, planned_end=$8,
          version=version+1 WHERE company_id=$1 AND id=$2 RETURNING ${jobColumns}`,
        [request.params.companyId, request.params.jobId, body.name, body.siteAddress, body.customerName, body.workDescription, body.plannedStart, body.plannedEnd])).rows[0]
        return job
      }, request.id)
    })
    routes.get<{ Params: JobParams; Querystring: { limit?: string; cursor?: string } }>('/api/companies/:companyId/jobs/:jobId/audit', {
      schema: { params: jobParams, querystring: { type: 'object', additionalProperties: false, properties: { limit: queryInteger, cursor: queryInteger } } },
    }, async (request) =>
      transaction(pool, request.actorId, async (client) => {
        const limit = parseQueryInteger(request.query.limit, 50, 1, 100)
        const cursor = request.query.cursor === undefined ? null : parseQueryInteger(request.query.cursor, 1, 1, 2147483647)
        await member(client, request.params.companyId, true)
        const exists = await client.query('SELECT 1 FROM jobs WHERE company_id=$1 AND id=$2', [request.params.companyId, request.params.jobId])
        if (!exists.rowCount) throw new HttpError(404, '対象が見つかりません。')
        const result = await client.query(`SELECT a.id, a.actor_id AS "actorId", a.actor_name AS "actorName", a.action,
          a.occurred_at AS "occurredAt", a.before_data AS "beforeData", a.after_data AS "afterData",
          a.target_version AS "targetVersion", a.request_id AS "requestId"
          FROM audit_events a WHERE a.company_id=$1 AND a.target_id=$2 AND ($3::integer IS NULL OR a.target_version<$3)
          ORDER BY a.target_version DESC LIMIT $4`,
        [request.params.companyId, request.params.jobId, cursor, limit + 1])
        const events = result.rows.slice(0, limit)
        return { events, nextCursor: result.rows.length > limit ? String(events[events.length - 1].targetVersion) : null }
      }))
  })
  return app
}

declare module 'fastify' {
  interface FastifyRequest { actorId: string }
}
