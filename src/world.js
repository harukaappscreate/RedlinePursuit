// ===== World construction: sky, terrain, city, highways, decor =====
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HeightField, WORLD_HALF, CITY_HALF, STREET_SPACING, STREET_HALF_W, HF_N, HF_CELL, WATER_LEVEL } from './terrain.js';
import { buildRoads, buildNav, LOOP_HALF_W } from './roads.js';
import { StaticWorld } from './collision.js';
import { mulberry32, makeNoise2D, fbm, smoothstep, clamp, nextFrame } from './util.js';
import * as TX from './textures.js';

export const globalUniforms = { time: { value: 0 } };

export class World {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.statics = new StaticWorld();
    this.hf = new HeightField();
    this.updaters = [];
  }

  async build(progress = () => {}) {
    progress(0.02, '道路網を生成中…');
    await nextFrame();
    this.net = buildRoads();
    progress(0.08, '地形を生成中…');
    await nextFrame();
    this.hf.build(this.net.roads);
    this.nav = buildNav(this.net);
    progress(0.25, '空と光を設定中…');
    await nextFrame();
    this.buildSky();
    progress(0.32, '地形メッシュを構築中…');
    await nextFrame();
    this.buildTerrain();
    this.buildFarLand();
    this.buildWater();
    progress(0.45, 'ハイウェイを舗装中…');
    await nextFrame();
    this.buildRoadMeshes();
    progress(0.58, 'ダウンタウンを建設中…');
    await nextFrame();
    this.buildCity();
    progress(0.75, '森と岩を配置中…');
    await nextFrame();
    this.buildNature();
    progress(0.85, 'ミニマップを描画中…');
    await nextFrame();
    this.buildMinimap();
    progress(0.9, 'シェーダーをコンパイル中…');
    await nextFrame();
  }

  heightAt(x, z) { return this.hf.get(x, z); }

  // ---------------- Sky & lighting ----------------
  buildSky() {
    const scene = this.scene;
    const sky = new Sky();
    sky.scale.setScalar(20000);
    const u = sky.material.uniforms;
    u.turbidity.value = 7.5; u.rayleigh.value = 2.6; u.mieCoefficient.value = 0.006; u.mieDirectionalG.value = 0.86;
    const elev = THREE.MathUtils.degToRad(4.5), az = THREE.MathUtils.degToRad(-128);
    const sun = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - elev, az);
    u.sunPosition.value.copy(sun);
    this.sunDir = sun.clone();
    scene.add(sky);
    this.sky = sky;

    // env map from sky
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky2 = new Sky(); sky2.scale.setScalar(1000);
    Object.assign(sky2.material.uniforms.sunPosition.value, sun);
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) sky2.material.uniforms[k].value = u[k].value;
    envScene.add(sky2);
    // add a warm ground plane to env so reflections aren't black below horizon
    const g = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshBasicMaterial({ color: 0x2a2320 }));
    g.rotation.x = -Math.PI / 2; g.position.y = -30; envScene.add(g);
    this.envMap = pmrem.fromScene(envScene, 0.02).texture;
    scene.environment = this.envMap;
    pmrem.dispose();

    scene.fog = new THREE.FogExp2(new THREE.Color(0.62, 0.46, 0.4), 0.00028);

    const hemi = new THREE.HemisphereLight(0x9fb4d8, 0x4a3a2a, 0.9);
    scene.add(hemi);
    const dl = new THREE.DirectionalLight(0xffb07a, 3.2);
    dl.position.copy(sun).multiplyScalar(400);
    dl.castShadow = true;
    dl.shadow.mapSize.set(2048, 2048);
    const S = 110;
    Object.assign(dl.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 1200 });
    dl.shadow.bias = -0.0004; dl.shadow.normalBias = 0.6;
    scene.add(dl); scene.add(dl.target);
    this.sunLight = dl;

    // lens flare
    const flareTex0 = TX.glowTexture('rgba(255,230,190,1)', 'rgba(255,160,80,0)', 256);
    const flareTex1 = TX.glowTexture('rgba(255,180,120,0.5)', 'rgba(255,120,60,0)', 128);
    const lf = new Lensflare();
    lf.addElement(new LensflareElement(flareTex0, 280, 0, new THREE.Color(0.6, 0.45, 0.35)));
    lf.addElement(new LensflareElement(flareTex1, 50, 0.6, new THREE.Color(0.25, 0.18, 0.12)));
    lf.addElement(new LensflareElement(flareTex1, 80, 0.7, new THREE.Color(0.2, 0.15, 0.1)));
    lf.addElement(new LensflareElement(flareTex1, 110, 0.9, new THREE.Color(0.18, 0.13, 0.1)));
    lf.addElement(new LensflareElement(flareTex1, 60, 1.0, new THREE.Color(0.2, 0.15, 0.1)));
    const flareHolder = new THREE.Object3D();
    flareHolder.position.copy(sun).multiplyScalar(9000);
    flareHolder.add(lf);
    scene.add(flareHolder);
    this.flare = flareHolder;
  }

  updateSun(target) {
    const dl = this.sunLight;
    // snap to texel grid to avoid shimmering
    const snap = (2 * 110) / 2048;
    const tx = Math.round(target.x / snap) * snap, tz = Math.round(target.z / snap) * snap;
    dl.target.position.set(tx, target.y, tz);
    dl.position.set(tx + this.sunDir.x * 500, target.y + this.sunDir.y * 500 + 60, tz + this.sunDir.z * 500);
    this.flare.position.set(target.x + this.sunDir.x * 9000, this.sunDir.y * 9000, target.z + this.sunDir.z * 9000);
  }

  // ---------------- Terrain ----------------
  buildTerrain() {
    const n = this.hf.n;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const nz = makeNoise2D(55), nz2 = makeNoise2D(66);
    const tmpN = new THREE.Vector3();
    const cGrass1 = new THREE.Color(0.26, 0.34, 0.12), cGrass2 = new THREE.Color(0.5, 0.44, 0.22), cGrass3 = new THREE.Color(0.18, 0.28, 0.1);
    const cRock = new THREE.Color(0.36, 0.32, 0.29), cSand = new THREE.Color(0.78, 0.68, 0.5), cDirt = new THREE.Color(0.42, 0.36, 0.28);
    const cSnow = new THREE.Color(0.92, 0.93, 0.96), cWet = new THREE.Color(0.32, 0.29, 0.22), cCity = new THREE.Color(0.3, 0.3, 0.3);
    const c = new THREE.Color();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = -WORLD_HALF + i * HF_CELL, z = -WORLD_HALF + j * HF_CELL;
      const h = this.hf.data[k];
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 12; uv[k * 2 + 1] = z / 12;
      this.hf.normal(x, z, tmpN);
      const slope = 1 - tmpN.y;
      const g = fbm(nz, x / 300, z / 300, 3) * 0.5 + 0.5;
      c.copy(cGrass1).lerp(cGrass2, smoothstep(0.35, 0.75, g));
      c.lerp(cGrass3, smoothstep(0.6, 0.9, fbm(nz2, x / 90, z / 90, 2) * 0.5 + 0.5) * 0.6);
      c.lerp(cRock, smoothstep(0.12, 0.3, slope));
      c.lerp(cRock, smoothstep(140, 200, h));
      c.lerp(cSnow, smoothstep(260, 320, h + fbm(nz, x / 80, z / 80, 2) * 30));
      const rd = this.hf.rd[k];
      c.lerp(cDirt, (1 - smoothstep(0, 6, rd)) * 0.8);
      if (x > 1300) c.lerp(cSand, 1 - smoothstep(1.0, 6, h));
      if (h < WATER_LEVEL) c.copy(cWet);
      if (Math.abs(x) < 640 && Math.abs(z) < 640) c.lerp(cCity, 0.5);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
    const idx = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, cc = a + n, d = cc + 1;
      idx.push(a, cc, b, b, cc, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const detail = TX.grassDetailTexture();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.95, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.terrain = mesh;
  }

  buildFarLand() {
    const size = 18000, res = 180;
    const geo = new THREE.PlaneGeometry(size, size, res, res);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    const nz = makeNoise2D(909);
    const col = new Float32Array(p.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const d = Math.max(Math.abs(x), Math.abs(z));
      let h;
      const eastness = smoothstep(1000, 2400, x) * (1 - smoothstep(2500, 5000, Math.abs(z)));
      if (d < 2080) h = -70;
      else {
        h = 160 + smoothstep(2080, 5000, d) * 700 * (0.55 + 0.45 * fbm(nz, x / 1400, z / 1400, 4)) + fbm(nz, x / 300, z / 300, 3) * 80;
        h = h * (1 - eastness) + -40 * eastness;
      }
      p.setY(i, h);
      c.setRGB(0.3, 0.28, 0.25).lerp(new THREE.Color(0.2, 0.26, 0.14), 0.4);
      if (h > 480) c.lerp(new THREE.Color(0.9, 0.92, 0.95), smoothstep(480, 600, h));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    mesh.position.y = -0.5;
    this.scene.add(mesh);
  }

  buildWater() {
    const nt = TX.waterNormalTexture();
    nt.repeat.set(600, 600);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0d2a3a, roughness: 0.06, metalness: 0.1, normalMap: nt, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.2,
    });
    const geo = new THREE.PlaneGeometry(40000, 40000);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = WATER_LEVEL;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.updaters.push((dt, t) => { nt.offset.set(t * 0.004, t * 0.0025); });
  }

  // ---------------- Roads ----------------
  ribbon(pts, closed, halfW, yOff, vLen, x0 = -1, x1 = 1) {
    const n = pts.length;
    const count = closed ? n + 1 : n;
    const pos = new Float32Array(count * 2 * 3), uv = new Float32Array(count * 2 * 2), nor = new Float32Array(count * 2 * 3);
    let dist = 0;
    for (let k = 0; k < count; k++) {
      const i = k % n;
      const p = pts[i];
      const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
      const next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      let tx = next.x - prev.x, tz = next.z - prev.z; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const rx = -tz, rz = tx;
      if (k > 0) { const q = pts[(k - 1) % n]; dist += Math.hypot(p.x - q.x, p.z - q.z); }
      for (let s = 0; s < 2; s++) {
        const o = (s === 0 ? x0 : x1) * halfW;
        const vi = k * 2 + s;
        pos[vi * 3] = p.x + rx * o; pos[vi * 3 + 1] = p.h + yOff; pos[vi * 3 + 2] = p.z + rz * o;
        uv[vi * 2] = s; uv[vi * 2 + 1] = dist / vLen;
        nor[vi * 3 + 1] = 1;
      }
    }
    const idx = [];
    for (let k = 0; k < count - 1; k++) { const a = k * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  buildRoadMeshes() {
    const hwTex = TX.roadTexture(3, true);
    const cnTex = TX.roadTexture(2, false);
    const hwMat = new THREE.MeshStandardMaterial({ map: hwTex, roughness: 0.78, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const cnMat = new THREE.MeshStandardMaterial({ map: cnTex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const rpTex = TX.roadTexture(1, false);
    const rampMat = new THREE.MeshStandardMaterial({ map: rpTex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -0.8, polygonOffsetUnits: -0.8 });
    const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 1, polygonOffset: true, polygonOffsetFactor: -0.5, polygonOffsetUnits: -0.5 });
    for (const r of this.net.roads) {
      const hw = r.kind === 'highway';
      const g = this.ribbon(r.pts, r.closed, r.halfW + (hw ? 1.2 : 0.8), hw ? 0.14 : r.kind === 'ramp' ? 0.1 : 0.12, hw ? 36 : 30);
      const m = new THREE.Mesh(g, hw ? hwMat : r.kind === 'ramp' ? rampMat : cnMat);
      m.receiveShadow = true;
      this.scene.add(m);
      const sg = this.ribbon(r.pts, r.closed, r.halfW + 4, 0.06, 30);
      const sm = new THREE.Mesh(sg, shoulderMat); sm.receiveShadow = true; this.scene.add(sm);
    }
    this.buildRails();
    this.buildHighwayLamps();
    this.buildGantries();
  }

  buildRails() {
    const loop = this.net.loop;
    const pts = loop.pts, n = pts.length;
    const off = LOOP_HALF_W + 1.9;
    const railPts = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
      let tx = next.x - prev.x, tz = next.z - prev.z; const l = Math.hypot(tx, tz); tx /= l; tz /= l;
      let rx = -tz, rz = tx;
      if (rx * p.x + rz * p.z < 0) { rx = -rx; rz = -rz; } // outward
      railPts.push({ x: p.x + rx * off, z: p.z + rz * off, h: p.h });
    }
    // beam ribbon (vertical)
    const count = n + 1;
    const pos = new Float32Array(count * 2 * 3);
    for (let k = 0; k < count; k++) {
      const p = railPts[k % n];
      pos.set([p.x, p.h + 0.45, p.z, p.x, p.h + 0.95], k * 6); pos[k * 6 + 5] = p.z;
    }
    const idx = [];
    for (let k = 0; k < count - 1; k++) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.85, roughness: 0.35, side: THREE.DoubleSide });
    const beam = new THREE.Mesh(g, mat); beam.castShadow = true; beam.receiveShadow = true;
    this.scene.add(beam);
    // posts
    const post = new THREE.BoxGeometry(0.15, 1.0, 0.15); post.translate(0, 0.5, 0);
    const pm = new THREE.InstancedMesh(post, new THREE.MeshStandardMaterial({ color: 0x777b80, metalness: 0.7, roughness: 0.5 }), n);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < n; i++) { const p = railPts[i]; m4.makeTranslation(p.x, p.h, p.z); pm.setMatrixAt(i, m4); }
    this.scene.add(pm);
    // reflectors (orange cat-eyes that bloom in headlights)
    const refl = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.2, 0.2) }), Math.ceil(n / 3));
    for (let i = 0, k = 0; i < n; i += 3, k++) { const p = railPts[i]; m4.makeTranslation(p.x, p.h + 0.75, p.z); refl.setMatrixAt(k, m4); }
    this.scene.add(refl);
    for (let i = 0; i < n; i++) { const a = railPts[i], b = railPts[(i + 1) % n]; this.statics.addSeg(a.x, a.z, b.x, b.z, 'rail'); }
    this.railPts = railPts;
  }

  lampGeometry(height, arm) {
    const pole = new THREE.CylinderGeometry(0.1, 0.16, height, 8); pole.translate(0, height / 2, 0);
    const armG = new THREE.BoxGeometry(0.12, 0.12, arm); armG.translate(0, height - 0.1, arm / 2);
    const base = new THREE.CylinderGeometry(0.3, 0.35, 0.6, 8); base.translate(0, 0.3, 0);
    const g = mergeGeometries([pole, armG, base]);
    const head = new THREE.BoxGeometry(0.45, 0.14, 1.1); head.translate(0, height - 0.22, arm - 0.3);
    return { g, head };
  }

  buildHighwayLamps() {
    const pts = this.net.loop.pts, n = pts.length;
    const { g, head } = this.lampGeometry(11, 3.2);
    const every = 6;
    const cnt = Math.ceil(n / every);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x5a5e62, metalness: 0.8, roughness: 0.4 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: new THREE.Color(1, 0.72, 0.4), emissiveIntensity: 5 });
    const poles = new THREE.InstancedMesh(g, poleMat, cnt), heads = new THREE.InstancedMesh(head, headMat, cnt);
    poles.castShadow = true;
    const pools = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    let k = 0;
    for (let i = 0; i < n; i += every) {
      const r = this.railPts[i];
      const p = pts[i];
      const ang = Math.atan2(p.x - r.x, p.z - r.z);
      q.setFromAxisAngle(up, ang);
      m4.compose(new THREE.Vector3(r.x + (r.x - p.x) * 0.04, r.h, r.z + (r.z - p.z) * 0.04), q, s);
      poles.setMatrixAt(k, m4); heads.setMatrixAt(k, m4); k++;
      pools.push({ x: r.x + Math.sin(ang) * 3.5, z: r.z + Math.cos(ang) * 3.5, y: p.h + 0.2, s: 13 });
    }
    this.scene.add(poles, heads);
    this.addLightPools(pools);
  }

  addLightPools(list) {
    if (!this.poolTex) this.poolTex = TX.glowTexture('rgba(255,190,120,0.9)', 'rgba(255,150,80,0)', 128);
    const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ map: this.poolTex, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const m4 = new THREE.Matrix4();
    list.forEach((p, i) => { m4.makeScale(p.s, 1, p.s).setPosition(p.x, p.y, p.z); im.setMatrixAt(i, m4); });
    im.renderOrder = 2;
    this.scene.add(im);
  }

  buildGantries() {
    const loop = this.net.loop;
    const n = loop.pts.length;
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8a8e92, metalness: 0.8, roughness: 0.4 });
    for (const c of this.net.connectors) {
      for (const dir of [1, -1]) {
        const i = (c.loopIndex - dir * 34 + n) % n;
        const p = loop.pts[i], nx = loop.pts[(i + dir + n) % n];
        const ang = Math.atan2(nx.x - p.x, nx.z - p.z);
        const grp = new THREE.Group();
        const span = LOOP_HALF_W * 2 + 4;
        const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.5, 0.5), postMat); beam.position.y = 7.5;
        const pL = new THREE.Mesh(new THREE.BoxGeometry(0.4, 7.8, 0.4), postMat); pL.position.set(-span / 2, 3.9, 0);
        const pR = pL.clone(); pR.position.x = span / 2;
        const tex = TX.textTexture(c.name, { sub: 'NEXT EXIT', w: 512, h: 200 });
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 3.1), new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35, roughness: 0.5 }));
        sign.position.set(-5, 6.2, -0.3); sign.rotation.y = Math.PI;
        grp.add(beam, pL, pR, sign);
        grp.position.set(p.x, p.h, p.z);
        grp.rotation.y = ang;
        grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
        this.scene.add(grp);
        const rx = Math.cos(ang), rz = -Math.sin(ang);
        this.statics.addCircle(p.x + rx * span / 2, p.z + rz * span / 2, 0.5, 'post');
        this.statics.addCircle(p.x - rx * span / 2, p.z - rz * span / 2, 0.5, 'post');
      }
    }
  }

  // ---------------- City ----------------
  buildCity() {
    const S = STREET_SPACING, H = CITY_HALF, W = STREET_HALF_W;
    const rnd = mulberry32(2024);
    const scene = this.scene;
    // ground asphalt
    const aTex = TX.asphaltTexture(); aTex.repeat.set(1224 / 14, 1224 / 14);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1224, 1224), new THREE.MeshStandardMaterial({ map: aTex, roughness: 0.75, color: 0xb0b0b0 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = 0.04; ground.receiveShadow = true;
    scene.add(ground);

    // markings
    const markGeo = new THREE.PlaneGeometry(1, 1); markGeo.rotateX(-Math.PI / 2);
    const white = new THREE.MeshStandardMaterial({ color: 0xdcdcd4, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xd8a420, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const whites = [], yellows = [];
    const lines = [];
    for (let k = -H; k <= H; k += S) lines.push(k);
    for (const c of lines) {
      for (let seg = -H; seg < H; seg += S) {
        const a = seg + W + 2, b = seg + S - W - 2, len = b - a, mid = (a + b) / 2;
        for (const o of [-0.25, 0.25]) { yellows.push([mid, c + o, len, 0.18]); yellows.push([c + o, mid, 0.18, len]); }
        for (const lane of [-5, 5]) for (let d = a + 2; d < b - 3; d += 9) {
          whites.push([d + 1.5, c + lane, 3, 0.16]); whites.push([c + lane, d + 1.5, 0.16, 3]);
        }
        // stop lines & crosswalks
      }
    }
    // crosswalks at intersections
    for (const x of lines) for (const z of lines) {
      for (let s = -8; s <= 8; s += 1.6) {
        whites.push([x + s, z - W - 1.2, 0.8, 2.6]); whites.push([x + s, z + W + 1.2, 0.8, 2.6]);
        whites.push([x - W - 1.2, z + s, 2.6, 0.8]); whites.push([x + W + 1.2, z + s, 2.6, 0.8]);
      }
    }
    const mk = (arr, mat) => {
      const im = new THREE.InstancedMesh(markGeo, mat, arr.length);
      const m4 = new THREE.Matrix4();
      arr.forEach((a, i) => { m4.makeScale(a[2], 1, a[3]).setPosition(a[0], 0.06, a[1]); im.setMatrixAt(i, m4); });
      im.receiveShadow = true; scene.add(im);
    };
    mk(whites, white); mk(yellows, yellow);

    // blocks
    const blocks = [];
    for (let i = -H; i < H; i += S) for (let j = -H; j < H; j += S) {
      const cx = i + S / 2, cz = j + S / 2;
      const d = Math.hypot(cx, cz);
      const r = rnd();
      let type = 'build';
      if (r < 0.09 && d > 150) type = 'park'; else if (r < 0.13 && d > 150) type = 'plaza';
      blocks.push({ cx, cz, type, d });
    }
    const bs = S - W * 2; // block size (100)
    const concTex = TX.concreteTexture(); concTex.repeat.set(bs / 4, bs / 4);
    const slabGeo = new THREE.BoxGeometry(bs, 0.3, bs); slabGeo.translate(0, 0.15, 0);
    const slabMat = new THREE.MeshStandardMaterial({ map: concTex, roughness: 0.9 });
    const slabs = new THREE.InstancedMesh(slabGeo, slabMat, blocks.length);
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x3e5a24, roughness: 1 });
    const parkTops = [];
    const m4 = new THREE.Matrix4();
    blocks.forEach((b, i) => {
      m4.makeTranslation(b.cx, 0, b.cz); slabs.setMatrixAt(i, m4);
      this.statics.addBox(b.cx - bs / 2, b.cz - bs / 2, b.cx + bs / 2, b.cz + bs / 2, 'block');
      if (b.type === 'park') parkTops.push(b);
    });
    slabs.receiveShadow = true;
    scene.add(slabs);
    if (parkTops.length) {
      const pg = new THREE.BoxGeometry(bs - 8, 0.05, bs - 8);
      const pm = new THREE.InstancedMesh(pg, grassMat, parkTops.length);
      parkTops.forEach((b, i) => { m4.makeTranslation(b.cx, 0.32, b.cz); pm.setMatrixAt(i, m4); });
      pm.receiveShadow = true; scene.add(pm);
    }

    // buildings
    const bldg = [];
    const palette = [0x8a8580, 0xa89c88, 0x6d7278, 0x5a6470, 0x9a6a52, 0x7e7a70, 0xb0a898, 0x4a5058, 0x6a5a4c];
    const addB = (x, z, w, d, h, seed, style, color) => bldg.push({ x, z, w, d, h, seed, style, color });
    const treeSpots = [];
    const fountains = [];
    for (const b of blocks) {
      const f = 1 - clamp(b.d / 820, 0, 1);
      const inset = bs / 2 - 5;
      if (b.type === 'park') {
        for (let k = 0; k < 26; k++) treeSpots.push({ x: b.cx + (rnd() - 0.5) * (bs - 14), z: b.cz + (rnd() - 0.5) * (bs - 14), s: 0.8 + rnd() * 0.6 });
        continue;
      }
      if (b.type === 'plaza') {
        fountains.push(b);
        for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; treeSpots.push({ x: b.cx + Math.cos(a) * 34, z: b.cz + Math.sin(a) * 34, s: 0.9 }); }
        continue;
      }
      const lotsR = rnd();
      const lots = [];
      if (f > 0.55 && lotsR < 0.45) lots.push([b.cx, b.cz, inset * 2, inset * 2]);
      else if (lotsR < 0.7) {
        const g = 3;
        lots.push([b.cx - inset / 2 - g / 2, b.cz, inset - g, inset * 2], [b.cx + inset / 2 + g / 2, b.cz, inset - g, inset * 2]);
      } else {
        const g = 3, q = inset / 2 + g / 2, s = inset - g;
        lots.push([b.cx - q, b.cz - q, s, s], [b.cx + q, b.cz - q, s, s], [b.cx - q, b.cz + q, s, s], [b.cx + q, b.cz + q, s, s]);
      }
      for (const [x, z, w, d] of lots) {
        const hmax = 18 + f * f * 190;
        const h = 10 + rnd() * rnd() * hmax + f * 20;
        const shrink = 0.8 + rnd() * 0.2;
        const style = f > 0.4 && rnd() < 0.55 ? 0.75 + rnd() * 0.25 : rnd() * 0.7;
        const color = palette[Math.floor(rnd() * palette.length)];
        const seed = rnd();
        const bw = w * shrink, bd = d * (0.8 + rnd() * 0.2);
        addB(x, z, bw, bd, h, seed, style, color);
        if (h > 70) {
          addB(x, z, bw * 0.7, bd * 0.7, h * (0.18 + rnd() * 0.2), seed + 0.3, style, color);
          if (rnd() < 0.6) addB(x, z, bw * 0.35, bd * 0.35, h * 0.1, seed + 0.6, style, 0x3a3d42);
        }
        if (rnd() < 0.5) {
          // rooftop units
          addB(x + (rnd() - 0.5) * bw * 0.5, z + (rnd() - 0.5) * bd * 0.5, 4 + rnd() * 5, 4 + rnd() * 5, 2 + rnd() * 2, 0.9, 0.1, 0x55585c);
        }
      }
      // sidewalk trees for lower-density blocks
      if (f < 0.5) for (let e = -40; e <= 40; e += 20) {
        treeSpots.push({ x: b.cx + e, z: b.cz - bs / 2 + 2.2, s: 0.55 }, { x: b.cx + e, z: b.cz + bs / 2 - 2.2, s: 0.55 });
      }
    }
    // stack: rooftop positions need base heights -> compute y offsets by order
    const baseBox = new THREE.BoxGeometry(1, 1, 1); baseBox.translate(0, 0.5, 0);
    const bMat = this.buildingMaterial();
    const bim = new THREE.InstancedMesh(baseBox, bMat, bldg.length);
    const seeds = new Float32Array(bldg.length * 2);
    const col = new THREE.Color();
    const tops = [];
    const beacons = [];
    const neon = [];
    bldg.forEach((b, i) => {
      // find what is under (previous with same center & larger)
      let y = 0.3;
      for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
        const o = bldg[k];
        if (Math.abs(o.x - b.x) < o.w / 2 && Math.abs(o.z - b.z) < o.d / 2 && o.w >= b.w) { y = o.y + o.h; break; }
      }
      b.y = y;
      m4.makeScale(b.w, b.h, b.d).setPosition(b.x, y, b.z);
      bim.setMatrixAt(i, m4);
      col.set(b.color); bim.setColorAt(i, col);
      seeds[i * 2] = b.seed; seeds[i * 2 + 1] = b.style;
      if (y + b.h > 110 && b.w < 30) beacons.push([b.x, y + b.h + 0.6, b.z]);
      if (y === 0.3 && b.h > 25 && rnd() < 0.35) {
        const side = Math.floor(rnd() * 4);
        const hy = 8 + rnd() * Math.min(40, b.h - 16);
        const nc = [[4, 0.4, 2.2], [0.4, 2.5, 4], [4, 2.6, 0.3], [0.3, 3.5, 3], [4, 1.2, 3.2]][Math.floor(rnd() * 5)];
        neon.push({ x: b.x, z: b.z, y: hy, side, w: b.w, d: b.d, c: nc, sw: 4 + rnd() * 6, sh: 1.5 + rnd() * 3 });
      }
    });
    baseBox.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 2));
    bim.castShadow = true; bim.receiveShadow = false;
    scene.add(bim);

    // antenna beacons (blink)
    if (beacons.length) {
      const bm = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.2, 0.1) });
      const bi = new THREE.InstancedMesh(new THREE.SphereGeometry(0.6, 8, 6), bm, beacons.length);
      beacons.forEach((p, i) => { m4.makeTranslation(p[0], p[1], p[2]); bi.setMatrixAt(i, m4); });
      scene.add(bi);
      this.updaters.push((dt, t) => { const on = (t % 1.6) < 0.25 ? 1 : 0.05; bm.color.setRGB(6 * on, 0.2 * on, 0.1 * on); });
    }
    // neon signs
    if (neon.length) {
      const ng = new THREE.PlaneGeometry(1, 1);
      const nm = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
      const ni = new THREE.InstancedMesh(ng, nm, neon.length);
      const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      neon.forEach((s, i) => {
        const offs = [[0, s.d / 2 + 0.15, 0], [s.w / 2 + 0.15, 0, Math.PI / 2], [0, -s.d / 2 - 0.15, Math.PI], [-s.w / 2 - 0.15, 0, -Math.PI / 2]][s.side];
        q.setFromAxisAngle(up, offs[2]);
        m4.compose(new THREE.Vector3(s.x + offs[0], s.y, s.z + offs[1]), q, new THREE.Vector3(s.sw, s.sh, 1));
        ni.setMatrixAt(i, m4); col.setRGB(s.c[0], s.c[1], s.c[2]); ni.setColorAt(i, col);
      });
      scene.add(ni);
    }

    // fountains
    for (const b of fountains) {
      const basin = new THREE.Mesh(new THREE.CylinderGeometry(12, 12.5, 1, 32), new THREE.MeshStandardMaterial({ color: 0x9a948a, roughness: 0.8 }));
      basin.position.set(b.cx, 0.8, b.cz);
      const water = new THREE.Mesh(new THREE.CylinderGeometry(11.3, 11.3, 0.1, 32), new THREE.MeshStandardMaterial({ color: 0x1d4050, roughness: 0.05, metalness: 0.2 }));
      water.position.set(b.cx, 1.2, b.cz);
      const col2 = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.5, 5, 12), basin.material); col2.position.set(b.cx, 3, b.cz);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.2, 3) }));
      glow.position.set(b.cx, 5.8, b.cz);
      basin.castShadow = col2.castShadow = true;
      scene.add(basin, water, col2, glow);
    }

    // street lamps
    const lampList = [];
    for (const c of lines) {
      for (let t = -H + 20; t <= H - 20; t += 40) {
        const mod = ((t % S) + S) % S;
        if (mod < 14 || mod > S - 14) continue;
        for (const side of [-1, 1]) {
          if (Math.abs(c + side * (W + 1.3)) > H) continue;
          lampList.push({ x: t, z: c + side * (W + 1.3), ang: side > 0 ? Math.PI : 0 });
          lampList.push({ x: c + side * (W + 1.3), z: t, ang: side > 0 ? -Math.PI / 2 : Math.PI / 2 });
        }
      }
    }
    const { g, head } = this.lampGeometry(8, 2.2);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2d30, metalness: 0.7, roughness: 0.5 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: new THREE.Color(1, 0.78, 0.5), emissiveIntensity: 5 });
    const poles = new THREE.InstancedMesh(g, poleMat, lampList.length), heads = new THREE.InstancedMesh(head, headMat, lampList.length);
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    const pools = [];
    lampList.forEach((l, i) => {
      q.setFromAxisAngle(up, l.ang);
      m4.compose(new THREE.Vector3(l.x, 0.3, l.z), q, one);
      poles.setMatrixAt(i, m4); heads.setMatrixAt(i, m4);
      pools.push({ x: l.x + Math.sin(l.ang) * 2.5, z: l.z + Math.cos(l.ang) * 2.5, y: 0.08, s: 10 });
    });
    poles.castShadow = true;
    scene.add(poles, heads);
    this.addLightPools(pools);

    this.cityTrees = treeSpots;
  }

  buildingMaterial() {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0, envMapIntensity: 1.0 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
        attribute vec2 aSeed; varying vec2 vSeed; varying vec3 vBW; varying vec3 vBN;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 bwp = vec4(transformed, 1.0);
        vec3 bn = normal;
        #ifdef USE_INSTANCING
          bwp = instanceMatrix * bwp;
          bn = mat3(instanceMatrix) * bn;
        #endif
        vBW = (modelMatrix * bwp).xyz; vBN = bn; vSeed = aSeed;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
        varying vec2 vSeed; varying vec3 vBW; varying vec3 vBN;
        float bhash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 bN = normalize(vBN);
        float isWall = 1.0 - step(0.5, abs(bN.y));
        vec2 tg = normalize(vec2(-bN.z, bN.x) + 1e-5);
        float bu = dot(vBW.xz, tg);
        float bv = vBW.y;
        float glassy = step(0.75, vSeed.y);
        float cw = mix(3.0, 4.4, fract(vSeed.y * 7.0));
        vec2 cell = vec2(bu / cw, bv / 3.6);
        vec2 fw = fract(cell); vec2 wid = floor(cell);
        float mx = mix(0.17, 0.04, glassy), my = mix(0.24, 0.06, glassy);
        float win = step(mx, fw.x) * step(fw.x, 1.0 - mx) * step(my, fw.y) * step(fw.y, 1.0 - my * 0.6) * step(4.6, bv) * isWall;
        float bRnd = bhash(wid + vSeed.x * 91.7);
        float bLit = step(0.66 - glassy * 0.12, bRnd) * win * step(vSeed.y, 0.99);
        vec3 glassCol = mix(vec3(0.03, 0.045, 0.07), vec3(0.05, 0.09, 0.12), glassy);
        diffuseColor.rgb = mix(diffuseColor.rgb, glassCol, win);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.4 + 0.05, 1.0 - isWall);
        float bShop = isWall * step(bv, 4.1) * step(0.9, bv) * step(vSeed.y, 0.99);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), bShop);
        float bWin = win;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.16, max(bWin, bShop));`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        vec3 warm = mix(vec3(1.0, 0.7, 0.4), vec3(0.7, 0.85, 1.0), step(0.86, bRnd));
        totalEmissiveRadiance += warm * bLit * (0.5 + bRnd * 1.5);
        vec3 shopCol = mix(vec3(1.0, 0.55, 0.25), vec3(0.35, 0.75, 1.0), fract(vSeed.x * 13.0));
        totalEmissiveRadiance += shopCol * bShop * 1.4 * step(0.25, fract(bu * 0.07 + vSeed.x));`);
    };
    return m;
  }

  // ---------------- Nature ----------------
  buildNature() {
    const rnd = mulberry32(8080);
    const nz = makeNoise2D(3131);
    const pines = [], broads = [], rocks = [];
    for (let k = 0; k < 60000 && pines.length + broads.length < 9000; k++) {
      const x = (rnd() * 2 - 1) * 1980, z = (rnd() * 2 - 1) * 1980;
      if (Math.abs(x) < 660 && Math.abs(z) < 660) continue;
      const h = this.hf.get(x, z);
      if (h < WATER_LEVEL + 1.5 || h > 240) continue;
      if (this.hf.roadDist(x, z) < 9) continue;
      const dens = fbm(nz, x / 260, z / 260, 3) * 0.5 + 0.5;
      if (rnd() > smoothstep(0.35, 0.75, dens) * 0.95 + 0.03) continue;
      const tmp = new THREE.Vector3(); this.hf.normal(x, z, tmp);
      if (tmp.y < 0.8) { if (rnd() < 0.1) rocks.push({ x, z, h, s: 1 + rnd() * 3 }); continue; }
      const s = 0.8 + rnd() * 0.8;
      if (h > 60 || rnd() < 0.45) pines.push({ x, z, h, s }); else broads.push({ x, z, h, s });
    }
    for (let k = 0; k < 900; k++) {
      const x = (rnd() * 2 - 1) * 1950, z = (rnd() * 2 - 1) * 1950;
      if (Math.abs(x) < 660 && Math.abs(z) < 660) continue;
      const h = this.hf.get(x, z);
      if (h < WATER_LEVEL || this.hf.roadDist(x, z) < 8) continue;
      rocks.push({ x, z, h, s: 0.8 + rnd() * 2.8 });
    }
    for (const t of this.cityTrees) broads.push({ x: t.x, z: t.z, h: 0.3, s: t.s, city: true });

    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    // build instanced meshes split into spatial chunks so frustum/shadow culling works
    const chunked = (list, geos, mats, setup, cast) => {
      const CH = 700;
      const buckets = new Map();
      for (const t of list) { const k = Math.floor(t.x / CH) * 1000 + Math.floor(t.z / CH); let b = buckets.get(k); if (!b) buckets.set(k, (b = [])); b.push(t); }
      for (const b of buckets.values()) {
        const ims = geos.map((g, i) => new THREE.InstancedMesh(g, mats[i], b.length));
        b.forEach((t, i) => { setup(t, m4); for (const im of ims) im.setMatrixAt(i, m4); if (t.col) { ims[ims.length - 1].setColorAt(i, t.col); } });
        for (const im of ims) { im.castShadow = cast; im.receiveShadow = true; im.computeBoundingSphere(); this.scene.add(im); }
      }
    };
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3526, roughness: 1 });
    // pines
    const pineTrunk = new THREE.CylinderGeometry(0.25, 0.4, 4, 5); pineTrunk.translate(0, 2, 0);
    const c1 = new THREE.ConeGeometry(3.2, 7, 7); c1.translate(0, 6.5, 0);
    const c2 = new THREE.ConeGeometry(2.5, 6, 7); c2.translate(0, 9.5, 0);
    const c3 = new THREE.ConeGeometry(1.6, 4.5, 6); c3.translate(0, 12.5, 0);
    const pineTop = mergeGeometries([c1, c2, c3]);
    const pineMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
    for (const t of pines) {
      t.rot = rnd() * 6.28; t.sy = t.s * (0.9 + rnd() * 0.4);
      t.col = new THREE.Color().setHSL(0.3 + rnd() * 0.06, 0.35 + rnd() * 0.2, 0.18 + rnd() * 0.08);
      this.statics.addCircle(t.x, t.z, 0.45 * t.s, 'tree');
    }
    chunked(pines, [pineTrunk, pineTop], [trunkMat, pineMat], (t, m) => { q.setFromAxisAngle(up, t.rot); sc.set(t.s, t.sy, t.s); p.set(t.x, t.h - 0.3, t.z); m.compose(p, q, sc); }, true);
    // broadleaf
    const bTrunk = new THREE.CylinderGeometry(0.22, 0.35, 3.5, 5); bTrunk.translate(0, 1.75, 0);
    const b1 = new THREE.IcosahedronGeometry(2.8, 0); b1.translate(0, 5, 0);
    const b2 = new THREE.IcosahedronGeometry(2.1, 0); b2.translate(1.3, 6.2, 0.6);
    const b3 = new THREE.IcosahedronGeometry(2.0, 0); b3.translate(-1.1, 5.8, -0.8);
    const bTop = mergeGeometries([b1, b2, b3]);
    const bMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    for (const t of broads) {
      t.rot = rnd() * 6.28;
      t.col = new THREE.Color().setHSL(0.18 + rnd() * 0.12, 0.45 + rnd() * 0.2, 0.2 + rnd() * 0.12);
      if (!t.city) this.statics.addCircle(t.x, t.z, 0.4 * t.s, 'tree');
    }
    chunked(broads, [bTrunk, bTop], [trunkMat, bMat], (t, m) => { q.setFromAxisAngle(up, t.rot); sc.setScalar(t.s); p.set(t.x, t.h - 0.2, t.z); m.compose(p, q, sc); }, true);
    // rocks
    const rg = new THREE.DodecahedronGeometry(1, 0);
    const rm = new THREE.MeshStandardMaterial({ color: 0x77706a, roughness: 0.95, flatShading: true });
    for (const r of rocks) {
      r.e = new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3); r.sc = new THREE.Vector3(r.s * (0.8 + rnd() * 0.6), r.s * (0.5 + rnd() * 0.4), r.s * (0.8 + rnd() * 0.6));
      if (r.s > 1.2) this.statics.addCircle(r.x, r.z, r.s * 0.8, 'rock');
    }
    chunked(rocks, [rg], [rm], (r, m) => { q.setFromEuler(r.e); p.set(r.x, r.h, r.z); m.compose(p, q, r.sc); }, true);
  }

  // ---------------- Minimap ----------------
  buildMinimap() {
    const S = 2048, sc = S / (WORLD_HALF * 2);
    const c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S / 4, S / 4);
    for (let j = 0; j < S / 4; j++) for (let i = 0; i < S / 4; i++) {
      const x = (i * 4) / sc - WORLD_HALF, z = (j * 4) / sc - WORLD_HALF;
      const h = this.hf.get(x, z);
      const k = (j * (S / 4) + i) * 4;
      if (h < WATER_LEVEL) { img.data[k] = 10; img.data[k + 1] = 30; img.data[k + 2] = 52; }
      else { const v = clamp(26 + h * 0.18, 20, 90); img.data[k] = v * 0.8; img.data[k + 1] = v; img.data[k + 2] = v * 0.85; }
      img.data[k + 3] = 255;
    }
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = S / 4; tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, S, S);
    const tx = (x) => (x + WORLD_HALF) * sc;
    // city blocks
    ctx.fillStyle = '#2b3036';
    ctx.fillRect(tx(-612), tx(-612), 1224 * sc, 1224 * sc);
    ctx.fillStyle = '#15181c';
    for (let i = -CITY_HALF; i < CITY_HALF; i += STREET_SPACING) for (let j = -CITY_HALF; j < CITY_HALF; j += STREET_SPACING)
      ctx.fillRect(tx(i + 10), tx(j + 10), 100 * sc, 100 * sc);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const r of this.net.roads) {
      ctx.strokeStyle = r.kind === 'highway' ? '#8f9aa6' : '#727c86';
      ctx.lineWidth = r.halfW * 2 * sc * 1.2;
      ctx.beginPath();
      r.pts.forEach((p, i) => (i ? ctx.lineTo(tx(p.x), tx(p.z)) : ctx.moveTo(tx(p.x), tx(p.z))));
      if (r.closed) ctx.closePath();
      ctx.stroke();
    }
    this.minimapCanvas = c;
    this.minimapScale = sc;
  }

  update(dt, t) {
    globalUniforms.time.value = t;
    for (const u of this.updaters) u(dt, t);
  }
}
