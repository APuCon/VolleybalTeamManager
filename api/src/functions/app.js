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
