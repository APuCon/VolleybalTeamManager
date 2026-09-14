# Azure-configuratie

1. Maak een nieuwe Azure Static Web App op Standard.
2. Koppel repository `APuCon/VolleybalTeamManager`, branch `main`.
3. Stel build in op `/`, `api`, `dist`.
4. Voeg de vier environment variables uit README toe.
5. Voeg de callback van zowel de azurestaticapps.net-host als het custom domein toe aan de External ID app registration.
6. Controleer dat de custom authentication-config uit `staticwebapp.config.json` wordt gepubliceerd.
7. Test `/.auth/me`, daarna team aanmaken, speler en wedstrijd toevoegen.
