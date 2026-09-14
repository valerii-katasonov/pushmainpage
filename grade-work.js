// Фото роботи належать одній оцінці й лежать у захищеному дзеркалі учня.
import { ref, get } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, CLOUDINARY_URL, UPLOAD_PRESET, escHtml, safeHttpUrl } from './common.js';
let photos=[],generation=0,loading=false,readError='',busy=false,changed=false;
export function renderWorkPhotos(urls){
  const valid=(Array.isArray(urls)?urls:[]).map(safeHttpUrl).filter(Boolean);
  if(!valid.length)return '';
  return '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:7px;">'+valid.map((url,i)=>`<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" style="font-size:.8rem;">📷 Фото роботи ${i+1}</a>`).join('')+'</div>';
}
function renderEditorWork(){
  const box=document.getElementById('gep-work-existing');if(!box)return;
  if(loading){box.textContent='Завантаження фото...';return;}
  if(readError){box.textContent='Не вдалося прочитати фото. Закрийте й відкрийте оцінку повторно.';return;}
  box.innerHTML=photos.map((url,i)=>`<div style="display:flex;gap:8px;align-items:center;font-size:.8rem;">${renderWorkPhotos([url])}<button type="button" onclick="removeGradeWorkPhoto(${i})" style="width:auto;padding:4px;color:var(--red);" ${busy?'disabled':''}>✖</button></div>`).join('');
}
export async function loadGradeWork(cls,sid,ym,subj,date){
  const gen=++generation;photos=[];loading=true;readError='';pendingFiles=null;changed=false;
  const input=document.getElementById('gep-work-files');if(input)input.value='';
  renderEditorWork();
  try{
    const snap=await get(ref(db,`student_grades/${cls}/${sid}/${ym}/${subj}/${date}/workPhotos`));
    if(gen!==generation)return;
    photos=(snap.exists()&&Array.isArray(snap.val())?snap.val():[]).map(safeHttpUrl).filter(Boolean);
  }catch(e){if(gen===generation)readError=e.message||'Помилка читання';}
  finally{if(gen===generation){loading=false;renderEditorWork();}}
}
window.removeGradeWorkPhoto=function(index){if(busy||loading||readError)return;photos.splice(index,1);changed=true;renderEditorWork();};
export function setGradeWorkBusy(value){busy=value;
  const grade=document.getElementById('gep-value');if(grade)grade.disabled=value;
  document.querySelectorAll('#grade-editor-popup .type-btn, #grade-editor-popup .level-btn').forEach(button=>button.disabled=value);
  const input=document.getElementById('gep-work-files');if(input)input.disabled=value;renderEditorWork();}
export async function prepareGradeWork(){
  if(loading)throw Error('Фото ще завантажуються. Спробуйте за мить.');
  if(readError)throw Error('Не вдалося прочитати вкладення. Відкрийте оцінку повторно.');
  const input=document.getElementById('gep-work-files');
  const files=pendingFiles?pendingFiles.slice():Array.from(input?.files||[]);
  if(photos.length+files.length>3)throw Error('До оцінки можна додати не більше 3 фото');
  for(const file of files){
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)&&!( !file.type&&/\.(jpe?g|png|webp)$/i.test(file.name||'')))throw Error('Фото має бути у форматі JPG, PNG або WEBP');
    if(file.size>8*1024*1024)throw Error('Фото має бути не більше 8 МБ');
  }
  // Послідовне завантаження зберігає вже отримані URL для повторної
  // спроби запису: збій бази не змушує завантажувати ті самі фото знову.
  while(files.length){
    const file=files[0],form=new FormData();form.append('file',file);form.append('upload_preset',UPLOAD_PRESET);
    const response=await fetch(CLOUDINARY_URL,{method:'POST',body:form});
    const data=await response.json();
    if(!response.ok||!safeHttpUrl(data.secure_url))throw Error('Фото не завантажено: '+(data.error?.message||'помилка сервера'));
    photos.push(data.secure_url);changed=true;files.shift();
    // FileList недоступний для поелементної зміни: решту файлів тримаємо
    // окремо, щоб повторна спроба не подвоїла успішні вкладення.
    pendingFiles=files.slice();
  }
  if(input)input.value='';pendingFiles=null;
  renderEditorWork();return changed?(photos.length?[...photos]:null):undefined;
}
let pendingFiles=null;

document.addEventListener('change',e=>{if(e.target.id==='gep-work-files')pendingFiles=null;});

export function hasGradeWorkChanges(){return changed||!!(pendingFiles?.length)||!!document.getElementById('gep-work-files')?.files?.length;}
