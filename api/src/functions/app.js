'use strict';

const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');
const crypto = require('crypto');

const connectionString = () => process.env.VOLLEYBALL_STORAGE_CONNECTION;
const tableClient = (tableName) =>
  TableClient.fromConnectionString(connectionString(), tableName);

async function ensureTable(client) {
  try {
    await client.createTable();
  } catch (error) {
    if (error.statusCode !== 409) throw error;
  }
}

function getPrincipal(request) {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) return null;

  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function createId() {
  return crypto.randomUUID();
}

function clean(value, maxLength = 150) {
  return String(value || '').trim().slice(0, maxLength);
}

function response(status, body) {
  return { status, jsonBody: body };
}

async function getMembership(teamId, userId) {
  if (!teamId || !userId) return null;

  const client = tableClient('VTMTeamMembers');
  await ensureTable(client);

  try {
    return await client.getEntity(teamId, userId);
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

async function requireMember(teamId, principal, roles) {
  if (!principal) return null;

  const membership = await getMembership(teamId, principal.userId);
  return membership && (!roles || roles.includes(membership.role))
    ? membership
    : null;
}

app.http('teams', {
  methods: ['GET', 'POST', 'PUT'],
  authLevel: 'anonymous',
  route: 'teams/{teamId?}',
  handler: async (request) => {
    const principal = getPrincipal(request);
    if (!principal) return response(401, { error: 'Niet ingelogd' });

    const teams = tableClient('VTMTeams');
    const members = tableClient('VTMTeamMembers');
    await ensureTable(teams);
    await ensureTable(members);

    const teamId = request.params.teamId;

    if (request.method === 'POST') {
      const body = await request.json();
      const teamName = clean(body.teamName);
      const season = clean(body.season, 30);

      if (!teamName) {
        return response(400, { error: 'Teamnaam is verplicht.' });
      }

      const newTeamId = createId();
      const now = new Date().toISOString();

      await teams.createEntity({
        partitionKey: 'team',
        rowKey: newTeamId,
        teamId: newTeamId,
        teamName,
        season,
        createdBy: principal.userId,
        createdAt: now,
        status: 'Active'
      });

      await members.createEntity({
        partitionKey: newTeamId,
        rowKey: principal.userId,
        email: principal.userDetails || '',
        role: 'Owner',
        joinedAt: now
      });

      return response(201, { teamId: newTeamId });
    }

    if (request.method === 'PUT') {
      if (!teamId) return response(400, { error: 'TeamId ontbreekt.' });

      const membership = await requireMember(teamId, principal, ['Owner']);
      if (!membership) {
        return response(403, {
          error: 'Alleen de eigenaar mag het team wijzigen.'
        });
      }

      const body = await request.json();
      const teamName = clean(body.teamName);
      const season = clean(body.season, 30);

      if (!teamName) {
        return response(400, { error: 'Teamnaam is verplicht.' });
      }

      const existing = await teams.getEntity('team', teamId);
      existing.teamName = teamName;
      existing.season = season;
      existing.updatedAt = new Date().toISOString();
      existing.updatedBy = principal.userId;

      await teams.updateEntity(existing, 'Replace');

      return response(200, {
        teamId,
        teamName: existing.teamName,
        season: existing.season,
        role: membership.role
      });
    }

    if (teamId) {
      const membership = await requireMember(teamId, principal);
      if (!membership) return response(403, { error: 'Geen toegang' });

      const team = await teams.getEntity('team', teamId);
      return response(200, {
        teamId,
        teamName: team.teamName,
        season: team.season,
        role: membership.role
      });
    }

    const result = [];
    for await (const membership of members.listEntities({
      queryOptions: { filter: `RowKey eq '${principal.userId}'` }
    })) {
      try {
        const team = await teams.getEntity('team', membership.partitionKey);
        result.push({
          teamId: team.teamId,
          teamName: team.teamName,
          season: team.season,
          role: membership.role
        });
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    }

    return response(200, result);
  }
});

app.http('players', {
  methods: ['GET', 'POST', 'PUT'],
  authLevel: 'anonymous',
  route: 'players/{playerId?}',
  handler: async (request) => {
    const principal = getPrincipal(request);
    if (!principal) return response(401, { error: 'Niet ingelogd' });

    const players = tableClient('VTMPlayers');
    await ensureTable(players);

    const playerId = request.params.playerId;

    if (request.method === 'POST') {
      const body = await request.json();
      const membership = await requireMember(body.teamId, principal, [
        'Owner',
        'Coach'
      ]);

      if (!membership) return response(403, { error: 'Geen schrijfrechten' });

      const name = clean(body.name);
      if (!name) return response(400, { error: 'Naam is verplicht.' });

      const newPlayerId = createId();
      await players.createEntity({
        partitionKey: body.teamId,
        rowKey: newPlayerId,
        playerId: newPlayerId,
        name,
        number: clean(body.number, 10),
        role: clean(body.role, 30),
        active: true
      });

      return response(201, { playerId: newPlayerId });
    }

    if (request.method === 'PUT') {
      if (!playerId) return response(400, { error: 'PlayerId ontbreekt.' });

      const body = await request.json();
      const membership = await requireMember(body.teamId, principal, [
        'Owner',
        'Coach'
      ]);

      if (!membership) return response(403, { error: 'Geen schrijfrechten' });

      const name = clean(body.name);
      if (!name) return response(400, { error: 'Naam is verplicht.' });

      const existing = await players.getEntity(body.teamId, playerId);
      existing.name = name;
      existing.number = clean(body.number, 10);
      existing.role = clean(body.role, 30);
      existing.updatedAt = new Date().toISOString();

      await players.updateEntity(existing, 'Replace');
      return response(200, { success: true, playerId });
    }

    const teamId = request.query.get('teamId');
    if (!(await requireMember(teamId, principal))) {
      return response(403, { error: 'Geen toegang' });
    }

    const result = [];
    for await (const player of players.listEntities({
      queryOptions: { filter: `PartitionKey eq '${teamId}'` }
    })) {
      result.push(player);
    }

    return response(200, result);
  }
});

app.http('matches', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'matches',
  handler: async (request) => {
    const principal = getPrincipal(request);
    if (!principal) return response(401, { error: 'Niet ingelogd' });

    const matches = tableClient('VTMMatches');
    await ensureTable(matches);

    if (request.method === 'POST') {
      const body = await request.json();
      const membership = await requireMember(body.teamId, principal, [
        'Owner',
        'Coach'
      ]);

      if (!membership) return response(403, { error: 'Geen schrijfrechten' });

      const opponent = clean(body.opponent);
      if (!opponent) return response(400, { error: 'Tegenstander is verplicht.' });

      const matchId = createId();
      await matches.createEntity({
        partitionKey: body.teamId,
        rowKey: matchId,
        matchId,
        opponent,
        matchDate: clean(body.matchDate, 20),
        location: clean(body.location),
        status: 'Planned',
        createdAt: new Date().toISOString()
      });

      return response(201, { matchId });
    }

    const teamId = request.query.get('teamId');
    if (!(await requireMember(teamId, principal))) {
      return response(403, { error: 'Geen toegang' });
    }

    const result = [];
    for await (const match of matches.listEntities({
      queryOptions: { filter: `PartitionKey eq '${teamId}'` }
    })) {
      result.push(match);
    }

    return response(200, result);
  }
});

app.http('members', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'members',
  handler: async (request) => {
    const principal = getPrincipal(request);
    const teamId = request.query.get('teamId');

    if (!principal || !(await requireMember(teamId, principal))) {
      return response(403, { error: 'Geen toegang' });
    }

    const members = tableClient('VTMTeamMembers');
    await ensureTable(members);

    const result = [];
    for await (const membership of members.listEntities({
      queryOptions: { filter: `PartitionKey eq '${teamId}'` }
    })) {
      result.push(membership);
    }

    return response(200, result);
  }
});

app.http('invitations', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'invitations',
  handler: async (request) => {
    const principal = getPrincipal(request);
    if (!principal) return response(401, { error: 'Niet ingelogd' });

    const body = await request.json();
    const membership = await requireMember(body.teamId, principal, ['Owner']);
    if (!membership) return response(403, { error: 'Alleen eigenaar' });

    const email = clean(body.email).toLowerCase();
    if (!email) return response(400, { error: 'E-mailadres is verplicht.' });

    const invitations = tableClient('VTMInvitations');
    await ensureTable(invitations);

    await invitations.upsertEntity(
      {
        partitionKey: body.teamId,
        rowKey: crypto.createHash('sha256').update(email).digest('hex'),
        email,
        role: ['Coach', 'Viewer'].includes(body.role) ? body.role : 'Viewer',
        createdAt: new Date().toISOString(),
        createdBy: principal.userId
      },
      'Replace'
    );

    return response(201, { ok: true });
  }
});

