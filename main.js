import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const CFG = await (await fetch('assets/scene.json')).json();
const EYE = 1.65, RADIUS = 0.28, STEP = 0.42;
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
const BASE_EXPO = CFG.exposure || 1.0;
renderer.toneMappingExposure = BASE_EXPO;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 900);
camera.rotation.order = 'YXZ';
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// Blender (x, y, z) -> three (x, z, -y)
const B = (x, y, z) => new THREE.Vector3(x, z, -y);

// ciel
new THREE.TextureLoader().load('assets/ciel.jpg', t => {
  t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
  scene.background = t; scene.backgroundIntensity = 1.0;
  const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromEquirectangular(t).texture; scene.environmentIntensity = 0.6;
});
const sun = new THREE.DirectionalLight(0xfff1dc, 2.4); const sv = CFG.sun; sun.position.copy(B(sv[0], sv[1], sv[2]).multiplyScalar(100)); scene.add(sun);
scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5a6b3a, 0.7));

// chargement
const ktx2 = new KTX2Loader().setTranscoderPath('lib/three/addons/libs/basis/').detectSupport(renderer);
const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
const colliders = [];
const gltf = await new Promise((res, rej) => loader.load(CFG.glb, res, e => {
  const p = e.total ? e.loaded / e.total : e.loaded / CFG.glb_bytes;
  document.getElementById('bar').style.width = (100 * p).toFixed(0) + '%';
  document.getElementById('pct').textContent = (100 * p).toFixed(0) + ' %  (' + (e.loaded / 1048576).toFixed(0) + ' Mo)';
}, rej));
const LMI = CFG.lmax * Math.PI;
gltf.scene.traverse(o => {
  if (!o.isMesh) return;
  const m = o.material, n = (m.name || '');
  let collide = true;
  if (n.startsWith('LM_') && m.map) {
    const lm = m.emissiveMap;
    if (n.startsWith("LM_W_Sol_pelouse")) { m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping; m.map.needsUpdate = true; }
    o.material = new THREE.MeshBasicMaterial({ map: m.map, lightMap: lm || null, lightMapIntensity: LMI, side: THREE.FrontSide });
    if (n.startsWith('LM_W_Sol_pelouse')) { collide = true; }
  } else if (n.startsWith('EMIT_')) {
    const c = m.emissive.clone().multiplyScalar(2.5);
    o.material = new THREE.MeshBasicMaterial({ color: c }); collide = false;
  } else if (n.startsWith('GLASS_')) {
    const op = { GLASS_verre: 0.12, GLASS_verre_givre: 0.55, GLASS_eau: 0.8, GLASS_voile: 0.45 }[n] ?? 0.2;
    o.material = new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide });
    collide = false; o.renderOrder = 2;
  } else {
    // végétation et petits objets « vivants » : éclairage temps réel simple
    m.alphaTest = m.transparent ? 0.5 : m.alphaTest; m.transparent = false; m.side = THREE.DoubleSide;
    if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.8;
    collide = false;
  }
  if (collide) { o.geometry.computeBoundsTree(); colliders.push(o); }
  o.matrixAutoUpdate = false; o.updateMatrix();
});
scene.add(gltf.scene);
scene.updateMatrixWorld(true);
document.getElementById('loading').classList.add('hidden');
document.getElementById('start').classList.remove('hidden');

// ---------------------------------------------------------------- joueur
const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
const feet = new THREE.Vector3(); let yaw = 0, pitch = 0, vy = 0;
function floorAt(p, from = STEP + 0.05) {
  ray.set(new THREE.Vector3(p.x, p.y + from, p.z), new THREE.Vector3(0, -1, 0)); ray.far = 60;
  const h = ray.intersectObjects(colliders, false); return h.length ? h[0].point.y : null;
}
function blocked(p, dir, dist) {
  for (const hgt of [STEP + 0.03, 1.0, 1.55]) {
    ray.set(new THREE.Vector3(p.x, p.y + hgt, p.z), dir); ray.far = dist + RADIUS;
    if (ray.intersectObjects(colliders, false).length) return true;
  }
  return false;
}
function teleport(r) {
  const p = B(r.x, r.y, (r.z || 0) + 2.2);
  const f = floorAt(p, 0); feet.set(p.x, f !== null ? f : (r.z || 0), p.z);
  yaw = -THREE.MathUtils.degToRad(r.yaw || 0); pitch = 0; vy = 0; closeMenu();
}
teleport(CFG.rooms[0]);

