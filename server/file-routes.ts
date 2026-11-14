import { open } from 'node:fs/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { transaction } from './db.ts'
import { HttpError } from './jobs.ts'
import { fileLimit, fileTypes, fileName, inspectFile, persistFile, storagePath } from './file-storage.ts'
import { workflowParamsSchema, type WorkflowParams, type MembershipCheck } from './workflow-routes.ts'

const prefix='/api/companies/:companyId/jobs/:jobId/files'
type Params=WorkflowParams & {fileId:string}
const params={...workflowParamsSchema,required:['companyId','jobId','fileId'],properties:{...workflowParamsSchema.properties,fileId:{type:'string',format:'uuid'}}}
const columns=`id,company_id AS "companyId",job_id AS "jobId",name,content_type AS "contentType",size,sha256,kind,created_at AS "createdAt",created_by AS "createdBy"`
export async function registerFileRoutes(routes: FastifyInstance,pool: Pool,member: MembershipCheck,authenticate:(request:FastifyRequest)=>Promise<string>) {
  await routes.register(async files=>{
    files.addContentTypeParser([...fileTypes],{parseAs:'buffer',bodyLimit:fileLimit},(_request,body,done)=>done(null,body))
    files.addHook('onRequest',async request=>{
      // Runs before Fastify reads any upload bytes. Recheck under the write transaction too.
      request.actorId=await authenticate(request)
      const p=request.params as Params
      for (const key of ['companyId','jobId',...(request.method==='PUT'||p.fileId?['fileId']:[])] as const) {
        const value=p[key as keyof Params]
        if (typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(400,'入力内容を確認してください。')
      }
      p.companyId=p.companyId.toLowerCase();p.jobId=p.jobId.toLowerCase();if(p.fileId)p.fileId=p.fileId.toLowerCase()
      await transaction(pool,request.actorId,async client=>{
        await member(client,p.companyId,request.method==='PUT')
        if (!(await client.query('SELECT 1 FROM public.jobs WHERE company_id=$1 AND id=$2',[p.companyId,p.jobId])).rowCount) throw new HttpError(404,'対象が見つかりません。')
      },request.id)
    })
    files.get<{Params:WorkflowParams}>(prefix,{schema:{params:workflowParamsSchema}},async request=>transaction(pool,request.actorId,async client=>{
      const p=request.params
      await member(client,p.companyId)
      return {files:(await client.query(`SELECT ${columns} FROM public.job_files WHERE company_id=$1 AND job_id=$2 ORDER BY created_at,id`,[p.companyId,p.jobId])).rows}
    },request.id))
    files.put<{Params:Params}>(`${prefix}/:fileId`,{bodyLimit:fileLimit,schema:{params}},async(request,reply)=>{
      const p=request.params,name=fileName(request.headers['x-file-name']),kind=request.headers['x-file-kind'],type=request.headers['content-type'] ?? ''
      if ((kind!=='photo'&&kind!=='evidence') || !fileTypes.includes(type as typeof fileTypes[number])) throw new HttpError(415,'保存形式を確認してください。')
      const {body,sha256}=await inspectFile(request.body,type,kind)
      const result=await transaction(pool,request.actorId,async client=>{
        await member(client,p.companyId,true)
        if (!(await client.query('SELECT 1 FROM public.jobs WHERE company_id=$1 AND id=$2 FOR UPDATE',[p.companyId,p.jobId])).rowCount) throw new HttpError(404,'対象が見つかりません。')
        // File IDs are globally unique. The advisory lock also serializes cross-job attempts.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[p.fileId])
        const existing=(await client.query(`SELECT ${columns} FROM public.job_files WHERE id=$1`,[p.fileId])).rows[0]
        if (existing) {
          if (existing.companyId!==p.companyId || existing.jobId!==p.jobId || existing.name!==name || existing.kind!==kind
            || existing.contentType!==type || existing.sha256!==sha256 || existing.size!==body.length) throw new HttpError(409,'同じファイル番号の内容が異なります。')
          return {file:existing,status:200}
        }
        const storageKey=await persistFile(body)
        try {
          const file=(await client.query(`INSERT INTO public.job_files(id,company_id,job_id,name,content_type,size,sha256,kind,storage_key)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${columns}`,[p.fileId,p.companyId,p.jobId,name,type,body.length,sha256,kind,storageKey])).rows[0]
          return {file,status:201}
        } catch (error) {
          // Never delete bytes on uncertain DB outcomes; a private orphan is recoverable.
          if ((error as {code?:string}).code==='23505') throw new HttpError(409,'同じファイル番号が使用されています。')
          throw error
        }
      },request.id)
      return reply.code(result.status).send(result.file)
    })
    files.get<{Params:Params}>(`${prefix}/:fileId`,{schema:{params}},async(request,reply)=>{
      const file=await transaction(pool,request.actorId,async client=>{
        const p=request.params
        await member(client,p.companyId)
        const found=(await client.query(`SELECT ${columns},storage_key FROM public.job_files WHERE company_id=$1 AND job_id=$2 AND id=$3`,[p.companyId,p.jobId,p.fileId])).rows[0]
        if (!found) throw new HttpError(404,'対象が見つかりません。')
        return found
      },request.id)
      let handle
      try { handle=await open(storagePath(file.storage_key),'r') } catch(error) {
        if ((error as {code?:string}).code==='ENOENT') throw new HttpError(503,'保存ファイルを確認できません。管理者に確認してください。')
        throw error
      }
      const disposition=file.contentType==='application/pdf'?'attachment':'inline'
      const encoded=encodeURIComponent(file.name).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      reply.header('Content-Type',file.contentType).header('Content-Length',String(file.size)).header('X-Content-Type-Options','nosniff')
        .header('Content-Security-Policy',"sandbox; default-src 'none'").header('Content-Disposition',`${disposition}; filename="download"; filename*=UTF-8''${encoded}`)
      return reply.send(handle.createReadStream())
    })
  })
}