app.http('dashboard', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'dashboard',
  handler: async (request) => {
    const principal = getPrincipal(request);
    const teamId = request.query.get('teamId');

    if (!principal || !(await requireMember(teamId, principal))) {
      return response(403, { error: 'Geen toegang' });
    }

    async function count(tableName) {
      const client = tableClient(tableName);
      await ensureTable(client);

      let total = 0;
      for await (const entity of client.listEntities({
        queryOptions: { filter: `PartitionKey eq '${teamId}'` }
      })) {
        void entity;
        total += 1;
      }
      return total;
    }

    return response(200, {
      players: await count('VTMPlayers'),
      matches: await count('VTMMatches'),
      sets: await count('VTMSets')
    });
  }
});

app.http('report', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'report',
  handler: async (request) => {
    const principal = getPrincipal(request);
    const teamId = request.query.get('teamId');

    if (!principal || !(await requireMember(teamId, principal))) {
      return response(403, { error: 'Geen toegang' });
    }

    const result = {
      teamId,
      generatedAt: new Date().toISOString(),
      players: [],
      matches: [],
      sets: [],
      attendance: [],
      substitutions: []
    };

    const tables = {
      players: 'VTMPlayers',
      matches: 'VTMMatches',
      sets: 'VTMSets',
      attendance: 'VTMAttendance',
      substitutions: 'VTMSubstitutions'
    };

    for (const [key, tableName] of Object.entries(tables)) {
      const client = tableClient(tableName);
      await ensureTable(client);

      for await (const entity of client.listEntities({
        queryOptions: { filter: `PartitionKey eq '${teamId}'` }
      })) {
        result[key].push(entity);
      }
    }

    return response(200, result);
  }
});

