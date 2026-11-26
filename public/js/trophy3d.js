// Interactive 3D model of the tournament trophy (antique-gold boot-and-ball
// award on a black base). Everything is built in code, so there is no model
// file to host. Drag to rotate, scroll / pinch to zoom.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ---------------------------------------------------------------- textures
function rng(seed) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Antique gold: warm gold with dry-brushed dark patina. Tiles seamlessly. */
function patinaCanvas(size = 512, seed = 11) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  const r = rng(seed);
  g.fillStyle = '#b8914a';
  g.fillRect(0, 0, size, size);
  const wrap = (fn) => {
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) fn(dx, dy);
  };
  for (let i = 0; i < 260; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = 12 + r() * 70;
    const dark = r() < 0.62;
    const a = dark ? 0.18 + r() * 0.3 : 0.12 + r() * 0.25;
    wrap((dx, dy) => {
      const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
      grd.addColorStop(0, dark ? `rgba(32,24,12,${a})` : `rgba(245,214,140,${a})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
    });
  }
  g.lineCap = 'round';
  for (let i = 0; i < 1400; i++) {
    const x = r() * size;
    const y = r() * size;
    const len = 3 + r() * 26;
    const ang = (r() - 0.5) * 0.9 + (r() < 0.5 ? 0 : Math.PI / 2);
    const col = `rgba(18,14,8,${0.15 + r() * 0.45})`;
    const lw = 0.5 + r() * 1.8;
    wrap((dx, dy) => {
      g.strokeStyle = col;
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(x + dx, y + dy);
      g.lineTo(x + dx + Math.cos(ang) * len, y + dy + Math.sin(ang) * len);
      g.stroke();
    });
  }
  const img = g.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 26;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n * 0.7;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Roughness (G) and metalness (B) from the colour map: dark patina is rough and dull. */
function ormFrom(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d');
  const s = src.getContext('2d').getImageData(0, 0, src.width, src.height);
  const o = g.createImageData(src.width, src.height);
  for (let i = 0; i < s.data.length; i += 4) {
    const lum = (0.3 * s.data[i] + 0.59 * s.data[i + 1] + 0.11 * s.data[i + 2]) / 255;
    const dark = Math.min(1, Math.max(0, (0.62 - lum) / 0.45));
    o.data[i] = 255;
    o.data[i + 1] = 255 * (0.3 + dark * 0.55); // roughness
    o.data[i + 2] = 255 * (1 - dark * 0.55); // metalness
    o.data[i + 3] = 255;
  }
  g.putImageData(o, 0, 0);
  return c;
}

/** Truncated icosahedron faces (12 pentagons + 20 hexagons) as plane normals. */
function soccerFaces() {
  const t = (1 + Math.sqrt(5)) / 2;
  const V = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => new THREE.Vector3(...v).normalize());
  const faces = V.map((n) => ({ n, k: 1 / 1.02653 })); // pentagons sit a little further out
  for (let a = 0; a < 12; a++)
    for (let b = a + 1; b < 12; b++)
      for (let c = b + 1; c < 12; c++)
        if (V[a].dot(V[b]) > 0.4 && V[a].dot(V[c]) > 0.4 && V[b].dot(V[c]) > 0.4)
          faces.push({ n: V[a].clone().add(V[b]).add(V[c]).normalize(), k: 1 });
  return faces;
}

/** Equirectangular colour + bump maps for a stitched ball with deep dark seams. */
function ballCanvases(patina, W = 1024, H = 512) {
  const faces = soccerFaces();
  const col = document.createElement('canvas');
  col.width = W;
  col.height = H;
  const cg = col.getContext('2d');
  // tile the patina across the ball
  for (let x = 0; x < W; x += 256) for (let y = 0; y < H; y += 256) cg.drawImage(patina, x, y, 256, 256);
  const img = cg.getImageData(0, 0, W, H);
  const bump = document.createElement('canvas');
  bump.width = W;
  bump.height = H;
  const bg = bump.getContext('2d');
  const bimg = bg.createImageData(W, H);
  const d = new THREE.Vector3();
  for (let y = 0; y < H; y++) {
    const th = ((y + 0.5) / H) * Math.PI;
    for (let x = 0; x < W; x++) {
      const ph = ((x + 0.5) / W) * Math.PI * 2;
      d.set(-Math.cos(ph) * Math.sin(th), Math.cos(th), Math.sin(ph) * Math.sin(th));
      let s1 = -9;
      let s2 = -9;
      let best = 0;
      for (let f = 0; f < faces.length; f++) {
        const s = faces[f].n.dot(d) * faces[f].k;
        if (s > s1) {
          s2 = s1;
          s1 = s;
          best = f;
        } else if (s > s2) s2 = s;
      }
      const gap = s1 - s2; // 0 on a seam
      const seam = 1 - Math.min(1, gap / 0.014);
      const puff = Math.min(1, gap / 0.09); // panels bulge slightly
      const i = (y * W + x) * 4;
      const pent = best < 12;
      const shade = pent ? 0.86 : 1;
      const k = 1 - seam * 0.9;
      img.data[i] = img.data[i] * shade * k + 14 * seam;
      img.data[i + 1] = img.data[i + 1] * shade * k + 11 * seam;
      img.data[i + 2] = img.data[i + 2] * shade * k + 6 * seam;
      const h = 255 * (0.25 + 0.75 * Math.sqrt(puff)) * (1 - seam);
      bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = h;
      bimg.data[i + 3] = 255;
    }
  }
  cg.putImageData(img, 0, 0);
  bg.putImageData(bimg, 0, 0);
  return { col, bump };
}

// ---------------------------------------------------------------- geometry
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const spow = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);

/** Football boot along +x (toe at 0, heel at L), sole on y = 0, width on z. */
function bootFrame(L = 2.05, W = 0.33) {
  const env = (s) => {
    const toe = Math.sqrt(1 - Math.pow(1 - Math.min(s / 0.2, 1), 2));
    const heel = Math.sqrt(Math.max(0, 1 - Math.pow(Math.max((s - 0.9) / 0.1, 0), 2)));
    return toe * heel;
  };
  const halfW = (s) => W * env(s) * (1 - 0.13 * Math.exp(-Math.pow((s - 0.62) / 0.12, 2))) * (0.86 + 0.14 * smooth(0, 0.3, s));
  const height = (s) => 0.2 + 0.2 * smooth(0.05, 0.5, s) + 0.27 * smooth(0.55, 0.86, s);
  const sole = (s) => 0.035 * Math.sin(Math.PI * Math.min(1, s / 0.95)) * smooth(0.35, 0.65, s) * 2;
  /** Surface point. th: -PI/2 = sole centre, 0 = outer side (+z), PI/2 = top. */
  const point = (s, th) => {
    const e = Math.sqrt(env(s));
    const h = height(s);
    const yc = sole(s) + h / 2;
    const sn = Math.sin(th);
    const cs = Math.cos(th);
    const y = yc + (h / 2) * e * spow(sn, sn < 0 ? 0.35 : 0.75);
    const z = halfW(s) * spow(cs, 0.55);
    return new THREE.Vector3(s * L, y, z);
  };
  return { L, point, height, halfW, sole, env };
}

function bootGeometry(frame, segS = 120, segT = 64) {
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i <= segS; i++) {
    const s = i / segS;
    for (let j = 0; j <= segT; j++) {
      const th = -Math.PI / 2 + (j / segT) * Math.PI * 2;
      const p = frame.point(s, th);
      pos.push(p.x, p.y, p.z);
      uv.push(s * 4, (j / segT) * 1.5);
    }
  }
  const row = segT + 1;
  for (let i = 0; i < segS; i++)
    for (let j = 0; j < segT; j++) {
      const a = i * row + j;
      idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function tubeAlong(points, radius, mat, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed);
  return new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 6), radius, 8, closed), mat);
}

function buildBoot(gold, dark) {
  const f = bootFrame();
  const g = new THREE.Group();
  const body = new THREE.Mesh(bootGeometry(f), gold);
  g.add(body);

  const lift = (p, n = 0.012) => p.clone().add(new THREE.Vector3(0, 0, Math.sign(p.z) * n));
  // sole welt (raised edge where the upper meets the soleplate), both sides
  for (const side of [1, -1]) {
    const th = side > 0 ? -0.55 : Math.PI + 0.55;
    const pts = [];
    for (let s = 0.03; s <= 0.985; s += 0.035) pts.push(f.point(s, th));
    g.add(tubeAlong(pts, 0.026, gold));
  }
  // flowing side piping and stitch lines on both sides
  for (const side of [1, -1]) {
    const T = (t) => (side > 0 ? t : Math.PI - t);
    const lines = [
      { from: 0.16, to: 0.9, a: 0.05, b: 0.85, r: 0.016 },
      { from: 0.22, to: 0.86, a: -0.15, b: 0.55, r: 0.013 },
      { from: 0.3, to: 0.82, a: -0.32, b: 0.25, r: 0.012 },
      { from: 0.08, to: 0.36, a: 0.5, b: 0.15, r: 0.011 },
    ];
    for (const L of lines) {
      const pts = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const s = L.from + (L.to - L.from) * t;
        pts.push(lift(f.point(s, T(L.a + (L.b - L.a) * Math.sin((t * Math.PI) / 2))), 0.004));
      }
      g.add(tubeAlong(pts, L.r, gold));
    }
    // heel counter
    const hc = [];
    for (let k = 0; k <= 10; k++) hc.push(lift(f.point(0.78 + 0.2 * (k / 10), T(-0.3 + 1.0 * Math.sin((k / 10) * Math.PI))), 0.004));
    g.add(tubeAlong(hc, 0.014, gold));
  }
  // tongue + laces
  const tongue = [];
  for (let s = 0.3; s <= 0.74; s += 0.04) tongue.push(f.point(s, Math.PI / 2).add(new THREE.Vector3(0, 0.012, 0)));
  g.add(tubeAlong(tongue, 0.05, gold));
  for (let k = 0; k < 7; k++) {
    const s = 0.33 + k * 0.058;
    const a = f.point(s - 0.012, Math.PI / 2 - 0.75);
    const b = f.point(s + 0.012, Math.PI / 2 + 0.75);
    const m = f.point(s, Math.PI / 2).add(new THREE.Vector3(0, 0.05, 0));
    g.add(tubeAlong([a, m, b], 0.017, gold));
  }
  // collar (ankle opening) near the heel
  const sC = 0.87;
  const top = f.point(sC, Math.PI / 2);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(1, 0.04, 12, 48), gold);
  collar.scale.set(0.15, f.halfW(sC) * 0.82, 1);
  collar.position.copy(top).add(new THREE.Vector3(0, 0.005, 0));
  collar.rotation.x = Math.PI / 2;
  g.add(collar);
  const hole = new THREE.Mesh(new THREE.CircleGeometry(1, 40), dark);
  hole.scale.set(0.15, f.halfW(sC) * 0.82, 1);
  hole.rotation.x = -Math.PI / 2;
  hole.position.copy(top).add(new THREE.Vector3(0, 0.012, 0));
  g.add(hole);
  // studs: four under the forefoot, two under the heel
  const stud = new THREE.CylinderGeometry(0.038, 0.05, 0.11, 16);
  for (const [s, zf] of [[0.13, 0.55], [0.13, -0.55], [0.33, 0.62], [0.33, -0.62], [0.84, 0.55], [0.84, -0.55]]) {
    const p = f.point(s, -Math.PI / 2);
    const m = new THREE.Mesh(stud, gold);
    m.position.set(p.x, p.y - 0.04, f.halfW(s) * zf);
    g.add(m);
  }
  // soleplate: a thin plate under the whole foot
  const plate = [];
  for (let s = 0.02; s <= 0.98; s += 0.02) plate.push(f.point(s, -Math.PI / 2 + 0.0001));
  g.add(tubeAlong(plate, 0.035, gold));
  return { group: g, frame: f };
}

function ribbedStrut(gold, b0, b1, t0, t1, ribs = 4) {
  // b0,b1 bottom left/right; t0,t1 top left/right (x,y). Thickness on z.
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(b0[0], b0[1]);
  shape.lineTo(b1[0], b1[1]);
  shape.lineTo(t1[0], t1[1]);
  shape.lineTo(t0[0], t0[1]);
  shape.closePath();
  const slab = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 3 });
  slab.translate(0, 0, -0.06);
  g.add(new THREE.Mesh(slab, gold));
  for (let i = 0; i < ribs; i++) {
    const u = (i + 0.5) / ribs;
    const bx = b0[0] + (b1[0] - b0[0]) * u;
    const by = b0[1] + (b1[1] - b0[1]) * u;
    const tx = t0[0] + (t1[0] - t0[0]) * u;
    const ty = t0[1] + (t1[1] - t0[1]) * u;
    for (const z of [0.09, -0.09]) {
      const pts = [];
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        pts.push(new THREE.Vector3(bx + (tx - bx) * t, by + (ty - by) * t, z + 0.02 * Math.sign(z) * Math.sin(t * Math.PI)));
      }
      g.add(tubeAlong(pts, ((b1[0] - b0[0]) / ribs) * 0.42, gold));
    }
  }
  return g;
}

function laurelEmblem(gold, dark) {
  const g = new THREE.Group();
  const R = 0.215;
  const back = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.03, R + 0.03, 0.1, 48), gold);
  back.rotation.x = Math.PI / 2;
  g.add(back);
  const face = new THREE.Mesh(new THREE.CircleGeometry(R - 0.03, 48), dark);
  face.position.z = 0.052;
  g.add(face);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R - 0.02, 0.018, 10, 60), gold);
  rim.position.z = 0.055;
  g.add(rim);
  const leaf = new THREE.SphereGeometry(1, 12, 8);
  for (const side of [-1, 1]) {
    for (let k = 0; k < 9; k++) {
      const a = -Math.PI / 2 + side * (0.25 + k * 0.29);
      for (const off of [-1, 1]) {
        const rr = R + 0.012 + off * 0.022;
        const m = new THREE.Mesh(leaf, gold);
        m.scale.set(0.042, 0.016, 0.012);
        m.position.set(Math.cos(a) * rr, Math.sin(a) * rr, 0.07);
        m.rotation.z = a + side * (Math.PI / 2) + off * 0.5 * side;
        g.add(m);
      }
    }
  }
  return g;
}

function buildTrophy() {
  const patina = patinaCanvas();
  const tex = new THREE.CanvasTexture(patina);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  const orm = new THREE.CanvasTexture(ormFrom(patina));
  orm.wrapS = orm.wrapT = THREE.RepeatWrapping;

  const gold = new THREE.MeshStandardMaterial({ map: tex, roughnessMap: orm, metalnessMap: orm, metalness: 1, roughness: 1, envMapIntensity: 1.15 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x17130c, metalness: 0.7, roughness: 0.55 });
  const black = new THREE.MeshPhysicalMaterial({ color: 0x050506, metalness: 0.05, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 0.4 });

  const { col, bump } = ballCanvases(patina);
  const ballTex = new THREE.CanvasTexture(col);
  ballTex.colorSpace = THREE.SRGBColorSpace;
  ballTex.anisotropy = 4;
  const ballBump = new THREE.CanvasTexture(bump);
  const ballMat = new THREE.MeshStandardMaterial({ map: ballTex, bumpMap: ballBump, bumpScale: 3.5, metalness: 0.95, roughness: 0.42, envMapIntensity: 1.15 });
  const ballGeo = new THREE.SphereGeometry(1, 96, 64);

  const trophy = new THREE.Group();

  // --- black base: oval bell with a lip, and a blank front plate
  const prof = [
    [0, 0], [0.92, 0], [0.98, 0.012], [1.0, 0.04], [1.0, 0.1], [0.985, 0.25], [0.955, 0.42], [0.91, 0.6], [0.85, 0.78], [0.77, 0.94],
    [0.69, 1.05], [0.63, 1.11], [0.6, 1.14], [0.62, 1.16], [0.63, 1.2], [0.6, 1.24], [0.52, 1.27], [0.4, 1.28], [0, 1.28],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const baseGeo = new THREE.LatheGeometry(prof, 96);
  const base = new THREE.Mesh(baseGeo, black);
  base.scale.set(1, 1, 0.82);
  trophy.add(base);
  // blank nameplate: a curved panel following the front of the base, with a thin frame
  const plateProf = prof.filter((v) => v.y >= 0.4 && v.y <= 0.96);
  const pA = 0.52; // half-angle of the panel around the front
  const plateGeo = new THREE.LatheGeometry(plateProf, 32, -pA, pA * 2);
  const plate = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({ color: 0x010101, roughness: 0.32, metalness: 0, envMapIntensity: 0.3 }));
  plate.scale.set(1.012, 1, 0.82 * 1.012);
  trophy.add(plate);
  const edge = [];
  const rAt = (y) => {
    for (let i = 1; i < prof.length; i++)
      if (prof[i].y >= y) {
        const t = (y - prof[i - 1].y) / (prof[i].y - prof[i - 1].y || 1);
        return prof[i - 1].x + (prof[i].x - prof[i - 1].x) * t;
      }
    return prof[prof.length - 1].x;
  };
  const yb = plateProf[0].y;
  const yt = plateProf[plateProf.length - 1].y;
  const ring = (y, a) => new THREE.Vector3(Math.sin(a) * rAt(y) * 1.015, y, Math.cos(a) * rAt(y) * 0.82 * 1.015);
  for (let k = 0; k <= 12; k++) edge.push(ring(yb, -pA + (2 * pA * k) / 12));
  for (let k = 1; k <= 6; k++) edge.push(ring(yb + ((yt - yb) * k) / 6, pA));
  for (let k = 1; k <= 12; k++) edge.push(ring(yt, pA - (2 * pA * k) / 12));
  for (let k = 1; k < 6; k++) edge.push(ring(yt - ((yt - yb) * k) / 6, -pA));
  trophy.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge, true, 'catmullrom', 0.1), 160, 0.012, 6, true), black));

  // --- lower ball resting in the cup of the base
  const lower = new THREE.Mesh(ballGeo, ballMat);
  lower.scale.setScalar(0.57);
  lower.position.set(0, 1.76, 0);
  lower.rotation.set(0.35, 0.5, 0.1);
  trophy.add(lower);

  // --- two ribbed struts rising in a V
  trophy.add(ribbedStrut(gold, [-0.52, 2.08], [-0.12, 2.1], [-1.02, 3.22], [-0.64, 3.18]));
  trophy.add(ribbedStrut(gold, [-0.02, 2.1], [0.36, 2.06], [0.12, 3.05], [0.5, 3.02]));

  // --- laurel emblem between the struts
  const emb = laurelEmblem(gold, darkMetal);
  emb.position.set(-0.2, 2.62, 0.1);
  trophy.add(emb);

  // --- upper ball under the heel of the boot
  const upper = new THREE.Mesh(ballGeo, ballMat);
  upper.scale.setScalar(0.5);
  upper.position.set(0.3, 3.36, 0.02);
  upper.rotation.set(-0.2, 1.3, 0.4);
  trophy.add(upper);

  // --- the boot, toe down to the left, sole resting on the ball and strut
  const { group: boot } = buildBoot(gold, darkMetal);
  boot.position.set(-1.3, 2.8, 0);
  boot.rotation.z = 0.585;
  trophy.add(boot);

  trophy.position.x = 0.25;
  return trophy;
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.25)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------- viewer
/** Render the trophy into `host` (a sized element). Returns a dispose function. */
export function mountTrophy(host, { autoRotate = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.innerHTML = '';
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', '3D trophy. Drag to rotate, scroll or pinch to zoom.');
  renderer.domElement.setAttribute('role', 'img');

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const key = new THREE.DirectionalLight(0xfff1d6, 2.2);
  key.position.set(-3, 6, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xd8c8ff, 1.3);
  rim.position.set(4, 3, -4);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffe6c0, 0.45);
  fill.position.set(5, 1, 3);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a002e, 0.35));

  const trophy = buildTrophy();
  scene.add(trophy);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.6), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.25, 0.002, 0);
  scene.add(shadow);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0.6, 2.7, 10);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0.1, 2.15, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 4;
  controls.maxDistance = 15;
  controls.maxPolarAngle = Math.PI * 0.82;
  controls.autoRotate = autoRotate;
  controls.autoRotateSpeed = 1.4;
  controls.update();
  let idleTimer = null;
  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    clearTimeout(idleTimer);
  });
  controls.addEventListener('end', () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (controls.autoRotate = true), 6000);
  });

  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the whole trophy in view on narrow screens
    camera.fov = w / h < 0.75 ? 38 : 30;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  let visible = true;
  const io = new IntersectionObserver((es) => (visible = es[0]?.isIntersecting ?? true));
  io.observe(host);

  renderer.setAnimationLoop(() => {
    if (!visible || !host.isConnected || document.hidden) return;
    controls.update();
    renderer.render(scene, camera);
  });

  host.addEventListener('dblclick', () => {
    camera.position.set(0.6, 2.7, 10);
    controls.target.set(0.1, 2.15, 0);
    controls.autoRotate = true;
  });

  return () => {
    renderer.setAnimationLoop(null);
    ro.disconnect();
    io.disconnect();
    controls.dispose();
    pmrem.dispose();
    renderer.dispose();
  };
}
