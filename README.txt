VOLLEYBALTEAM MANAGER - DELETE FIX

Oorzaak:
1. In api/src/app.js stond require('./deletions') uitgeschakeld.
2. Daardoor werd admin/remove/member helemaal niet geregistreerd en gaf deze route 404.
3. app.js bevatte daarnaast oudere, onvolledige delete-routes voor speler, wedstrijd en team.
4. Alleen deletions.js bevat de complete cascade-verwijdering.
5. De API package verwees naar src/index.js terwijl het startbestand app.js heet.

Plaats deze bestanden in GitHub:
- api/src/app.js
- api/src/deletions.js
- api/package.json

Vervang de bestaande bestanden volledig. Commit/push naar main en wacht tot de GitHub Action groen is.
Test daarna verwijderen van: speler, teamlid/coach, wedstrijd en team.
