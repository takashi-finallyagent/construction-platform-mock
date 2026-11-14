import type { FastifyInstance } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { emptyWorkflow, type WorkflowView, type WorkflowPut, type SitePhoto, type WorkflowData } from '../src/product/workflow-model.ts'
import { transaction } from './db.ts'
import { HttpError, jobColumns } from './jobs.ts'
import { classificationView, basisSql, recordSql } from './classification.ts'
import { normalizeWorkflow, normalizePhoto, validateWorkflow } from './workflow.ts'

export type WorkflowParams = { companyId: string; jobId: string }
export type MembershipCheck = (client: PoolClient, companyId: string, write?: boolean) => Promise<string>
const prefix = '/api/companies/:companyId/jobs/:jobId/workflow'
const uuid = { type: 'string', format: 'uuid' }
export const workflowParamsSchema = { type: 'object', additionalProperties: false, required: ['companyId','jobId'], properties: { companyId: uuid, jobId: uuid } }
const integer = { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 }
const conflict = () => new HttpError(409, '別の更新があります。最新の工事・分類・業務記録を確認してください。')

export async function workflowRead(client: PoolClient, p: WorkflowParams): Promise<WorkflowView> {
  const row = (await client.query(`SELECT j.version AS "jobVersion",c.version AS "classificationVersion",w.version,w.data,
    w.updated_at AS "updatedAt",w.updated_by AS "updatedBy" FROM public.jobs j
    LEFT JOIN public.job_classifications c ON c.company_id=j.company_id AND c.job_id=j.id
    LEFT JOIN public.job_workflows w ON w.company_id=j.company_id AND w.job_id=j.id WHERE j.company_id=$1 AND j.id=$2`,[p.companyId,p.jobId])).rows[0]
  if (!row) throw new HttpError(404, '対象が見つかりません。')
  return { companyId:p.companyId,jobId:p.jobId,version:row.version ?? 0,jobVersion:row.jobVersion,classificationVersion:row.classificationVersion,
    data:row.data ?? emptyWorkflow(),updatedAt:row.updatedAt?.toISOString() ?? null,updatedBy:row.updatedBy ?? null }
}

