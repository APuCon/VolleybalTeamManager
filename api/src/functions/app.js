'use strict';

const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');
require('./attendance');
require('./substitutions');
require('./deletions-v2');
require('./next-set-safe');
async function deleteEntitySafe(client, pk, rk) {
  try {
    await client.deleteEntity(pk, rk);
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
}

async function deleteByFilter(tableName, filter) {
  const client = tableClient(tableName);
  await ensureTable(client);

  const rows = [];

  for await (const row of client.listEntities({
    queryOptions: { filter }
  })) {
    rows.push([row.partitionKey, row.rowKey]);
  }

  for (const [pk, rk] of rows) {
    await deleteEntitySafe(client, pk, rk);
  }

  return rows.length;
}

async function deleteMatchCascade(teamId, matchId) {
  await deleteByFilter(
    'VTMPoints',
    `PartitionKey eq '${matchId}'`
  );

  await deleteByFilter(
    'VTMRotations',
    `PartitionKey eq '${matchId}'`
  );

  await deleteByFilter(
    'VTMSubstitutions',
    `PartitionKey eq '${matchId}'`
  );

  await deleteByFilter(
    'VTMAttendance',
    `teamId eq '${teamId}' and matchId eq '${matchId}'`
  );

  const matches = tableClient('VTMMatches');
  await ensureTable(matches);

  await deleteEntitySafe(matches, teamId, matchId);
}
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
      const matchType = ['Competition', 'Cup'].includes(body.matchType) ? body.matchType : 'Competition';
      if (!opponent) return response(400, { error: 'Tegenstander is verplicht.' });

      const matchId = createId();
      await matches.createEntity({
        partitionKey: body.teamId,
        rowKey: matchId,
        matchId,
        opponent,
        matchDate: clean(body.matchDate, 20),
        location: clean(body.location),
        matchType,
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
      result.push({memberId:membership.rowKey,email:membership.email||'',role:membership.role||'Viewer',joinedAt:membership.joinedAt||''});
    }

    return response(200, result);
  }
});

