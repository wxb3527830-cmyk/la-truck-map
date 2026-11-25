// Local mode is always usable. Shared mode only activates with explicit config and credentials.
export function read(key,fallback){try{return JSON.parse(localStorage.getItem('la-truck:'+key))??fallback;}catch{return fallback;}}
export function write(key,value){try{localStorage.setItem('la-truck:'+key,JSON.stringify(value));return true;}catch{window.dispatchEvent(new CustomEvent('storage-warning'));return false;}}
export function createEditStore(config){
 const enabled=config.shared&&/^https:\/\//.test(config.supabaseUrl)&&config.supabaseAnonKey;
 const headers={apikey:config.supabaseAnonKey,Authorization:`Bearer ${config.supabaseAnonKey}`,'Content-Type':'application/json'};
 const request=async(method,body,query='')=>{const r=await fetch(`${config.supabaseUrl}/rest/v1/driver_edits${query}`,{method,headers:{...headers,Prefer:'resolution=merge-duplicates'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('共享服务未连接，标记已保存在本机');return method==='GET'?r.json():null;};
 return {
  mode:enabled?'共享（本机备份）':'本机保存',
  async load(){const local=read('edits',[]);if(!enabled)return local;const remote=await request('GET',null,'?select=*&limit=1000');return [...new Map([...remote,...local].map(e=>[e.id,e])).values()];},
  async save(edits,changed){if(!write('edits',edits))throw Error('本机存储空间不足，未能保存；请导出备份');if(enabled&&changed)await request('POST',changed);},
  async remove(edits,id){if(!write('edits',edits))throw Error('本机存储空间不足，未能删除；请导出备份');if(enabled&&id)await request('DELETE',null,`?id=eq.${encodeURIComponent(id)}`);}
 };
}
