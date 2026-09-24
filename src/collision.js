// ===== Static collision world (2D, XZ plane) =====
const CS = 40;
export class StaticWorld {
  constructor() { this.grid = new Map(); this.list = []; this.stamp = 0; }
  _key(i, j) { return i * 73856 + j; }
  _insert(c, minx, minz, maxx, maxz) {
    c.stamp = 0;
    this.list.push(c);
    for (let i = Math.floor(minx / CS); i <= Math.floor(maxx / CS); i++)
      for (let j = Math.floor(minz / CS); j <= Math.floor(maxz / CS); j++) {
        const k = this._key(i, j);
        let a = this.grid.get(k); if (!a) this.grid.set(k, (a = [])); a.push(c);
      }
  }
  addBox(minx, minz, maxx, maxz, tag = 'wall') { const c = { t: 0, minx, minz, maxx, maxz, tag }; this._insert(c, minx, minz, maxx, maxz); return c; }
  addCircle(x, z, r, tag = 'tree') { const c = { t: 1, x, z, r, tag }; this._insert(c, x - r, z - r, x + r, z + r); return c; }
  addSeg(ax, az, bx, bz, tag = 'rail') { const c = { t: 2, ax, az, bx, bz, tag }; this._insert(c, Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)); return c; }

  // Resolve a circle against static geometry. Returns deepest contact or null. Writes push into res.
  collide(x, z, r, res) {
    this.stamp++;
    let px = 0, pz = 0, hit = false, maxD = 0, nx = 0, nz = 0, tag = null;
    const i0 = Math.floor((x - r) / CS), i1 = Math.floor((x + r) / CS);
    const j0 = Math.floor((z - r) / CS), j1 = Math.floor((z + r) / CS);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = this.grid.get(this._key(i, j)); if (!a) continue;
      for (const c of a) {
        if (c.stamp === this.stamp) continue; c.stamp = this.stamp;
        let dx, dz, d, depth;
        if (c.t === 0) {
          const cx = x < c.minx ? c.minx : x > c.maxx ? c.maxx : x;
          const cz = z < c.minz ? c.minz : z > c.maxz ? c.maxz : z;
          dx = x - cx; dz = z - cz; d = Math.hypot(dx, dz);
          if (d === 0) {
            // inside box: push out along smallest axis
            const l = x - c.minx, rr = c.maxx - x, t = z - c.minz, b = c.maxz - z;
            const m = Math.min(l, rr, t, b);
            if (m === l) { dx = -1; dz = 0; depth = l + r; } else if (m === rr) { dx = 1; dz = 0; depth = rr + r; }
            else if (m === t) { dx = 0; dz = -1; depth = t + r; } else { dx = 0; dz = 1; depth = b + r; }
            d = 1;
          } else { if (d >= r) continue; depth = r - d; }
        } else if (c.t === 1) {
          dx = x - c.x; dz = z - c.z; d = Math.hypot(dx, dz);
          if (d >= r + c.r || d === 0) continue; depth = r + c.r - d;
        } else {
          const sx = c.bx - c.ax, sz = c.bz - c.az; const l2 = sx * sx + sz * sz;
          let t = ((x - c.ax) * sx + (z - c.az) * sz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          dx = x - (c.ax + sx * t); dz = z - (c.az + sz * t); d = Math.hypot(dx, dz);
          if (d >= r + 0.2 || d === 0) continue; depth = r + 0.2 - d;
        }
        const ux = dx / d, uz = dz / d;
        px += ux * depth; pz += uz * depth; hit = true;
        if (depth > maxD) { maxD = depth; nx = ux; nz = uz; tag = c.tag; }
      }
    }
    if (!hit) return null;
    res.px = px; res.pz = pz; res.nx = nx; res.nz = nz; res.depth = maxD; res.tag = tag;
    return res;
  }

  // line of sight: true if no box blocks segment
  los(ax, az, bx, bz) {
    this.stamp++;
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(len / (CS * 0.5));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const a = this.grid.get(this._key(Math.floor(x / CS), Math.floor(z / CS)));
      if (!a) continue;
      for (const c of a) {
        if (c.t !== 0 || c.stamp === this.stamp) continue; c.stamp = this.stamp;
        if (segBox(ax, az, bx, bz, c)) return false;
      }
    }
    return true;
  }
}

function segBox(ax, az, bx, bz, c) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const p = [-dx, dx, -dz, dz];
  const q = [ax - c.minx, c.maxx - ax, az - c.minz, c.maxz - az];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; }
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return true;
}
