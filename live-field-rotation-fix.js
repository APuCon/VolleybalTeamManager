/* VolleybalTeamManager - live veldrotatie frontend fix
   Laad dit bestand NA de bestaande inline applicatiescriptcode. */
(function () {
  'use strict';

  const ROLE_ORDER = ['setter', 'buiten1', 'midden1', 'dia', 'buiten2', 'midden2'];
  const ROLE_NAMES = {
    setter: 'Setter', buiten1: 'Buiten 1', midden1: 'Midden 1',
    dia: 'Diagonaal', buiten2: 'Buiten 2', midden2: 'Midden 2'
  };
  const POSITION_BY_ROTATION = {
    1: { setter:1,buiten1:2,midden1:3,dia:4,buiten2:5,midden2:6 },
    2: { buiten1:1,midden1:2,dia:3,buiten2:4,midden2:5,setter:6 },
    3: { midden1:1,dia:2,buiten2:3,midden2:4,setter:5,buiten1:6 },
    4: { dia:1,buiten2:2,midden2:3,setter:4,buiten1:5,midden1:6 },
    5: { buiten2:1,midden2:2,setter:3,buiten1:4,midden1:5,dia:6 },
    6: { midden2:1,setter:2,buiten1:3,midden1:4,dia:5,buiten2:6 }
  };

  // Coördinaten zijn overgenomen uit de PowerPoint-opstellingen.
  const LAYOUT = {
    team: {
      1:{setter:[81,88],buiten1:[80,26],midden1:[49,26],dia:[17,26],buiten2:[17,88],midden2:[49,88]},
      2:{setter:[49,88],buiten1:[88,88],midden1:[81,26],dia:[49,26],buiten2:[18,26],midden2:[18,88]},
      3:{setter:[18,88],buiten1:[49,88],midden1:[81,88],dia:[81,26],buiten2:[49,26],midden2:[18,26]},
      4:{setter:[20,26],buiten1:[20,77],midden1:[49,77],dia:[76,77],buiten2:[76,26],midden2:[49,26]},
      5:{setter:[49,26],buiten1:[20,26],midden1:[20,77],dia:[49,77],buiten2:[74,77],midden2:[74,26]},
      6:{setter:[76,26],buiten1:[49,26],midden1:[20,26],dia:[20,77],buiten2:[49,77],midden2:[76,77]}
    },
    opponent: {
      1:{setter:[89,88],buiten1:[80,83],midden1:[49,26],dia:[24,40],buiten2:[17,88],midden2:[49,88]},
      2:{setter:[62,26],buiten1:[74,68],midden1:[81,44],dia:[68,15],buiten2:[20,66],midden2:[56,83]},
      3:{setter:[44,37],buiten1:[49,88],midden1:[76,77],dia:[81,26],buiten2:[26,74],midden2:[18,26]},
      4:{setter:[6,9],buiten1:[20,77],midden1:[66,76],dia:[82,88],buiten2:[48,77],midden2:[7,20]},
      5:{setter:[55,28],buiten1:[27,67],midden1:[49,75],dia:[59,89],buiten2:[68,72],midden2:[75,39]},
      6:{setter:[69,11],buiten1:[13,66],midden1:[7,26],dia:[26,89],buiten2:[49,77],midden2:[76,77]}
    }
  };

  function ensureStyles() {
    if (document.getElementById('live-field-fix-style')) return;
    const style = document.createElement('style');
    style.id = 'live-field-fix-style';
    style.textContent = `
      .live-court-card{margin-top:14px}.live-court-head{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap}
      .live-court{background:#efa779;border:2px solid #ffd0b1;border-radius:10px;padding:8px;margin-top:10px}
      .live-net{text-align:center;color:#142138;border-bottom:3px solid #142138;padding:4px;font-weight:800}
      .live-court-grid{position:relative;height:330px;overflow:visible}
      .live-court-player{position:absolute;transform:translate(-50%,-50%);width:22%;min-width:70px;max-width:110px;background:#142138;color:#fff;border:2px solid #ffffff33;border-radius:9px;padding:5px;text-align:center;box-shadow:0 3px 9px #0005}
      .live-court-player.server{border-color:#ed9a3b;box-shadow:0 0 0 2px #ed9a3b55,0 3px 9px #0005}
      .live-court-role{font-size:10px;color:#ed9a3b}.live-court-number{display:inline-block;margin-top:3px;padding:1px 5px;border-radius:999px;background:#edf1f8;color:#142138;font-size:11px;font-weight:900}.live-court-pos{font-size:10px;color:#cfd6e4}.live-court-name{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      @media(max-width:520px){.live-court-grid{height:300px}.live-court-player{width:27%;min-width:64px;font-size:11px}}
    `;
    document.head.appendChild(style);
  }

  function fieldHtml(data) {
    const lineup = data.lineup;
    if (!lineup) return '';
    const rotation = Number(lineup.rotation || 1);
    const serving = lineup.serving === 'team' ? 'team' : 'opponent';
    const layout = LAYOUT[serving][rotation];
    const positions = POSITION_BY_ROTATION[rotation];
    const servingName = serving === 'team' ? selected.teamName : data.match.opponent;
    const players = ROLE_ORDER.map((role) => {
      const xy = layout[role];
      const player = lineup.players[role] || {};
      const position = positions[role];
      const isServer = serving === 'team' && position === 1;
      return `<div class="live-court-player${isServer?' server':''}" style="left:${xy[0]}%;top:${xy[1]}%">
        <div class="live-court-pos">P${position}${isServer?' · SERVICE':''}</div>
        <div class="live-court-role">${ROLE_NAMES[role]}</div>
        <div class="live-court-name">${esc(player.name || '—')}</div>
        <div class="live-court-number">#${esc(player.number || '—')}</div>
      </div>`;
    }).join('');
    return `<div class="card live-court-card">
      <div class="live-court-head"><h3>Actuele veldopstelling</h3><span class="pill">Rotatie ${rotation} · ${esc(servingName)} serveert</span></div>
      <div class="live-court"><div class="live-net">NET</div><div class="live-court-grid">${players}</div></div>
    </div>`;
  }

  const originalShowLiveScore = showLiveScore;
  showLiveScore = function () {
    originalShowLiveScore();
    ensureStyles();
    const body = document.querySelector('#livebody');
    if (body && liveData && liveData.lineup) body.insertAdjacentHTML('beforeend', fieldHtml(liveData));
  };

  // Zorg dat na elk punt en elke undo de actuele status opnieuw wordt getekend.
  const originalPhase2Action = phase2Action;
  phase2Action = async function (path, body = {}) {
    await originalPhase2Action(path, body);
    if (liveMatchId) {
      liveData = await api('phase2/status?teamId=' + selected.teamId + '&matchId=' + liveMatchId);
      renderLive();
    }
  };

  ensureStyles();
})();
