import type { FastifyInstance } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { transaction } from './db.ts'
import { HttpError } from './jobs.ts'
import { basisSql, recordSql, normalizeClassification, classificationView } from './classification.ts'
import type { ClassificationPut } from '../src/product/classification-model.ts'

const prefix = '/api/companies/:companyId/jobs/:jobId/classification'
type Params = { companyId: string; jobId: string }
const uuid = { type: 'string', format: 'uuid' }
const params = { type: 'object', additionalProperties: false, required: ['companyId','jobId'], properties: { companyId: uuid, jobId: uuid } }
const integer = { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 }
const conflict = () => new HttpError(409, '別の更新があります。最新の工事情報と保存内容を確認してください。')

export function registerClassificationRoutes(routes: FastifyInstance, pool: Pool,
  member: (client: PoolClient, companyId: string, write?: boolean) => Promise<string>) {
  const read = async (client: PoolClient, p: Params) => {
    // One statement observes both rows in the same MVCC snapshot, including viewer reads.
    const result = await client.query(`SELECT ${basisSql('j')} AS basis, ${recordSql('c')} AS record
      FROM public.jobs j LEFT JOIN public.job_classifications c ON c.company_id=j.company_id AND c.job_id=j.id
      WHERE j.company_id=$1 AND j.id=$2`, [p.companyId,p.jobId])
    if (!result.rows[0]) throw new HttpError(404, '対象が見つかりません。')
    return classificationView(p.companyId,p.jobId,result.rows[0].basis,result.rows[0].record)
  }
  routes.get<{ Params: Params }>(prefix, { schema: { params } }, async request =>
    transaction(pool, request.actorId, async client => {
      await member(client,request.params.companyId)
      return read(client,request.params)
    },request.id))

  routes.put<{ Params: Params; Body: ClassificationPut }>(prefix, { schema: { params, body: {
    type: 'object', additionalProperties: false, required: ['version','jobVersion','data'], properties: {
      version: { type: 'integer', minimum: 0, maximum: 2147483646 },
      jobVersion: { type: 'integer', minimum: 1, maximum: 2147483647 }, data: { type: 'object' },
    },
  } } }, async (request,reply) => {
    const data = normalizeClassification(request.body.data)
    const p = request.params
    const result = await transaction(pool, request.actorId, async client => {
      await member(client,p.companyId,true)
      const job = (await client.query('SELECT version FROM public.jobs WHERE company_id=$1 AND id=$2 FOR UPDATE',[p.companyId,p.jobId])).rows[0]
      if (!job) throw new HttpError(404, '対象が見つかりません。')
      if (job.version !== request.body.jobVersion) throw conflict()
      const old = (await client.query('SELECT version FROM public.job_classifications WHERE company_id=$1 AND job_id=$2 FOR UPDATE',[p.companyId,p.jobId])).rows[0]
      if ((old?.version ?? 0) !== request.body.version) throw conflict()
      if (old) {
        await client.query(`UPDATE public.job_classifications SET version=version+1,data=$3,basis_job_version=$4
          WHERE company_id=$1 AND job_id=$2`,[p.companyId,p.jobId,JSON.stringify(data),request.body.jobVersion])
      } else {
        await client.query(`INSERT INTO public.job_classifications(company_id,job_id,version,data,basis_job_version) VALUES($1,$2,1,$3,$4)`,
          [p.companyId,p.jobId,JSON.stringify(data),request.body.jobVersion])
      }
      return { view: await read(client,p), status: old ? 200 : 201 }
    },request.id)
    return reply.code(result.status).send(result.view)
  })

  routes.get<{ Params: Params; Querystring: { limit?: string; cursor?: string } }>(`${prefix}/audit`, {
    schema: { params, querystring: { type: 'object', additionalProperties: false, properties: { limit: integer, cursor: integer } } },
  }, async request => transaction(pool,request.actorId,async client => {
    const p=request.params
    await member(client,p.companyId,true)
    const limit=Number(request.query.limit ?? 50)
    const cursor=request.query.cursor === undefined ? null : Number(request.query.cursor)
    if (!Number.isInteger(limit) || limit<1 || limit>100 || cursor !== null && (!Number.isInteger(cursor) || cursor<1 || cursor>2147483647)) {
      throw new HttpError(400, '入力内容を確認してください。')
    }
    if (!(await client.query('SELECT 1 FROM public.jobs WHERE company_id=$1 AND id=$2',[p.companyId,p.jobId])).rowCount) {
      throw new HttpError(404, '対象が見つかりません。')
    }
    const result=await client.query(`SELECT id,company_id AS "companyId",job_id AS "jobId",actor_id AS "actorId",actor_name AS "actorName",
      action,occurred_at AS "occurredAt",target_version AS "targetVersion",request_id AS "requestId",before_data AS "beforeData",after_data AS "afterData"
      FROM public.classification_audit_events WHERE company_id=$1 AND job_id=$2 AND ($3::integer IS NULL OR target_version<$3)
      ORDER BY target_version DESC LIMIT $4`,[p.companyId,p.jobId,cursor,limit+1])
    const events=result.rows.slice(0,limit)
    return { events,nextCursor:result.rows.length>limit ? String(events[events.length-1].targetVersion) : null }
  },request.id))
}
