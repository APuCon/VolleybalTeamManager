/* VolleybalTeamManager - beheer en verwijderknoppen */
(function(){
'use strict';
const originalPlayers=window.players;
const originalMatches=window.matches;
const originalMembers=window.members;

window.deletePlayer=async function(id,name){
  if(!confirm(`Speler ${name} definitief verwijderen? Aanwezigheidsregistraties worden eveneens verwijderd.`))return;
  try{await api('admin/players/'+encodeURIComponent(id)+'?teamId='+encodeURIComponent(selected.teamId),{method:'DELETE'});await window.players(document.querySelector('#pane'))}catch(e){alert(e.message)}
};
window.deleteMatch=async function(id,opponent){
  if(!confirm(`Wedstrijd tegen ${opponent} definitief verwijderen? Score, sets, opstellingen, aanwezigheid, rotaties en wissels worden eveneens verwijderd.`))return;
  try{await api('admin/matches/'+encodeURIComponent(id)+'?teamId='+encodeURIComponent(selected.teamId),{method:'DELETE'});await window.matches(document.querySelector('#pane'))}catch(e){alert(e.message)}
};
window.deleteMember=async function(userId,email){
  if(!confirm(`Coach ${email||''} uit dit team verwijderen?`))return;
  try{await api('admin/members/'+encodeURIComponent(userId)+'?teamId='+encodeURIComponent(selected.teamId),{method:'DELETE'});await window.members(document.querySelector('#pane'))}catch(e){alert(e.message)}
};
window.deleteTeam=async function(){
  const check=prompt(`Dit verwijdert team ${selected.teamName} en alle bijbehorende gegevens definitief. Typ exact de teamnaam om te bevestigen.`);
  if(check!==selected.teamName){if(check!==null)alert('Teamnaam komt niet overeen. Verwijderen geannuleerd.');return}
  try{await api('admin/teams/'+encodeURIComponent(selected.teamId),{method:'DELETE'});selected=null;await loadTeams()}catch(e){alert(e.message)}
};

window.players=async function(p){
  await originalPlayers(p);
  if(!canWrite())return;
  const list=await api('players?teamId='+selected.teamId);
  const rows=[...p.querySelectorAll('.row')].slice(1);
  rows.forEach((row,i)=>{const v=list[i];if(!v)return;const actions=row.querySelector('.row-actions');if(!actions||actions.querySelector('.delete-player'))return;const b=document.createElement('button');b.className='btn danger delete-player';b.textContent='Verwijderen';b.onclick=()=>deletePlayer(v.playerId,v.name);actions.appendChild(b)});
};
window.matches=async function(p){
  await originalMatches(p);
  if(!canWrite())return;
  const list=await api('matches?teamId='+selected.teamId);
  const rows=[...p.querySelectorAll('.row')].slice(1);
  rows.forEach((row,i)=>{const m=list[i];if(!m)return;const actions=row.querySelector('.row-actions');if(!actions||actions.querySelector('.delete-match'))return;const b=document.createElement('button');b.className='btn danger delete-match';b.textContent='Verwijderen';b.onclick=()=>deleteMatch(m.matchId,m.opponent);actions.appendChild(b)});
};
window.members=async function(p){
  const list=await api('members?teamId='+selected.teamId);
  p.innerHTML=`<div class="row"><h3>Teamleden</h3>${selected.role==='Owner'?'<button class="btn" onclick="inviteForm()">Uitnodigen</button>':''}</div>${list.map(m=>`<div class="row"><div>${esc(m.email)}</div><div class="row-actions"><span class="pill">${esc(m.role)}</span>${selected.role==='Owner'&&m.role!=='Owner'?`<button class="btn danger" onclick="deleteMember('${esc(m.rowKey)}','${esc(m.email)}')">Verwijderen</button>`:''}</div></div>`).join('')}<div id="iform"></div>`;
};

function addTeamDeleteButton(){
  if(!window.selected||selected.role!=='Owner')return;
  const pane=document.querySelector('#pane');
  if(!pane)return;
  const teamHeading=[...document.querySelectorAll('h2')].find(x=>x.textContent===selected.teamName);
  const host=teamHeading?.parentElement;
  if(!host||host.querySelector('.delete-team'))return;
  const b=document.createElement('button');b.className='btn danger delete-team';b.textContent='Team verwijderen';b.onclick=deleteTeam;host.appendChild(document.createTextNode(' '));host.appendChild(b);
}
new MutationObserver(addTeamDeleteButton).observe(document.body,{childList:true,subtree:true});
addTeamDeleteButton();
})();