async function locked(client: PoolClient,p: WorkflowParams) {
  const job=(await client.query(`SELECT ${jobColumns} FROM public.jobs WHERE company_id=$1 AND id=$2 FOR UPDATE`,[p.companyId,p.jobId])).rows[0]
  if (!job) throw new HttpError(404, '対象が見つかりません。')
  // Job lock serializes classification writes; read current classification before workflow row lock.
  const classification=(await client.query(`SELECT ${basisSql('j')} AS basis,${recordSql('c')} AS record FROM public.jobs j
    LEFT JOIN public.job_classifications c ON c.company_id=j.company_id AND c.job_id=j.id WHERE j.company_id=$1 AND j.id=$2`,[p.companyId,p.jobId])).rows[0]
  const old=(await client.query('SELECT version,data FROM public.job_workflows WHERE company_id=$1 AND job_id=$2 FOR UPDATE',[p.companyId,p.jobId])).rows[0]
  const view=classificationView(p.companyId,p.jobId,classification.basis,classification.record)
  return { job,old,classificationVersion:classification.record?.version ?? null,classification:view }
}
async function save(client: PoolClient,p: WorkflowParams,data: WorkflowData,version: number,jobVersion: number,classificationVersion: number | null) {
  try {
    if (version>0) await client.query(`UPDATE public.job_workflows SET version=version+1,data=$3,basis_job_version=$4,classification_version=$5
      WHERE company_id=$1 AND job_id=$2`,[p.companyId,p.jobId,JSON.stringify(data),jobVersion,classificationVersion])
    else await client.query(`INSERT INTO public.job_workflows(company_id,job_id,version,data,basis_job_version,classification_version)
      VALUES($1,$2,1,$3,$4,$5)`,[p.companyId,p.jobId,JSON.stringify(data),jobVersion,classificationVersion])
  } catch (error) {
    if ((error as {code?:string}).code==='23514') throw new HttpError(400,'業務記録の必須項目・日付・金額・資料との関連を確認してください。')
    throw error
  }
  return workflowRead(client,p)
}
export function registerWorkflowRoutes(routes: FastifyInstance,pool: Pool,member: MembershipCheck) {
  routes.get<{Params:WorkflowParams}>(prefix,{schema:{params:workflowParamsSchema}},async request=>transaction(pool,request.actorId,async client=>{
    await member(client,request.params.companyId)
    return workflowRead(client,request.params)
  },request.id))
  routes.put<{Params:WorkflowParams;Body:WorkflowPut}>(prefix,{bodyLimit:512*1024,schema:{params:workflowParamsSchema,body:{
    type:'object',additionalProperties:false,required:['version','jobVersion','classificationVersion','data'],properties:{
      version:{type:'integer',minimum:0,maximum:2147483646},jobVersion:{type:'integer',minimum:1,maximum:2147483647},
      classificationVersion:{anyOf:[{type:'integer',minimum:1,maximum:2147483647},{type:'null'}]},data:{type:'object'},
    },
  }}},async(request,reply)=>{
    const data=normalizeWorkflow(request.body.data),p=request.params
    const result=await transaction(pool,request.actorId,async client=>{
      await member(client,p.companyId,true)
      const state=await locked(client,p)
      if ((state.old?.version ?? 0)!==request.body.version || state.job.version!==request.body.jobVersion
        || state.classificationVersion!==request.body.classificationVersion) throw conflict()
      validateWorkflow(data,state.old?.data ?? emptyWorkflow(),state.job,state.classificationVersion,state.classification)
      return {view:await save(client,p,data,state.old?.version ?? 0,state.job.version,state.classificationVersion),status:state.old?200:201}
    },request.id)
    return reply.code(result.status).send(result.view)
  })
  routes.post<{Params:WorkflowParams;Body:SitePhoto}>(`${prefix}/photos`,{bodyLimit:512*1024,schema:{params:workflowParamsSchema}},async(request,reply)=>{
    const photo=normalizePhoto(request.body),p=request.params
    const result=await transaction(pool,request.actorId,async client=>{
      await member(client,p.companyId,true)
      const state=await locked(client,p),data:WorkflowData=structuredClone(state.old?.data ?? emptyWorkflow())
      const existing=data.photos.find(v=>v.id===photo.id)
      if (existing) {
        if (!isDeepStrictEqual(existing,photo)) throw conflict()
        return {view:await workflowRead(client,p),status:200}
      }
      data.photos.push(photo)
      const normalized=normalizeWorkflow(data)
      validateWorkflow(normalized,state.old?.data ?? emptyWorkflow(),state.job,state.classificationVersion,state.classification)
      return {view:await save(client,p,normalized,state.old?.version ?? 0,state.job.version,state.classificationVersion),status:201}
    },request.id)
    return reply.code(result.status).send(result.view)
  })
  routes.get<{Params:WorkflowParams;Querystring:{limit?:string;cursor?:string}}>(`${prefix}/audit`,{schema:{params:workflowParamsSchema,
    querystring:{type:'object',additionalProperties:false,properties:{limit:integer,cursor:integer}}}},async request=>transaction(pool,request.actorId,async client=>{
    const p=request.params,limit=Number(request.query.limit ?? 50),cursor=request.query.cursor===undefined?null:Number(request.query.cursor)
    if (!Number.isSafeInteger(limit) || limit<1 || limit>50 || cursor!==null && (!Number.isSafeInteger(cursor)||cursor<1||cursor>2147483647)) throw new HttpError(400,'入力内容を確認してください。')
    await member(client,p.companyId,true)
    if (!(await client.query('SELECT 1 FROM public.jobs WHERE company_id=$1 AND id=$2',[p.companyId,p.jobId])).rowCount) throw new HttpError(404,'対象が見つかりません。')
    const result=await client.query(`SELECT id,version,actor_name AS "actorName",occurred_at AS "occurredAt",before_data AS "beforeData",after_data AS "afterData"
      FROM public.workflow_audit_events WHERE company_id=$1 AND job_id=$2 AND ($3::integer IS NULL OR version<$3) ORDER BY version DESC LIMIT $4`,[p.companyId,p.jobId,cursor,limit+1])
    const events=result.rows.slice(0,limit)
    return {events,nextCursor:result.rows.length>limit?String(events[events.length-1].version):null}
  },request.id))
}
