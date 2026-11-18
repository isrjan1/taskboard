/* Shared by all pages: API helper (cookie session), theme, login/logout. */
function applyTheme(t){
  [...document.body.classList].filter(c=>c.startsWith('th-')).forEach(c=>document.body.classList.remove(c));
  document.body.classList.add('th-'+t);
}
applyTheme(localStorage.getItem('stb_theme')||'white');

async function api(path,method='GET',body){
  const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});
  let d={};try{d=await r.json()}catch(e){}
  if(!r.ok){const e=new Error(d.error||('Server error '+r.status));e.status=r.status;throw e}
  return d;
}
const login=(u,p)=>api('/api/login','POST',{username:u,password:p}).then(d=>d.user);
async function currentUser(){try{return await api('/api/me')}catch(e){return null}} // {user,board} or null
async function logout(){
  // Only leave the page once the server confirms the session is gone; otherwise the login page would see the
  // still-valid cookie and sign you straight back in.
  try{await api('/api/logout','POST',{})}
  catch(e){alert('Could not log out ('+(e.message||'network error')+'). Please check your connection and try again.');return}
  location.replace('login.html');
}
// Back/forward cache: never show a signed-in page from memory after logging out.
addEventListener('pageshow',async e=>{
  if(!e.persisted||/login\.html$/.test(location.pathname))return;
  if(!(await currentUser()))location.replace('login.html');
});
