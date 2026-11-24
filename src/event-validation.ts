export function validateExpectedHeadSha(eventName:string|undefined,value:string|undefined):string|undefined {
 if(eventName==="repository_dispatch"){
  if(!value||!/^[a-f0-9]{40}$/i.test(value))throw new Error("repository_dispatch review requires a valid 40-character head_sha.");
  return value;
 }
 if(value&&!/^[a-f0-9]{40}$/i.test(value))throw new Error("Expected head SHA must be a valid 40-character commit SHA.");
 return value;
}
