# VolleybalTeamManager

GitHub/Azure-ready basis voor multi-user teambeheer.

## Inbegrepen
- Microsoft Entra External ID-login via Azure Static Web Apps
- meerdere teams per gebruiker
- rollen Owner, Coach en Viewer
- uitnodigingen op e-mailadres
- centrale spelerslijst
- wedstrijdplanning
- dashboard
- JSON-export voor Power BI
- Azure Functions en Azure Table Storage

## Vereisten in Azure
De Static Web App moet het Standard-plan gebruiken voor custom authentication. Voeg onder Environment variables toe:
- `EXTERNAL_ID_CLIENT_ID`
- `EXTERNAL_ID_CLIENT_SECRET`
- `EXTERNAL_ID_TENANT_ID` (documentatie/administratie; huidige config bevat tenant-id in issuer)
- `VOLLEYBALL_STORAGE_CONNECTION`

De ZIP bevat geen secrets.

## External ID configuratie
De config gebruikt tenant-id `20e82054-dfe1-4be5-ae23-c752fe1aba90` en environment-variable-namen voor client-id en secret. Registreer voor iedere productiehost de callback:
`https://<host>/.auth/login/aad/callback`

## GitHub
1. Pak de ZIP uit.
2. Upload de inhoud van map `VolleybalTeamManager` naar de root van de GitHub-repository.
3. Maak in GitHub een repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN` met het deployment token van de nieuwe Static Web App.
4. Commit naar `main`.

## Buildinstellingen
- app_location: `/`
- api_location: `api`
- output_location: `dist`

## Lokaal bouwen
`npm run build`

## Datatabellen
De API maakt bij eerste gebruik tabellen met prefix `VTM` aan: Teams, TeamMembers, Invitations, Players, Matches, Sets, Attendance en Substitutions.

## Functionele grens van deze versie
Deze importeerbare versie bevat de platformbasis, teambeheer, spelers, wedstrijdplanning, dashboard en Power BI-export. De live score/rotatie-engine uit de oudere tracker is nog niet in deze nieuwe teamarchitectuur geïntegreerd. Dit is bewust vermeld om geen functionaliteit te claimen die niet in deze ZIP zit.
