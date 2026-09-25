const fs = require('fs');
const path = require('path');

const dist = 'dist';
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const file of ['index.html', 'manifest.webmanifest', 'sw.js', 'staticwebapp.config.json']) {
  let source = fs.readFileSync(file, 'utf8');

  // index.html renders the menu drawer dynamically inside #app. The old
  // static placeholders in <body> created duplicate IDs, so querySelector()
  // selected the hidden placeholder instead of the active drawer.
  if (file === 'index.html') {
    source = source.replace(
      /\n\s*<div id="menuOverlay" class="menu-overlay" onclick="closeMenu\(\)"><\/div>\n\s*<div id="menuDrawer" class="menu-drawer" aria-hidden="true"><\/div>/,
      ''
    );
  }

  fs.writeFileSync(path.join(dist, file), source);
}
