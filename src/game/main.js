import { App } from '../core/App.js';
import './game.css';

const boot = document.getElementById('boot');
const bootBar = document.querySelector('#bootbar i');
const bootMsg = document.getElementById('bootmsg');
const bootErr = document.getElementById('booterr');

const FRIENDLY = {
  'baking procedural textures': 'Mixing the sea foam',
  'solving wave spectrum': 'Stirring up waves',
  'integrating atmosphere': 'Painting the sky',
  'building sky': 'Hanging the sun',
  'seeding cloud volume': 'Fluffing the clouds',
  'tessellating ocean': 'Filling the ocean',
  'seeding spray': 'Splashing about',
  'setting up camera': 'Finding the boats',
  'compiling post stack': 'Polishing the view',
  'warming shaders': 'Warming up engines',
  'ready': 'Ready!',
};

function progress(msg, p) {
  bootMsg.textContent = FRIENDLY[msg] || msg;
  if (p !== undefined) bootBar.style.width = `${Math.round(p * 100)}%`;
}

function fail(err) {
  console.error(err);
  if (!boot.isConnected) document.body.appendChild(boot);
  boot.classList.remove('hidden');
  bootMsg.textContent = 'The ocean could not start in this browser.';
  bootErr.replaceChildren();
  const message = document.createElement('p');
  message.textContent = 'This game needs WebGL2 with hardware acceleration. Try a current Chrome, Edge, Safari or Firefox, close other heavy tabs, and reload.';
  const retry = document.createElement('button'); retry.textContent = 'Try again';
  retry.onclick = () => location.reload();
  const details = document.createElement('details'), summary = document.createElement('summary'), detail = document.createElement('pre');
  summary.textContent = 'Technical details'; detail.textContent = String(err?.message || err); details.append(summary, detail);
  bootErr.append(message, retry, details);
}

async function main() {
  const canvas = document.getElementById('gl');
  const params = new URLSearchParams(location.search);
  const app = new App(canvas, progress, { surfaceOnly: params.get('dive') !== '1', preset: 'game' });
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); app.running = false;
    fail(new Error('The graphics context was interrupted. Reload to get back on the water.'));
  });
  window.__app = app;
  try {
    await app.init();
  } catch (e) { fail(e); return; }

  const { installDirector } = await import('../weather/Director.js');
  const director = installDirector(app);
  director.enabled = false;              // the game owns the weather

  const { Game } = await import('./Game.js');
  const game = new Game(app);
  window.__game = game;
  try {
    await game.init();
  } catch (e) { fail(e); return; }

  app.start();
  setTimeout(() => {
    boot.classList.add('hidden');
    boot.setAttribute('aria-hidden', 'true');
    setTimeout(() => boot.remove(), 900);
    game.start();
  }, 300);

  window.addEventListener('error', (e) => console.error('[runtime]', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => console.error('[promise]', e.reason));
}

main();