app.http('invitations', {
  methods: ['GET', 'POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'invitations',
  handler: async (request) => {
    const principal = getPrincipal(request);
    if (!principal) return response(401, { error: 'Niet ingelogd' });

    const teamId = request.query.get('teamId');
    const isGet = request.method === 'GET';
    const isDelete = request.method === 'DELETE';

    if (isGet) {
      if (!teamId) return response(400, { error: 'TeamId ontbreekt.' });
      const membership = await requireMember(teamId, principal, ['Owner']);
      if (!membership) return response(403, { error: 'Alleen eigenaar' });

      const invitations = tableClient('VTMInvitations');
      await ensureTable(invitations);

      const result = [];
      for await (const invitation of invitations.listEntities({
        queryOptions: { filter: `PartitionKey eq '${teamId}'` }
      })) {
        result.push({
          email: invitation.email || '',
          role: invitation.role || 'Viewer',
          createdAt: invitation.createdAt || '',
          createdBy: invitation.createdBy || ''
        });
      }

      return response(200, result);
    }

    if (isDelete) {
      const body = await request.json().catch(() => ({}));
      const deleteTeamId = body.teamId || teamId;
      const email = clean(body.email || '', 150).toLowerCase();
      if (!deleteTeamId || !email) return response(400, { error: 'TeamId en e-mailadres zijn verplicht.' });

      const membership = await requireMember(deleteTeamId, principal, ['Owner']);
      if (!membership) return response(403, { error: 'Alleen eigenaar' });

      const invitations = tableClient('VTMInvitations');
      await ensureTable(invitations);
      const rowKey = crypto.createHash('sha256').update(email).digest('hex');

      try {
        await invitations.deleteEntity(deleteTeamId, rowKey);
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }

      return response(200, { ok: true });
    }

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
async function liveAccess(teamId,matchId,p,roles){let m=await requireMember(teamId,p,roles);if(!m)return{error:response(403,{error:'Geen toegang'})};let c=tableClient('VTMMatches');await ensureTable(c);let match=await c.getEntity(teamId,matchId).catch(()=>null);return{match};}
async function liveSets(teamId,matchId){let c=tableClient('VTMSets');await ensureTable(c);let a=[];for await(const x of c.listEntities({queryOptions:{filter:`PartitionKey eq '${teamId}' and matchId eq '${matchId}'`}}))a.push(x);return {items:a,client:c};}
async function livePoints(matchId,setNumber){let c=tableClient('VTMPoints');await ensureTable(c);let a=[];for await(const x of c.listEntities({queryOptions:{filter:`PartitionKey eq '${matchId}' and setNumber eq ${setNumber}`}}))a.push(x);return {items:a,client:c};}
async function liveStatus(teamId,matchId,includePoints=true){let mc=tableClient('VTMMatches');await ensureTable(mc);let m=await mc.getEntity(teamId,matchId),sd=await liveSets(teamId,matchId),teamSets=Number(m.teamSets||0),opponentSets=Number(m.opponentSets||0),sets=sd.items.sort((a,b)=>Number(a.setNumber)-Number(b.setNumber));let currentSet=sets.find(x=>!x.completed)||null;let result={match:m,sets,teamSets,opponentSets,currentSet};if(includePoints&&currentSet){let points=await livePoints(matchId,currentSet.setNumber);result.points=points.items.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));}return result;}
function liveRoute(name,route,methods,handler){app.http(name,{methods,authLevel:'anonymous',route,handler})}
liveRoute('liveStart','live/start',['POST'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let b=await req.json(),a=await liveAccess(b.teamId,b.matchId,p,['Owner','Coach']);if(a.error)return a.error;let c=tableClient('VTMMatches');await ensureTable(c);let m=await c.getEntity(b.teamId,b.matchId);m.status='Live';m.startedAt=m.startedAt||new Date().toISOString();m.updatedAt=new Date().toISOString();await c.updateEntity(m,'Replace');return response(200,await liveStatus(b.teamId,b.matchId));});
liveRoute('liveStatus','live/status',['GET'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let teamId=req.query.get('teamId'),matchId=req.query.get('matchId');if(!teamId||!matchId)return response(400,{error:'TeamId en matchId zijn vereist'});let access=await liveAccess(teamId,matchId,p);if(access.error)return access.error;return response(200,await liveStatus(teamId,matchId));});
liveRoute('livePoint','live/point',['POST'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let b=await req.json();if(!['team','opponent'].includes(b.winner))return response(400,{error:'Ongeldige winnaar.'});let a=await liveAccess(b.teamId,b.matchId,p,['Owner','Coach']);if(a.error)return a.error;let st=await liveStatus(b.teamId,b.matchId,false),currentSet=st.currentSet;if(!currentSet)return response(409,{error:'Start eerst de volgende set.'});let c=tableClient('VTMPoints');await ensureTable(c);let pointId=`${Date.now()}_${createId()}`;currentSet.teamScore=Number(currentSet.teamScore||0)+(b.winner==='team'?1:0);currentSet.opponentScore=Number(currentSet.opponentScore||0)+(b.winner==='opponent'?1:0);if(isSetWon(currentSet.teamScore,currentSet.opponentScore,Number(currentSet.setNumber))){currentSet.completed=true;currentSet.winner=currentSet.teamScore>currentSet.opponentScore?'team':'opponent';currentSet.completedAt=new Date().toISOString();}currentSet.updatedAt=new Date().toISOString();let sets=tableClient('VTMSets');await ensureTable(sets);await sets.updateEntity(currentSet,'Replace');await c.createEntity({partitionKey:b.matchId,rowKey:pointId,pointId,teamId:b.teamId,matchId:b.matchId,setNumber:Number(currentSet.setNumber),winner:b.winner,teamScore:currentSet.teamScore,opponentScore:currentSet.opponentScore,createdAt:new Date().toISOString(),createdBy:p.userId});return response(200,await liveStatus(b.teamId,b.matchId));});
liveRoute('liveUndo','live/undo',['POST'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let b=await req.json();let a=await liveAccess(b.teamId,b.matchId,p,['Owner','Coach']);if(a.error)return a.error;let st=await liveStatus(b.teamId,b.matchId,false),currentSet=[...st.sets].reverse().find(x=>Number(x.teamScore||0)+Number(x.opponentScore||0)>0);if(!currentSet)return response(409,{error:'Geen punt om terug te draaien.'});let points=await livePoints(b.matchId,currentSet.setNumber);let lastPoint=points.items.at(-1);if(!lastPoint)return response(409,{error:'Geen punt om terug te draaien.'});await points.client.deleteEntity(b.matchId,lastPoint.rowKey);currentSet.teamScore=Math.max(0,Number(currentSet.teamScore||0)-(lastPoint.winner==='team'?1:0));currentSet.opponentScore=Math.max(0,Number(currentSet.opponentScore||0)-(lastPoint.winner==='opponent'?1:0));currentSet.completed=false;currentSet.winner='';currentSet.completedAt='';currentSet.updatedAt=new Date().toISOString();let sets=tableClient('VTMSets');await ensureTable(sets);await sets.updateEntity(currentSet,'Replace');return response(200,await liveStatus(b.teamId,b.matchId));});
liveRoute('liveNextSet','live/next-set',['POST'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let b=await req.json(),a=await liveAccess(b.teamId,b.matchId,p,['Owner','Coach']);if(a.error)return a.error;let st=await liveStatus(b.teamId,b.matchId,false);if(st.currentSet&&!st.currentSet.completed)return response(409,{error:'De huidige set is nog niet afgelopen'});let n=st.sets.length+1;let sets=tableClient('VTMSets');await ensureTable(sets);let setId=liveSetKey(b.matchId,n);await sets.createEntity({partitionKey:b.teamId,rowKey:setId,setId,matchId:b.matchId,setNumber:n,teamScore:0,opponentScore:0,winner:'',completed:false,createdAt:new Date().toISOString()});return response(200,await liveStatus(b.teamId,b.matchId));});
liveRoute('liveFinish','live/finish',['POST'],async req=>{let p=getPrincipal(req);if(!p)return response(401,{error:'Niet ingelogd'});let b=await req.json(),a=await liveAccess(b.teamId,b.matchId,p,['Owner','Coach']);if(a.error)return a.error;let st=await liveStatus(b.teamId,b.matchId,false),m=a.match;m.status='Completed';m.completedAt=new Date().toISOString();m.updatedAt=new Date().toISOString();let matches=tableClient('VTMMatches');await ensureTable(matches);await matches.updateEntity(m,'Replace');return response(200,await liveStatus(b.teamId,b.matchId));});

function requiredSetsForMatch(type,teamSets,opponentSets,completed){
  if(type==='Cup')return 3;
  if(completed<4)return 4;
  return teamSets===2&&opponentSets===2?5:4;
}

const LINEUP_ROLES = ['setter', 'buiten1', 'midden1', 'dia', 'buiten2', 'midden2'];
const LINEUP_SEQUENCE = ['setter', 'buiten1', 'midden1', 'dia', 'buiten2', 'midden2'];
const lineupKey = (matchId, setNumber) => `${matchId}_${String(setNumber).padStart(2, '0')}`;

async function getLineup(teamId, matchId, setNumber) {
  const client = tableClient('VTMLineups');
  await ensureTable(client);
  try {
    return { client, item: await client.getEntity(teamId, lineupKey(matchId, setNumber)) };
  } catch (error) {
    if (error.statusCode === 404) return { client, item: null };
    throw error;
  }
}

function publicLineup(entity) {
  if (!entity) return null;
  const players = {};
  for (const role of LINEUP_ROLES) {
    players[role] = {
      playerId: entity[`${role}Id`] || '',
      name: entity[`${role}Name`] || '',
      number: entity[`${role}Number`] || ''
    };
  }
  return {
    lineupId: entity.lineupId,
    matchId: entity.matchId,
    setNumber: Number(entity.setNumber),
    players,
    startRole: entity.startRole,
    initialServer: entity.initialServer,
    serving: entity.serving,
    rotation: Number(entity.rotation || 1),
    updatedAt: entity.updatedAt || ''
  };
}

async function phase2Status(teamId, matchId) {
  const status = await liveStatus(teamId, matchId);
  const lineupData = status.currentSet
    ? await getLineup(teamId, matchId, status.currentSet.setNumber)
    : { item: null };
  status.lineup = publicLineup(lineupData.item);
  return status;
}

async function saveRotationLog(data, principal) {
  const client = tableClient('VTMRotations');
  await ensureTable(client);
  const rotationId = `${Date.now()}_${createId()}`;
  await client.createEntity({
    partitionKey: data.matchId,
    rowKey: rotationId,
    rotationId,
    teamId: data.teamId,
    matchId: data.matchId,
    setNumber: Number(data.setNumber),
    pointId: data.pointId,
    beforeServing: data.beforeServing,
    afterServing: data.afterServing,
    beforeRotation: Number(data.beforeRotation),
    afterRotation: Number(data.afterRotation),
    reason: data.reason,
    createdAt: new Date().toISOString(),
    createdBy: principal.userId
  });
  return rotationId;
}

liveRoute('lineupGet', 'lineup', ['GET'], async (request) => {
  const principal = getPrincipal(request);
  if (!principal) return response(401, { error: 'Niet ingelogd' });
  const teamId = request.query.get('teamId');
  const matchId = request.query.get('matchId');
  const setNumber = Number(request.query.get('setNumber'));
  const access = await liveAccess(teamId, matchId, principal);
  if (access.error) return access.error;
  const data = await getLineup(teamId, matchId, setNumber);
  return response(200, { lineup: publicLineup(data.item) });
});

liveRoute('lineupSave', 'lineup/save', ['POST'], async (request) => {
  try {
    const principal = getPrincipal(request);
    if (!principal) return response(401, { error: 'Niet ingelogd' });

    const body = await request.json();
    const teamId = clean(body.teamId, 100);
    const matchId = clean(body.matchId, 100);
    const setNumber = Number(body.setNumber);
    const startRole = clean(body.startRole, 20);
    const initialServer = clean(body.initialServer, 20);

    if (!teamId || !matchId) return response(400, { error: 'TeamId of matchId ontbreekt.' });
    if (!Number.isInteger(setNumber) || setNumber < 1 || setNumber > 5) {
      return response(400, { error: 'Ongeldig setnummer.' });
    }
    if (!LINEUP_ROLES.includes(startRole)) return response(400, { error: 'Ongeldige startrol.' });
    if (!['team', 'opponent'].includes(initialServer)) {
      return response(400, { error: 'Ongeldige eerste serveerder.' });
    }

    const access = await liveAccess(teamId, matchId, principal, ['Owner', 'Coach']);
    if (access.error) return access.error;

    const selectedIds = {};
    for (const role of LINEUP_ROLES) {
      selectedIds[role] = clean(body.players?.[role]?.playerId, 100);
      if (!selectedIds[role]) return response(400, { error: `Selecteer een speler voor ${role}.` });
    }
    if (new Set(Object.values(selectedIds)).size !== 6) {
      return response(400, { error: 'Selecteer zes verschillende spelers.' });
    }

    const playersClient = tableClient('VTMPlayers');
    await ensureTable(playersClient);
    const playersById = new Map();
    for await (const player of playersClient.listEntities({
      queryOptions: { filter: `PartitionKey eq '${teamId}'` }
    })) {
      const playerId = clean(player.playerId || player.rowKey, 100);
      if (playerId) playersById.set(playerId, player);
    }

    const entity = {
      partitionKey: teamId,
      rowKey: lineupKey(matchId, setNumber),
      lineupId: lineupKey(matchId, setNumber),
      matchId,
      setNumber,
      startRole,
      initialServer,
      serving: initialServer,
      rotation: LINEUP_SEQUENCE.indexOf(startRole) + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: clean(principal.userId, 100)
    };

    for (const role of LINEUP_ROLES) {
      const playerId = selectedIds[role];
      const player = playersById.get(playerId);
      if (!player) {
        return response(400, { error: `De geselecteerde speler voor ${role} bestaat niet meer in dit team.` });
      }
      entity[`${role}Id`] = playerId;
      entity[`${role}Name`] = clean(player.name, 150);
      entity[`${role}Number`] = clean(player.number, 10);
    }

    const lineupsClient = tableClient('VTMLineups');
    await ensureTable(lineupsClient);
    await lineupsClient.upsertEntity(entity, 'Merge');
    return response(200, await phase2Status(teamId, matchId));
  } catch (error) {
    console.error('lineup/save failed', error);
    return response(500, {
      error: `Opstelling opslaan mislukt: ${error.message || 'onbekende fout'}`,
      code: error.code || '',
      statusCode: error.statusCode || 500
    });
  }
});

liveRoute('phase2Status', 'phase2/status', ['GET'], async (request) => {
  const principal = getPrincipal(request);
  if (!principal) return response(401, { error: 'Niet ingelogd' });
  const teamId = request.query.get('teamId');
  const matchId = request.query.get('matchId');
  const access = await liveAccess(teamId, matchId, principal);
  if (access.error) return access.error;
  return response(200, await phase2Status(teamId, matchId));
});

liveRoute('phase2Point', 'phase2/point', ['POST'], async (request) => {
  const principal = getPrincipal(request);
  if (!principal) return response(401, { error: 'Niet ingelogd' });
  const body = await request.json();
  if (!['team', 'opponent'].includes(body.winner)) return response(400, { error: 'Ongeldige winnaar.' });

  const access = await liveAccess(body.teamId, body.matchId, principal, ['Owner', 'Coach']);
  if (access.error) return access.error;
  if (access.match.status !== 'Live') return response(409, { error: 'Deze wedstrijd is niet actief.' });

  const setsData = await liveSets(body.teamId, body.matchId);
  const currentSet = setsData.items.find((set) => !set.completed);
  if (!currentSet) return response(409, { error: 'Start eerst de volgende set.' });

  const lineupData = await getLineup(body.teamId, body.matchId, currentSet.setNumber);
  const lineup = lineupData.item;
  if (!lineup) return response(409, { error: 'Sla eerst de opstelling voor deze set op.' });

  const beforeServing = lineup.serving;
  const beforeRotation = Number(lineup.rotation || 1);
  const serviceChanged = body.winner !== beforeServing;
  const afterServing = serviceChanged ? body.winner : beforeServing;
  let afterRotation = beforeRotation;
  if (serviceChanged && body.winner === 'team') afterRotation = (beforeRotation % 6) + 1;

  lineup.serving = afterServing;
  lineup.rotation = afterRotation;
  lineup.updatedAt = new Date().toISOString();
  await lineupData.client.updateEntity(lineup, 'Replace');

  currentSet.teamScore = Number(currentSet.teamScore || 0) + (body.winner === 'team' ? 1 : 0);
  currentSet.opponentScore = Number(currentSet.opponentScore || 0) + (body.winner === 'opponent' ? 1 : 0);
  if (isSetWon(currentSet.teamScore, currentSet.opponentScore, Number(currentSet.setNumber))) {
    currentSet.completed = true;
    currentSet.winner = currentSet.teamScore > currentSet.opponentScore ? 'team' : 'opponent';
    currentSet.completedAt = new Date().toISOString();
  }
  currentSet.updatedAt = new Date().toISOString();
  await setsData.client.updateEntity(currentSet, 'Replace');

  const pointsClient = tableClient('VTMPoints');
  await ensureTable(pointsClient);
  const pointId = `${Date.now()}_${createId()}`;
  let rotationId = '';
  if (serviceChanged) {
    rotationId = await saveRotationLog({
      teamId: body.teamId,
      matchId: body.matchId,
      setNumber: currentSet.setNumber,
      pointId,
      beforeServing,
      afterServing,
      beforeRotation,
      afterRotation,
      reason: body.winner === 'team' ? 'Service overgenomen en doorgedraaid' : 'Service verloren'
    }, principal);
  }

  await pointsClient.createEntity({
    partitionKey: body.matchId,
    rowKey: pointId,
    pointId,
    teamId: body.teamId,
    matchId: body.matchId,
    setNumber: Number(currentSet.setNumber),
    winner: body.winner,
    teamScore: currentSet.teamScore,
    opponentScore: currentSet.opponentScore,
    beforeServing,
    afterServing,
    beforeRotation,
    afterRotation,
    rotationId,
    createdAt: new Date().toISOString(),
    createdBy: principal.userId
  });

  return response(200, await phase2Status(body.teamId, body.matchId));
});

liveRoute('phase2Undo', 'phase2/undo', ['POST'], async (request) => {
  const principal = getPrincipal(request);
  if (!principal) return response(401, { error: 'Niet ingelogd' });
  const body = await request.json();
  const access = await liveAccess(body.teamId, body.matchId, principal, ['Owner', 'Coach']);
  if (access.error) return access.error;

  const setsData = await liveSets(body.teamId, body.matchId);
  const currentSet = [...setsData.items].reverse().find((set) =>
    Number(set.teamScore || 0) + Number(set.opponentScore || 0) > 0
  );
  if (!currentSet) return response(409, { error: 'Geen punt om terug te draaien.' });

  const pointsData = await livePoints(body.matchId, currentSet.setNumber);
  const lastPoint = pointsData.items.at(-1);
  if (!lastPoint) return response(409, { error: 'Geen punt om terug te draaien.' });

  const lineupData = await getLineup(body.teamId, body.matchId, currentSet.setNumber);
  if (lineupData.item) {
    lineupData.item.serving = lastPoint.beforeServing || lineupData.item.serving;
    lineupData.item.rotation = Number(lastPoint.beforeRotation || lineupData.item.rotation);
    lineupData.item.updatedAt = new Date().toISOString();
    await lineupData.client.updateEntity(lineupData.item, 'Replace');
  }

  if (lastPoint.rotationId) {
    const rotationsClient = tableClient('VTMRotations');
    await ensureTable(rotationsClient);
    try {
      await rotationsClient.deleteEntity(body.matchId, lastPoint.rotationId);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
  }

  await pointsData.client.deleteEntity(body.matchId, lastPoint.rowKey);
  currentSet.teamScore = Math.max(0, Number(currentSet.teamScore || 0) - (lastPoint.winner === 'team' ? 1 : 0));
  currentSet.opponentScore = Math.max(0, Number(currentSet.opponentScore || 0) - (lastPoint.winner === 'opponent' ? 1 : 0));
  currentSet.completed = false;
  currentSet.winner = '';
  currentSet.completedAt = '';
  currentSet.updatedAt = new Date().toISOString();
  await setsData.client.updateEntity(currentSet, 'Replace');

  return response(200, await phase2Status(body.teamId, body.matchId));
});

liveRoute('phase2Report', 'report-phase2', ['GET'], async (request) => {
  const principal = getPrincipal(request);
  const teamId = request.query.get('teamId');
  if (!principal || !(await requireMember(teamId, principal))) {
    return response(403, { error: 'Geen toegang' });
  }

  const result = {
    teamId,
    generatedAt: new Date().toISOString(),
    players: [], matches: [], sets: [], points: [], lineups: [], rotations: [],
    attendance: [], substitutions: []
  };
  const teamTables = {
    players: 'VTMPlayers', matches: 'VTMMatches', sets: 'VTMSets',
    lineups: 'VTMLineups', attendance: 'VTMAttendance', substitutions: 'VTMSubstitutions'
  };
  for (const [key, tableName] of Object.entries(teamTables)) {
    const client = tableClient(tableName);
    await ensureTable(client);
    for await (const entity of client.listEntities({
      queryOptions: { filter: `PartitionKey eq '${teamId}'` }
    })) result[key].push(entity);
  }
  for (const [key, tableName] of Object.entries({ points: 'VTMPoints', rotations: 'VTMRotations' })) {
    const client = tableClient(tableName);
    await ensureTable(client);
    for await (const entity of client.listEntities({
      queryOptions: { filter: `teamId eq '${teamId}'` }
    })) result[key].push(entity);
  }
  return response(200, result);
});

