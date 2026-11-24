import { appendFile,mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { AuditEvent,AuditStore } from "./types.js";
export function sha256(value:string):string{return createHash("sha256").update(value).digest("hex");}
export class JsonlAuditStore implements AuditStore {
 constructor(private readonly path:string){}
 async append(event:AuditEvent):Promise<void>{await mkdir(dirname(this.path),{recursive:true});await appendFile(this.path,JSON.stringify(event)+"\n",{encoding:"utf8",mode:0o600});}
}
export function makeAuditEvent(input:Omit<AuditEvent,"schemaVersion"|"timestamp">):AuditEvent{return {schemaVersion:1,timestamp:new Date().toISOString(),...input};}
