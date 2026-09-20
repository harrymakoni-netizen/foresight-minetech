import { get, head, put, BlobPreconditionFailedError } from '@vercel/blob';
import type {RecordItem} from './model';
export type State={records:RecordItem[];audit:any[]};
const pathname='minetech/private-workspace.json';
export async function readCloudState(){
 for(let attempt=0;attempt<3;attempt++){
  const result=await get(pathname,{access:'private',useCache:false});
  if(!result)return {state:{records:[],audit:[]} as State,etag:undefined};
  if(result.statusCode!==200||!result.stream)throw new Error('Storage is temporarily unavailable.');
  const state=JSON.parse(await new Response(result.stream).text()) as State;
  // Delivery may expose a weak ETag after compression. Conditional writes need
  // the authoritative storage validator, and it must identify the same version.
  const metadata=await head(pathname);
  if(result.blob.etag.replace(/^W\//,'')===metadata.etag)return {state,etag:metadata.etag};
 }
 throw new Error('The workspace changed while reading. Refresh and retry.');
}
export async function saveCloudState(state:State,etag?:string){await put(pathname,JSON.stringify(state),{access:'private',addRandomSuffix:false,contentType:'application/json',...(etag?{ifMatch:etag}:{allowOverwrite:false})});}
export {BlobPreconditionFailedError};