// ---------------------------------------------------------------- entrées
const keys = {}; let running = false;
addEventListener('keydown', e => { keys[e.code] = true; if (e.code === 'KeyM' || e.code === 'Semicolon') toggleMenu(); });
addEventListener('keyup', e => { keys[e.code] = false; });
document.getElementById('go').onclick = () => { document.getElementById('start').classList.add('hidden'); document.getElementById('hud').classList.remove('hidden'); running = true; if (!isTouch) canvas.requestPointerLock(); };
const isTouch = matchMedia('(pointer:coarse)').matches;
canvas.addEventListener('click', () => { if (running && !isTouch && document.pointerLockElement !== canvas) canvas.requestPointerLock(); });
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas) return;
  yaw -= e.movementX * 0.0022; pitch -= e.movementY * 0.0022; pitch = Math.max(-1.45, Math.min(1.45, pitch));
});
// tactile : pouce gauche = joystick, pouce droit = regard
const joy = { id: null, x0: 0, y0: 0, dx: 0, dy: 0 }, look = { id: null, x: 0, y: 0 };
const knob = document.getElementById('knob');
canvas.addEventListener('touchstart', e => { for (const t of e.changedTouches) {
  if (t.clientX < innerWidth * 0.45 && joy.id === null) { joy.id = t.identifier; joy.x0 = t.clientX; joy.y0 = t.clientY; joy.dx = joy.dy = 0; }
  else if (look.id === null) { look.id = t.identifier; look.x = t.clientX; look.y = t.clientY; } } e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchmove', e => { for (const t of e.changedTouches) {
  if (t.identifier === joy.id) { joy.dx = Math.max(-1, Math.min(1, (t.clientX - joy.x0) / 50)); joy.dy = Math.max(-1, Math.min(1, (t.clientY - joy.y0) / 50));
    knob.style.left = (40 + joy.dx * 40) + 'px'; knob.style.top = (40 + joy.dy * 40) + 'px'; }
  if (t.identifier === look.id) { yaw -= (t.clientX - look.x) * 0.005; pitch -= (t.clientY - look.y) * 0.005; pitch = Math.max(-1.45, Math.min(1.45, pitch)); look.x = t.clientX; look.y = t.clientY; } }
  e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchend', e => { for (const t of e.changedTouches) {
  if (t.identifier === joy.id) { joy.id = null; joy.dx = joy.dy = 0; knob.style.left = knob.style.top = '40px'; }
  if (t.identifier === look.id) look.id = null; } });

