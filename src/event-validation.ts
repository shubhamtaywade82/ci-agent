export function validateExpectedHeadSha(eventName:string|undefined,value:string|undefined):string|undefined {
 if(eventName==="repository_dispatch"){
  if(!value||!/^[a-f0-9]{40}$/i.test(value))throw new Error("repository_dispatch review requires a valid 40-character head_sha.");
  return value;
 }
 if(value&&!/^[a-f0-9]{40}$/i.test(value))throw new Error("Expected head SHA must be a valid 40-character commit SHA.");
 return value;
}

const WRITE_ROLES=new Set(["admin","maintain","write"]);
/** Comment-triggered runs need a commenter with real write access; author_association alone is too coarse. */
export async function assertCommenterCanReview(eventName:string|undefined,login:string|undefined,permissionOf:(login:string)=>Promise<string>):Promise<void>{
 if(eventName!=="issue_comment")return;
 if(!login)throw new Error("Comment author could not be determined from the event payload.");
 const permission=await permissionOf(login);
 if(!WRITE_ROLES.has(permission))throw new Error("Commenter "+login+" lacks write access (permission: "+permission+").");
}
