// Placeholder entry point until phase 1 (the playable slice) lands.
// It proves the build pipeline and map code work end to end.
import { makeSampleTown } from './map/sample';

const map = makeSampleTown();
const app = document.getElementById('app')!;
app.style.cssText = 'font-family: ui-monospace, monospace; color: #ddd; background: #111; min-height: 100vh; padding: 24px; margin: 0;';
const h = document.createElement('h1');
h.textContent = 'SPOOKY AT HOME';
const p = document.createElement('p');
p.textContent = `Phase 0 scaffold. Sample map "${map.name}": ${map.buildings.length} buildings, ${map.roads.length} roads, ${map.areas.length} parks/water, ${map.pois.length} landmarks.`;
app.append(h, p);
