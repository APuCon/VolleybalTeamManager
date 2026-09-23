'use strict';
const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');
const connectionString=()=>process.env.VOLLEYBALL_STORAGE_CONNECTION;
const table=n=>TableClient.fromConnectionString(connectionString(),n);
const response=(status,body)=>({status,jsonBody:body});
const clean=(v,n=150)=>String(v||'').trim().slice(0,n);
const roles=['setter','buiten1','midden1','dia','buiten2','midden2'];
const setKey=(matchId,n)=>`${matchId}_${String(n).padStart(2,'0')}`;
async function ensure(c){try{await c.createTable()}catch(e){if(e.statusCode!==409)throw e}}
function principal(req){const h=req.headers.get('x-ms-client-principal');if(!h)return null;try{return JSON.parse(Buffer.from(h,'base64').toString('utf8'))}catch{return null}}
async function membership(teamId,userId){const c=table('VTMTeamMembers');await ensure(c);try{return await c.getEntity(teamId,userId)}catch(e){if(e.statusCode===404)return null;throw e}}
async function getAll(c,filter){const a=[];for await(const x of c.listEntities({queryOptions:{filter}}))a.push(x);return a}
async function exists(c,pk,rk){try{return await c.getEntity(pk,rk)}catch(e){if(e.statusCode===404)return null;throw e}}
app.http('nextSetSafe',{methods:['POST'],authLevel:'anonymous',route:'live/next-set-safe',handler:async req=>{
  let createdSet=false,setId='',sets,rollbackTeamId='';
  try{
    const p=principal(req);if(!p)return response(401,{error:'Niet ingelogd'});
    const b=await req.json(),teamId=clean(b.teamId,100),matchId=clean(b.matchId,100),previous=b.previousLineup||null;
    rollbackTeamId=teamId;const m=await membership(teamId,p.userId);if(!m||!['Owner','Coach'].includes(m.role))return response(403,{error:'Geen schrijfrechten'});
    sets=table('VTMSets');await ensure(sets);
    const all=(await getAll(sets,`PartitionKey eq '${teamId}' and matchId eq '${matchId}'`)).sort((a,b)=>Number(a.setNumber)-Number(b.setNumber));
    const active=all.find(x=>!x.completed);if(active)return response(409,{error:'Er bestaat al een actieve set'});
    const wonTeam=all.filter(x=>x.winner==='team').length,wonOpponent=all.filter(x=>x.winner==='opponent').length;
    if(wonTeam>=3||wonOpponent>=3)return response(409,{error:'De wedstrijd is al beslist'});
    const n=all.length+1;if(n>5)return response(409,{error:'Maximaal vijf sets toegestaan'});
    setId=setKey(matchId,n);
    if(!await exists(sets,teamId,setId)){
      await sets.createEntity({partitionKey:teamId,rowKey:setId,setId,matchId,setNumber:n,teamScore:0,opponentScore:0,winner:'',completed:false,createdAt:new Date().toISOString()});
      createdSet=true;
    }
    if(previous&&previous.players){
      const lineups=table('VTMLineups');await ensure(lineups);
      const entity={partitionKey:teamId,rowKey:setId,lineupId:setId,matchId,setNumber:n,startRole:clean(previous.startRole,20)||'setter',initialServer:['team','opponent'].includes(previous.initialServer)?previous.initialServer:'team',serving:['team','opponent'].includes(previous.initialServer)?previous.initialServer:'team',rotation:Number(previous.rotation)||1,copiedFromSet:n-1,updatedAt:new Date().toISOString(),updatedBy:p.userId};
      for(const role of roles){const pl=previous.players[role]||{};entity[`${role}Id`]=clean(pl.playerId,100);entity[`${role}Name`]=clean(pl.name);entity[`${role}Number`]=clean(pl.number,10)}
      await lineups.upsertEntity(entity,'Replace');
    }
    return response(200,{ok:true,setNumber:n,copied:Boolean(previous)});
  }catch(e){
    if(createdSet&&sets&&setId){try{await sets.deleteEntity(rollbackTeamId,setId)}catch{}}
    console.error('next set safe failed',e);
    return response(500,{error:`Volgende set starten mislukt: ${e.message||'onbekende fout'}`,code:e.code||'',statusCode:e.statusCode||500});
  }
}});