// Fase 1: live wedstrijdregistratie
const liveSetKey=(matchId,n)=>`${matchId}_${String(n).padStart(2,'0')}`;
const isSetWon=(a,b,n)=>(a>=(n===5?15:25)||b>=(n===5?15:25))&&Math.abs(a-b)>=2;
async function liveAccess(teamId,matchId,p,roles){let m=await requireMember(teamId,p,roles);if(!m)return{error:response(403,{error:'Geen toegang'})};let c=tableClient('VTMMatches');await ensureTable(c);try{return{matches:c,match:await c.getEntity(teamId,matchId)}}catch(e){if(e.statusCode===404)return{error:response(404,{error:'Wedstrijd niet gevonden'})};throw e}}
async function liveSets(teamId,matchId){let c=tableClient('VTMSets');await ensureTable(c);let a=[];for await(const x of c.listEntities({queryOptions:{filter:`PartitionKey eq '${teamId}' and matchId eq '${matchId}'`}}))a.push(x);a.sort((x,y)=>Number(x.setNumber)-Number(y.setNumber));return{client:c,items:a}}
async function livePoints(matchId,setNumber){let c=tableClient('VTMPoints');await ensureTable(c);let a=[];for await(const x of c.listEntities({queryOptions:{filter:`PartitionKey eq '${matchId}' and setNumber eq ${Number(setNumber)}`}}))a.push(x);a.sort((x,y)=>String(x.createdAt).localeCompare(String(y.createdAt)));return{client:c,items:a}}
async function liveStatus(teamId,matchId,includePoints=true){let mc=tableClient('VTMMatches');await ensureTable(mc);let m=await mc.getEntity(teamId,matchId),sd=await liveSets(teamId,matchId),teamSets=sd.items.filter(x=>x.winner==='team').length,opponentSets=sd.items.filter(x=>x.winner==='opponent').length,current=sd.items.find(x=>!x.completed)||sd.items.at(-1)||null,pts=includePoints&&current?(await livePoints(matchId,current.setNumber)).items:[];return{match:{matchId:m.matchId,teamId:m.partitionKey,opponent:m.opponent,matchDate:m.matchDate,location:m.location,status:m.status,startedAt:m.startedAt||'',completedAt:m.completedAt||''},teamSets,opponentSets,currentSet:current?{setId:current.setId,setNumber:Number(current.setNumber),teamScore:Number(current.teamScore||0),opponentScore:Number(current.opponentScore||0),winner:current.winner||'',completed:Boolean(current.completed)}:null,sets:sd.items.map(x=>({setId:x.setId,setNumber:Number(x.setNumber),teamScore:Number(x.teamScore||0),opponentScore:Number(x.opponentScore||0),winner:x.winner||'',completed:Boolean(x.completed)})),points:pts.map(x=>({pointId:x.pointId,setNumber:Number(x.setNumber),winner:x.winner,teamScore:Number(x.teamScore),opponentScore:Number(x.opponentScore),createdAt:x.createdAt}))}}
function liveRoute(name,route,methods,handler){app.http(name,{methods,authLevel:'anonymous',route,handler})}
liveRoute('liveStart','live/start',['POST'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let b=await req.json(),a=await liveAccess(b.teamId,b.matchId,p,['Owner','Coach']);if(a.error)return a.error;let sd=await liveSets(b.teamId,b.matchId);if(!sd.items.length){let k=liveSetKey(b.matchId,1);await sd.client.createEntity({partitionKey:b.teamId,rowKey:k,setId:k,matchId:b.matchId,setNumber:1,teamScore:0,opponentScore:0,winner:'',completed:false,createdAt:new Date().toISOString()})}a.match.status='Live';a.match.startedAt=a.match.startedAt||new Date().toISOString();a.match.updatedAt=new Date().toISOString();await a.matches.updateEntity(a.match,'Replace');return response(200,await liveStatus(b.teamId,b.matchId))});
liveRoute('liveStatus','live/status',['GET'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let teamId=req.query.get('teamId'),matchId=req.query.get('matchId'),a=await liveAccess(teamId,matchId,p);if(a.error)return a.error;return response(200,await liveStatus(teamId,matchId))});
liveRoute('livePoint','live/point',['POST'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let b=await req.json();if(!['team','opponent'].includes(b.winner))return response(400,{error:'Ongeldige winnaar'});let a=await liveAccess(b.teamId,b.matchId,p,['Owner','Coach']);if(a.error)return a.error;if(a.match.status!=='Live')return response(409,{error:'Deze wedstrijd is niet actief'});let sd=await liveSets(b.teamId,b.matchId),s=sd.items.find(x=>!x.completed);if(!s)return response(409,{error:'Start eerst de volgende set'});s.teamScore=Number(s.teamScore||0)+(b.winner==='team'?1:0);s.opponentScore=Number(s.opponentScore||0)+(b.winner==='opponent'?1:0);if(isSetWon(s.teamScore,s.opponentScore,Number(s.setNumber))){s.completed=true;s.winner=s.teamScore>s.opponentScore?'team':'opponent';s.completedAt=new Date().toISOString()}s.updatedAt=new Date().toISOString();await sd.client.updateEntity(s,'Replace');let pc=tableClient('VTMPoints');await ensureTable(pc);let k=`${Date.now()}_${createId()}`;await pc.createEntity({partitionKey:b.matchId,rowKey:k,pointId:k,teamId:b.teamId,matchId:b.matchId,setNumber:Number(s.setNumber),winner:b.winner,teamScore:s.teamScore,opponentScore:s.opponentScore,createdAt:new Date().toISOString(),createdBy:p.userId});return response(200,await liveStatus(b.teamId,b.matchId))});
liveRoute('liveUndo','live/undo',['POST'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let b=await req.json(),a=await liveAccess(b.teamId,b.matchId,p,['Owner','Coach']);if(a.error)return a.error;let sd=await liveSets(b.teamId,b.matchId),s=[...sd.items].reverse().find(x=>Number(x.teamScore||0)+Number(x.opponentScore||0)>0);if(!s)return response(409,{error:'Geen punt om terug te draaien'});let pd=await livePoints(b.matchId,s.setNumber),last=pd.items.at(-1);if(!last)return response(409,{error:'Geen punt om terug te draaien'});await pd.client.deleteEntity(b.matchId,last.rowKey);s.teamScore=Math.max(0,Number(s.teamScore||0)-(last.winner==='team'?1:0));s.opponentScore=Math.max(0,Number(s.opponentScore||0)-(last.winner==='opponent'?1:0));s.completed=false;s.winner='';s.completedAt='';s.updatedAt=new Date().toISOString();await sd.client.updateEntity(s,'Replace');return response(200,await liveStatus(b.teamId,b.matchId))});
liveRoute('liveNextSet','live/next-set',['POST'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let b=await req.json(),a=await liveAccess(b.teamId,b.matchId,p,['Owner','Coach']);if(a.error)return a.error;let st=await liveStatus(b.teamId,b.matchId,false);if(st.currentSet&&!st.currentSet.completed)return response(409,{error:'De huidige set is nog niet afgelopen'});if(st.teamSets>=3||st.opponentSets>=3)return response(409,{error:'De wedstrijd is al beslist'});let n=st.sets.length+1;if(n>5)return response(409,{error:'Maximaal vijf sets toegestaan'});let c=tableClient('VTMSets');await ensureTable(c);let k=liveSetKey(b.matchId,n);await c.createEntity({partitionKey:b.teamId,rowKey:k,setId:k,matchId:b.matchId,setNumber:n,teamScore:0,opponentScore:0,winner:'',completed:false,createdAt:new Date().toISOString()});return response(200,await liveStatus(b.teamId,b.matchId))});
liveRoute('liveFinish','live/finish',['POST'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let b=await req.json(),a=await liveAccess(b.teamId,b.matchId,p,['Owner','Coach']);if(a.error)return a.error;let st=await liveStatus(b.teamId,b.matchId,false);if(st.teamSets<3&&st.opponentSets<3)return response(409,{error:'De wedstrijd is nog niet beslist'});a.match.status='Completed';a.match.completedAt=new Date().toISOString();a.match.teamSets=st.teamSets;a.match.opponentSets=st.opponentSets;a.match.winner=st.teamSets>st.opponentSets?'team':'opponent';a.match.updatedAt=new Date().toISOString();await a.matches.updateEntity(a.match,'Replace');return response(200,await liveStatus(b.teamId,b.matchId))});
