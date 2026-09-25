'use strict';

const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');

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

function clean(value) {
  return String(value || '').trim().toLowerCase();
}

function principalEmails(principal) {
  const values = [principal.userDetails, principal.email, principal.userId];
  for (const claim of principal.claims || []) {
    if (['email', 'emails', 'preferred_username', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'].includes(claim.typ)) {
      values.push(claim.val);
    }
  }
  return new Set(values.map(clean).filter(value => value.includes('@')));
}

function response(status, body, headers) {
  return { status, jsonBody: body, headers };
}

app.http('acceptInvitation', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'invitations/accept',
  handler: async (request) => {
    const principal = getPrincipal(request);
    if (!principal) {
      return response(302, {}, {
        location: '/.auth/login/aad?post_login_redirect_uri=/api/invitations/accept'
      });
    }

    const invitations = tableClient('VTMInvitations');
    const members = tableClient('VTMTeamMembers');
    await ensureTable(invitations);
    await ensureTable(members);

    const emails = principalEmails(principal);
    const accepted = [];

    for await (const invitation of invitations.listEntities()) {
      if (!emails.has(clean(invitation.email))) continue;

      const teamId = invitation.partitionKey;
      const existing = await (async () => {
        try {
          return await members.getEntity(teamId, principal.userId);
        } catch (error) {
          if (error.statusCode === 404) return null;
          throw error;
        }
      })();

      if (!existing) {
        await members.upsertEntity({
          partitionKey: teamId,
          rowKey: principal.userId,
          email: invitation.email,
          role: ['Coach', 'Viewer'].includes(invitation.role) ? invitation.role : 'Viewer',
          joinedAt: new Date().toISOString(),
          joinedViaInvitation: true
        }, 'Replace');
      }

      await invitations.deleteEntity(invitation.partitionKey, invitation.rowKey);
      accepted.push({ teamId, role: invitation.role || 'Viewer' });
    }

    if (request.method === 'GET') {
      return response(302, {}, { location: '/' });
    }

    return response(200, { accepted });
  }
});