// ---------------------------------------------------------------- menu des pièces + mini-carte
const menu = document.getElementById('menu');
function toggleMenu() { menu.classList.toggle('hidden'); if (!menu.classList.contains('hidden')) document.exitPointerLock?.(); }
function closeMenu() { menu.classList.add('hidden'); }
document.getElementById('menuBtn').onclick = toggleMenu;
CFG.rooms.forEach(r => { const a = document.createElement('a'); a.textContent = r.name; a.onclick = () => teleport(r); document.getElementById('m' + r.lvl).appendChild(a); });
document.getElementById('expo').oninput = e => { renderer.toneMappingExposure = BASE_EXPO * Math.pow(2, +e.target.value); };
const mm = document.getElementById('minimap'), mctx = mm.getContext('2d');
const plans = CFG.plans.map(p => { const i = new Image(); i.src = p.img; return i; });
const PL = CFG.plan_map; // centre et taille (m) de la vue orthographique
function levelOf() { return feet.y > CFG.f1 - 0.6 ? 1 : 0; }
mm.addEventListener('click', e => {
  const r = mm.getBoundingClientRect(); const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  const x = PL.cx + (u - 0.5) * PL.w, y = PL.cy - (v - 0.5) * PL.h;
  const lv = levelOf(); teleport({ x, y, z: lv ? CFG.f1 : CFG.f0, yaw: -THREE.MathUtils.radToDeg(yaw) });
});
function drawMap() {
  const lv = levelOf(), img = plans[lv];
  mctx.fillStyle = '#000'; mctx.fillRect(0, 0, mm.width, mm.height);
  if (img.complete) mctx.drawImage(img, 0, 0, mm.width, mm.height);
  const bx = feet.x, by = -feet.z;
  const u = ((bx - PL.cx) / PL.w + 0.5) * mm.width, v = (0.5 - (by - PL.cy) / PL.h) * mm.height;
  mctx.save(); mctx.translate(u, v); mctx.rotate(-yaw);
  mctx.fillStyle = '#ff5a2a'; mctx.beginPath(); mctx.moveTo(0, -9); mctx.lineTo(6, 6); mctx.lineTo(-6, 6); mctx.closePath(); mctx.fill();
  mctx.restore();
  mctx.fillStyle = 'rgba(0,0,0,.6)'; mctx.fillRect(0, 0, 70, 16); mctx.fillStyle = '#e2c48e'; mctx.font = '11px sans-serif'; mctx.fillText(lv ? 'ÉTAGE' : 'REZ-DE-CH.', 4, 12);
}
function roomName() {
  const bx = feet.x, by = -feet.z, lv = levelOf();
  for (const z of CFG.zones) if (z.lvl === lv && bx >= z.b[0] && bx <= z.b[2] && by >= z.b[1] && by <= z.b[3]) return z.name;
  return lv ? 'Étage' : (bx < 0 || by < 0 || bx > CFG.W || by > CFG.D ? 'Jardin' : '');
}

// ---------------------------------------------------------------- boucle
const clock = new THREE.Clock(); let acc = 0, lastRoom = '';
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), mv = new THREE.Vector3();
function step(dt) {
  let f = 0, s = 0;
  if (keys.KeyW || keys.KeyZ || keys.ArrowUp) f += 1;
  if (keys.KeyS || keys.ArrowDown) f -= 1;
  if (keys.KeyA || keys.KeyQ || keys.ArrowLeft) s -= 1;
  if (keys.KeyD || keys.ArrowRight) s += 1;
  f -= joy.dy; s += joy.dx;
  const speed = (keys.ShiftLeft || keys.ShiftRight ? 3.6 : 1.7);
  fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw)); right.set(Math.cos(yaw), 0, -Math.sin(yaw));
  mv.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, s);
  if (mv.lengthSq() > 1) mv.normalize();
  mv.multiplyScalar(speed * dt);
  const d = mv.length();
  if (d > 1e-5) {
    const dir = mv.clone().normalize();
    if (!blocked(feet, dir, d)) feet.add(mv);
    else {
      for (const ax of [new THREE.Vector3(mv.x, 0, 0), new THREE.Vector3(0, 0, mv.z)]) {
        const l = ax.length(); if (l < 1e-5) continue;
        if (!blocked(feet, ax.clone().normalize(), l)) { feet.add(ax); break; }
      }
    }
  }
  const fl = floorAt(feet);
  if (fl !== null && fl >= feet.y - 0.02) { feet.y += Math.min(fl - feet.y, 3.0 * dt + 0.02); vy = 0; }
  else { vy -= 9.8 * dt; feet.y += vy * dt; if (fl !== null && feet.y < fl) { feet.y = fl; vy = 0; } }
  if (feet.y < -20) teleport(CFG.rooms[0]);
}
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (running) { acc = dt; step(dt); }
  camera.position.set(feet.x, feet.y + EYE, feet.z); camera.rotation.set(pitch, yaw, 0);
  renderer.render(scene, camera);
  if (running) { drawMap(); const rn = roomName(); if (rn !== lastRoom) { lastRoom = rn; document.getElementById('room').textContent = rn; document.getElementById('room').style.display = rn ? '' : 'none'; } }
}
loop();
window.__visite = { teleport, CFG, setView: (y, p) => { yaw = y; pitch = p; }, ready: true };
