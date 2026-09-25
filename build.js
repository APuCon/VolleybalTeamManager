const fs = require('fs');
const path = require('path');

const dist = 'dist';
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const liveUi = `
    async function openLiveMatch(matchId, status) {
      liveMatchId = matchId;
      try {
        liveData = await api('phase2/status?teamId=' + encodeURIComponent(selected.teamId) + '&matchId=' + encodeURIComponent(matchId));
        renderLive();
      } catch (e) {
        alert(e.message || 'Wedstrijd kan niet worden geopend.');
      }
    }

    function renderLive() {
      const p = document.getElementById('matches');
      if (!p || !liveData) return;
      const match = liveData.match || {};
      const currentSet = liveData.currentSet;
      p.innerHTML = \`
        <div class="row">
          <h3>Live wedstrijd: \${esc(match.opponent || '')}</h3>
          <button class="btn btn2" onclick="matches(document.getElementById('matches'))">Terug</button>
        </div>
        <div class="card">
          <div class="row">
            <span class="pill">Status: \${esc(match.status || 'Planned')}</span>
            <span class="pill">Sets \${Number(liveData.teamSets || 0)} - \${Number(liveData.opponentSets || 0)}</span>
          </div>
          \${currentSet ? \`
            <h3>Set \${currentSet.setNumber}</h3>
            <div class="grid2">
              <button class="btn" onclick="phase2Action('phase2/point',{winner:'team'})">Ons punt (\${Number(currentSet.teamScore || 0)})</button>
              <button class="btn btn2" onclick="phase2Action('phase2/point',{winner:'opponent'})">Tegenstander punt (\${Number(currentSet.opponentScore || 0)})</button>
            </div>
            <div class="row-actions" style="margin-top:12px">
              <button class="btn btn2" onclick="phase2Action('phase2/undo')">Punt terugdraaien</button>
              <button class="btn btn2" onclick="phase2Action('phase2/next-set')">Volgende set</button>
              <button class="btn danger" onclick="phase2Action('phase2/finish')">Wedstrijd beëindigen</button>
            </div>
          \` : '<p class="muted">Start de wedstrijd om de eerste set te openen.</p>'}\
        </div>
      \`;
    }

    async function phase2Action(path, body = {}) {
      try {
        if (path === 'phase2/point' || path === 'phase2/undo' || path === 'phase2/next-set' || path === 'phase2/finish') {
          body = { ...body, teamId: selected.teamId, matchId: liveMatchId };
        }
        liveData = await api(path, { method: 'POST', body: JSON.stringify(body) });
        renderLive();
      } catch (e) {
        alert(e.message || 'Actie mislukt.');
      }
    }

    // The service worker is registered explicitly; without this call sw.js is never used.
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
`;

for (const file of ['index.html', 'manifest.webmanifest', 'sw.js', 'staticwebapp.config.json']) {
  let source = fs.readFileSync(file, 'utf8');

  if (file === 'index.html') {
    source = source.replace(
      /\n\s*<div id="menuOverlay" class="menu-overlay" onclick="closeMenu\(\)"><\/div>\n\s*<div id="menuDrawer" class="menu-drawer" aria-hidden="true"><\/div>/,
      ''
    );
    source = source.replace(/\n\s*init\(\);\s*\n\s*<\/script>/, `\n${liveUi}\n    init();\n  </script>`);
  }

  fs.writeFileSync(path.join(dist, file), source);
}
