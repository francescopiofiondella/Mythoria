'use strict';
// Terrafrante - giocatore: movimento, stato, equipaggiamento, scavo, costruzione, armi
(function (TF) {
  const TS = TF.TS, T = TF.T, TILES = TF.TILES, ITEMS = TF.ITEMS, P = TF.Physics, C = TF.Combat;
  const REACH = 6.5;

  class Player {
    constructor() {
      this.w = 12; this.h = 24; this.reset();
    }
    reset() {
      this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.facing = 1; this.onGround = false; this.animT = 0;
      this.maxhp = 100; this.hp = 100; this.maxmana = 40; this.mana = 40; this.manaDelay = 0;
      this.invT = 0; this.flash = 0; this.dead = false; this.deathT = 0; this.sinceHurt = 999;
      this.buffs = { speed: 0, mining: 0, iron: 0, sick: 0 };
      this.fx = {}; this.defense = 0; this.look = {}; this.lookVer = -1;
      this.swing = null; this.useT = 0; this.mine = null; this.fallStart = -1; this.jumpHeld = 0; this.jumpPrev = false;
      this.dj = false; this.wingT = 0; this.flying = false; this.coyote = 0; this.breath = 600; this.hazT = 0; this.regenAcc = 0;
      this.spawn = null; this.pickRange = 56; this.light = 150; this.depthTile = 0; this.rmbLock = false; this.msgCd = 0;
      this.stats = { kills: 0, blocks: 0, deaths: 0, bosses: {} };
    }
    get cx() { return this.x + this.w / 2; }
    get cy() { return this.y + this.h / 2; }

    place(G, tx, ty) { this.x = tx * TS + 2; this.y = ty * TS - this.h + TS; this.vx = this.vy = 0; this.fallStart = -1; }

    // ---- equipaggiamento -> statistiche ----
    recalc(G) {
      const inv = G.inv, fx = { speed: 0, jump: 0, mine: 0, def: 0, regen: 0, mana: 0, light: 0, wings: 0, thorns: 0, dj: 0, kbImmune: 0, lavaImm: 0 };
      let def = 0; const sets = {}, look = {};
      for (const k of ['head', 'body', 'legs']) {
        const s = inv.eq[k]; if (!s) continue; const it = ITEMS[s.id];
        def += it.def; look[k === 'body' ? 'body' : k] = it.col; sets[it.set] = (sets[it.set] || 0) + 1; this.setB = it.setBonus;
        if (sets[it.set] === 3) def += it.setBonus;
      }
      for (const k of ['acc0', 'acc1', 'acc2']) { const s = inv.eq[k]; if (!s) continue; const f = ITEMS[s.id].fx; for (const n in f) fx[n] = n === 'wings' ? Math.max(fx[n], f[n]) : fx[n] + f[n]; }
      this.fx = fx; this.defense = def + fx.def; this.look = look; this.light = 150 + fx.light;
      const base = 40 + (this.maxmanaBonus || 0);
      this.maxmana = base + fx.mana; this.mana = Math.min(this.mana, this.maxmana);
      this.lookVer = inv.ver;
    }
    totalDef() { return this.defense + (this.buffs.iron > 0 ? 8 : 0); }

    heal(n, quiet) { const a = Math.min(n, this.maxhp - this.hp); if (a <= 0) return; this.hp += a; if (!quiet) C.text(this.cx, this.y - 6, '+' + a, '#6af08a'); }
    hazardHit(G, dmg) {
      if (this.invT > 0 || this.dead) return;
      this.hp -= dmg; this.invT = 30; this.flash = 30; this.sinceHurt = 0; C.text(this.cx, this.y - 6, dmg, '#ff7a3a'); G.audio.play('hurt');
      if (this.hp <= 0) this.die(G);
    }
    die(G) {
      if (this.dead) return; this.dead = true; this.hp = 0; this.deathT = 0; this.stats.deaths++;
      G.particles.burst(this.cx, this.cy, '#c03030', 24, 3); G.audio.play('death');
      G.enemyMgr.bossRetreat(G); G.ui.showDeath(true);
    }
    respawn(G) {
      const s = this.spawn || G.world.spawn; let ty = s.y;
      while (ty > 2 && P.rectSolid(G.world, s.x * TS, ty * TS - this.h, this.w, this.h)) ty--;
      while (ty < G.world.h - 3 && !P.rectSolid(G.world, s.x * TS, ty * TS + 1, this.w, 1)) ty++;
      this.place(G, s.x, ty - 1); this.y = ty * TS - this.h;
      this.dead = false; this.hp = this.maxhp; this.mana = this.maxmana; this.invT = 120; this.flash = 0; this.breath = 600;
      for (const k in this.buffs) this.buffs[k] = 0;
      G.camera.snap(this); G.ui.showDeath(false);
    }

    // ---- aggiornamento ----
    update(G) {
      if (this.lookVer !== G.inv.ver) this.recalc(G);
      const inp = G.input, k = inp.keys, w = G.world;
      if (this.dead) { this.deathT++; this.vy = Math.min(this.vy + 0.4, 10); P.move(this, w, {}); return; }
      if (this.invT > 0) this.invT--; if (this.flash > 0) this.flash--; if (this.useT > 0) this.useT--; if (this.msgCd > 0) this.msgCd--;
      this.sinceHurt++;
      for (const b in this.buffs) if (this.buffs[b] > 0) this.buffs[b]--;
      const left = k.has('KeyA') || k.has('ArrowLeft'), right = k.has('KeyD') || k.has('ArrowRight');
      const up = k.has('Space') || k.has('KeyW') || k.has('ArrowUp'), down = k.has('KeyS') || k.has('ArrowDown');
      const env = P.env(this, w);
      const inWater = env.water > 0.45, inLava = env.lava > 0.3, climbing = env.climb && !inWater;
      const spd = (2.5 * (1 + this.fx.speed + (this.buffs.speed > 0 ? 0.3 : 0))) * (inWater ? 0.62 : 1) * (env.web ? 0.35 : 1) * (inLava ? 0.5 : 1);
      const accel = this.onGround ? 0.28 : 0.16;
      const ui = G.ui.blocking;
      let dirx = 0; if (!ui) { dirx = (right ? 1 : 0) - (left ? 1 : 0); }
      if (dirx) { this.vx += dirx * accel; if (Math.abs(this.vx) > spd) this.vx = TF.lerp(this.vx, dirx * spd, 0.35); if (!this.swing) this.facing = dirx; }
      else this.vx *= this.onGround ? 0.78 : 0.94;
      if (Math.abs(this.vx) < 0.03) this.vx = 0;
      // salto / nuoto / scale / ali
      const jumpPress = up && !this.jumpPrev && !ui; this.jumpPrev = up; const wantUp = up && !ui;
      if (this.onGround) { this.coyote = 6; this.dj = this.fx.dj > 0; this.wingT = this.fx.wings; this.flying = false; } else if (this.coyote > 0) this.coyote--;
      this.flying = false;
      if (climbing && (wantUp || (down && !ui))) { this.vy = wantUp ? -2.1 : 2.1; this.fallStart = -1; }
      else if (inWater) {
        this.vy += 0.12; if (this.vy > 2.4) this.vy = 2.4;
        if (wantUp) this.vy = Math.max(this.vy - 0.5, -2.6);
        this.fallStart = -1;
      } else {
        let g = P.GRAV;
        if (this.vy < 0 && wantUp && this.jumpHeld < 18) { g *= 0.5; this.jumpHeld++; }
        if (climbing) { this.vy = Math.min(this.vy + 0.05, 1); } else this.vy = Math.min(this.vy + g, P.MAXFALL);
        if (env.web) this.vy = Math.min(this.vy, 1.2);
        if (jumpPress && (this.coyote > 0)) { this.vy = -(6.1 + this.fx.jump * 0.6); this.coyote = 0; this.jumpHeld = 0; this.fallStart = -1; G.audio.play('jump'); }
        else if (jumpPress && this.dj && !this.onGround) { this.vy = -6.3; this.dj = false; this.jumpHeld = 20; G.particles.burst(this.cx, this.y + this.h, '#e8f4ff', 8, 1.4); G.audio.play('jump'); }
        else if (wantUp && this.fx.wings > 0 && !this.onGround && this.wingT > 0 && (this.vy > -0.5 || this.jumpHeld >= 18)) { this.vy = Math.max(this.vy - 0.62, -3.4); this.wingT--; this.flying = true; if (this.animT % 6 === 0) G.particles.spark(this.cx, this.y + 14, '#8a6bff'); }
      }
      if (this.onGround) this.jumpHeld = 0;
      this.drop = down && !ui;
      // lava e pericoli
      if (inLava && !this.fx.lavaImm) { this.hazT++; if (this.hazT % 20 === 1) this.hazardHit(G, 22); }
      else if (env.hurt) { this.hazT++; if (this.hazT % 20 === 1) this.hazardHit(G, env.hurt); }
      else this.hazT = 0;
      // respiro
      if (env.head) { this.breath--; if (this.breath < 0) { this.breath = 0; if (this.animT % 25 === 0) this.hazardHit(G, 8); } } else this.breath = Math.min(600, this.breath + 12);
      // movimento fisico
      const landV = P.move(this, w, { step: dirx !== 0 && !this.swing });
      if (this.vy > 1 && !this.onGround && this.fallStart < 0) this.fallStart = this.y;
      if (this.onGround && this.fallStart >= 0) {
        const dist = (this.y - this.fallStart) / TS; this.fallStart = -1;
        if (dist > 16 && !inWater && landV > 5) { const d = Math.round((dist - 16) * 5); this.hp -= d; this.flash = 20; this.invT = 20; C.text(this.cx, this.y - 6, d, '#ff7a3a'); G.audio.play('hurt'); G.camera.shake(5); if (this.hp <= 0) this.die(G); }
        else if (landV > 4) G.particles.burst(this.cx, this.y + this.h, '#a89880', 4, 0.8);
      }
      if (this.onGround && landV > 3) G.audio.play('land');
      this.animT++;
      // rigenerazione
      this.regenAcc += (this.sinceHurt > 240 ? 0.012 : 0.003) + this.fx.regen / 60 * 1;
      if (this.regenAcc >= 1) { const n = Math.floor(this.regenAcc); this.regenAcc -= n; this.heal(n, true); }
      if (this.manaDelay > 0) this.manaDelay--; else this.mana = Math.min(this.maxmana, this.mana + 0.16);
      if (this.swing) { this.swing.t--; if (this.swing.t <= 0) this.swing = null; else this.updateSwing(G); }
      this.depthTile = Math.floor(this.cy / TS);
      if (!ui) this.updateUse(G); else { this.mine = null; }
    }

    // ---- strumenti ----
    findTool(inv, type) {
      const held = inv.selected(); if (held && ITEMS[held.id].type === type) return ITEMS[held.id];
      let best = null; for (const s of inv.slots) if (s) { const it = ITEMS[s.id]; if (it.type === type && (!best || it.power > best.power)) best = it; }
      return best;
    }
    cursorTile(G) { const m = G.input.mouse; return [Math.floor(m.wx / TS), Math.floor(m.wy / TS)]; }
    inReach(tx, ty) { const dx = tx * TS + 8 - this.cx, dy = ty * TS + 8 - this.cy; return Math.hypot(dx, dy) <= REACH * TS; }
    say(G, msg) { if (this.msgCd <= 0) { G.ui.toast(msg); this.msgCd = 60; } }

    updateUse(G) {
      const m = G.input.mouse, inv = G.inv, w = G.world;
      const held = inv.selected(), it = held ? ITEMS[held.id] : null, [tx, ty] = this.cursorTile(G);
      const aimDir = m.wx < this.cx ? -1 : 1;
      const RB = m.right || m.rightPulse, LB = m.left || m.leftPulse; m.rightPulse = m.leftPulse = false;
      // --- tasto destro: interazione / piazzamento ---
      if (RB) {
        const id = w.get(tx, ty), t = TILES[id];
        if (!this.rmbLock && t.interact && this.inReach(tx, ty)) { this.interact(G, tx, ty); this.rmbLock = true; }
        else if (it && (it.type === 'block' || it.type === 'wall') && this.useT <= 0) { if (this.tryPlace(G, tx, ty, it)) this.useT = 6; }
        else if (!this.rmbLock && it && ['potion', 'perm', 'summon'].includes(it.type)) { this.consume(G, it); this.rmbLock = true; }
        else if (!this.rmbLock && t.station) { G.ui.openInventory(); this.rmbLock = true; }
      } else this.rmbLock = false;
      // --- tasto sinistro: attacco / scavo / uso ---
      if (!LB) { if (this.mine) this.mine = null; this.mineLock = false; return; }
      if (it && ['sword', 'bow', 'staff'].includes(it.type)) { this.mine = null; this.attack(G, it, aimDir); return; }
      if (it && ['potion', 'perm', 'summon'].includes(it.type)) { if (!this.leftLock) { this.consume(G, it); } this.leftLock = true; return; }
      this.leftLock = true;
      this.mineTarget(G, tx, ty, it, aimDir);
    }
    mineTarget(G, tx, ty, it, aimDir) {
      const w = G.world, id = w.get(tx, ty), t = TILES[id], reach = this.inReach(tx, ty);
      let type = null, wallId = 0;
      if (id !== 0 && !(t.liquid)) type = t.tool === 'any' ? 'any' : t.tool;
      else { wallId = w.getWall(tx, ty); if (wallId) type = 'hammer'; }
      if (!type || !reach) {
        this.mine = null;
        if (it && ['pick', 'axe', 'hammer'].includes(it.type)) this.attack(G, it, aimDir, true);
        return;
      }
      let tool, power;
      if (type === 'any') { const p = this.findTool(G.inv, 'pick'); tool = p; power = p ? p.power : 15; }
      else if (type === 'hammer') { tool = this.findTool(G.inv, 'hammer'); power = tool ? tool.power : 0; }
      else { tool = this.findTool(G.inv, type); power = tool ? tool.power : (type === 'axe' ? 12 : 12); }
      const hard = wallId ? 3 : t.hard, min = wallId ? 0 : t.min;
      if (!wallId && hard === Infinity) { this.mine = null; return; }
      if (power <= 0) { this.mine = null; this.say(G, 'Serve un martello per le pareti'); return; }
      if (power < min) { this.mine = null; this.say(G, 'Piccone troppo debole: serve potenza ' + min); return; }
      const key = tx + ',' + ty + (wallId ? 'w' : '');
      if (!this.mine || this.mine.key !== key) this.mine = { key, tx, ty, prog: 0, wall: wallId };
      const speed = (power * 0.1) * (1 + this.fx.mine + (this.buffs.mining > 0 ? 0.4 : 0));
      this.mine.prog += (speed / hard) / 60;
      // animazione del colpo
      if (!this.swing || this.swing.mineOnly) { if (!this.swing) { this.swing = { t: 16, dur: 16, angle: -1.2, mineOnly: true, icon: tool ? S().icon(tool.id) : null, rot: Math.PI / 4 }; this.facing = aimDir; } }
      if (this.animT % 8 === 0) { G.particles.chip(tx * TS + 8, ty * TS + 8, wallId ? TF.WALLS[wallId].c : (t.tx.b || '#888')); G.audio.play('dig', 0.5); }
      if (this.mine.prog >= 1) { if (wallId) this.breakWall(G, tx, ty); else this.breakTile(G, tx, ty); this.mine = null; }
    }
    // ---- rottura e piazzamento blocchi ----
    breakWall(G, tx, ty) {
      const w = G.world, wl = TF.WALLS[w.getWall(tx, ty)]; w.setWall(tx, ty, 0);
      C.drop(G, wl.itemId, 1, tx * TS + 8, ty * TS + 8); G.particles.chip(tx * TS + 8, ty * TS + 8, wl.c); this.stats.blocks++;
    }
    breakTile(G, tx, ty) {
      const w = G.world, id = w.get(tx, ty), t = TILES[id];
      if (id === 0) return;
      if (t.interact === 'chest') {
        const ch = w.chestAt(tx, ty);
        if (ch && ch.slots.some(Boolean)) { this.say(G, 'Svuota prima lo scrigno'); return; }
        w.chests.delete(tx + ',' + ty);
      }
      const chain = (tid, dy) => { let y = ty; while (w.get(tx, y) === tid) { this.removeTile(G, tx, y, true); y += dy; } };
      if (t.key.startsWith('TRUNK')) { chain(id, -1); this.clearLeaves(G, tx, ty); this.afterBreak(G, tx, ty); return; }
      if (t.key === 'CACTUS') { chain(id, -1); this.afterBreak(G, tx, ty); return; }
      if (t.interact === 'door') { const o = id === T.DOOR_C ? T.DOOR_O : T.DOOR_C; for (const d of [-1, 1]) if (w.get(tx, ty + d) === id || w.get(tx, ty + d) === o) this.removeTile(G, tx, ty + d, true); }
      this.removeTile(G, tx, ty, true); this.afterBreak(G, tx, ty);
    }
    removeTile(G, tx, ty, drop) {
      const w = G.world, id = w.get(tx, ty), t = TILES[id]; if (id === 0) return;
      if (drop && t.drop) { const q = t.key === 'CACTUS' ? 1 : 1; C.drop(G, t.drop, q, tx * TS + 8, ty * TS + 8); }
      G.particles.chip(tx * TS + 8, ty * TS + 8, t.tx.b || (t.col && t.col[0]) || '#888'); G.audio.play('break', 0.6);
      w.set(tx, ty, 0); this.stats.blocks++;
    }
    afterBreak(G, tx, ty) { // decorazioni che perdono il supporto
      const w = G.world;
      let y = ty - 1; while (TILES[w.get(tx, y)].needsFloor && !w.solid(tx, y + 1)) { this.removeTile(G, tx, y, true); y--; }
      y = ty + 1; while (TILES[w.get(tx, y)].needsCeil) { this.removeTile(G, tx, y, true); y++; }
      for (const d of [-1, 1]) if (TILES[w.get(tx + d, ty)].needsFloor && !w.solid(tx + d, ty + 1)) this.removeTile(G, tx + d, ty, true);
    }
    clearLeaves(G, tx, ty) {
      const w = G.world, LEAVES = [T.LEAF, T.PINE, T.JLEAF, T.SLEAF, T.CLEAF, T.VINE];
      let top = ty; while (TILES[w.get(tx, top - 1)].key.startsWith('TRUNK')) top--;
      for (let dy = -7; dy <= 6; dy++) for (let dx = -7; dx <= 7; dx++) { const x = tx + dx, y = top + dy; if (LEAVES.includes(w.get(x, y)) && y <= ty) w.set(x, y, 0); }
    }
    tryPlace(G, tx, ty, it) {
      const w = G.world; if (!this.inReach(tx, ty) || !w.inb(tx, ty)) return false;
      const cur = TILES[w.get(tx, ty)];
      const replace = (t) => t.id === 0 || (!t.solid && t.hard <= 0.5 && !t.interact && !t.station && !t.light);
      const near = (x, y) => w.get(x - 1, y) || w.get(x + 1, y) || w.get(x, y - 1) || w.get(x, y + 1) || w.getWall(x, y);
      if (it.type === 'wall') {
        if (w.getWall(tx, ty) || cur.solid) return false;
        if (!(near(tx, ty) || w.getWall(tx - 1, ty) || w.getWall(tx + 1, ty) || w.getWall(tx, ty - 1) || w.getWall(tx, ty + 1))) return false;
        w.setWall(tx, ty, it.wall); G.inv.consumeSel(1); G.audio.play('place'); return true;
      }
      const t = TILES[it.tile];
      if (!replace(cur)) return false;
      if (!near(tx, ty)) return false;
      if (t.interact === 'door' && !replace(TILES[w.get(tx, ty - 1)])) return false;
      if (t.solid && !t.plat) {
        if (TF.rectsOverlap(tx * TS, ty * TS, TS, TS, this.x, this.y, this.w, this.h)) return false;
        for (const e of G.enemies) if (TF.rectsOverlap(tx * TS, ty * TS, TS, TS, e.x, e.y, e.w, e.h)) return false;
      }
      if (t.light > 0 && t.id !== T.TORCH && cur.id !== 0) return false;
      if (t.interact === 'chest') w.makeChest(tx, ty);
      w.set(tx, ty, it.tile); if (t.interact === 'door') w.set(tx, ty - 1, it.tile);
      G.inv.consumeSel(1); G.audio.play('place'); G.particles.chip(tx * TS + 8, ty * TS + 8, t.tx.b || '#aaa'); return true;
    }
    interact(G, tx, ty) {
      const w = G.world, id = w.get(tx, ty), t = TILES[id];
      if (t.interact === 'door') {
        const toOpen = id === T.DOOR_C, nid = toOpen ? T.DOOR_O : T.DOOR_C, ys = [ty];
        for (let y = ty - 1; TILES[w.get(tx, y)].interact === 'door'; y--) ys.push(y);
        for (let y = ty + 1; TILES[w.get(tx, y)].interact === 'door'; y++) ys.push(y);
        const top = Math.min(...ys), bot = Math.max(...ys);
        if (!toOpen && TF.rectsOverlap(tx * TS, top * TS, TS, (bot - top + 1) * TS, this.x, this.y, this.w, this.h)) { this.say(G, 'Qualcosa blocca la porta'); return; }
        for (const y of ys) w.set(tx, y, nid);
        G.audio.play('door');
      } else if (t.interact === 'chest') { G.ui.openChest(w.chestAt(tx, ty) || w.makeChest(tx, ty)); G.audio.play('chest'); }
      else if (t.interact === 'bed') { this.spawn = { x: tx, y: ty }; G.ui.toast('Punto di rinascita impostato'); G.particles.burst(tx * TS + 8, ty * TS, '#ff8aa0', 10, 1.5); G.audio.play('pick'); }
    }
    consume(G, it) {
      if (this.useT > 0) return; const inv = G.inv;
      if (it.type === 'potion') {
        if (it.sick && this.buffs.sick > 0) { this.say(G, 'Malessere da pozione: attendi'); return; }
        if (it.heal) { if (this.hp >= this.maxhp) { this.say(G, 'Vita già al massimo'); return; } this.heal(it.heal); this.buffs.sick = 45 * 60; }
        if (it.mana) { if (this.mana >= this.maxmana) { this.say(G, 'Mana già al massimo'); return; } this.mana = Math.min(this.maxmana, this.mana + it.mana); }
        if (it.buff) this.buffs[it.buff[0]] = it.buff[1] * 60;
        G.audio.play('drink'); inv.consumeSel(1); this.useT = 20;
      } else if (it.type === 'perm') {
        if (it.maxhp) { if (this.maxhp >= 500) { this.say(G, 'Vita massima raggiunta'); return; } this.maxhp += it.maxhp; this.hp += it.maxhp; G.ui.toast('Vita massima +' + it.maxhp); }
        if (it.maxmana) { if ((this.maxmanaBonus || 0) >= 160) { this.say(G, 'Mana massimo raggiunto'); return; } this.maxmanaBonus = (this.maxmanaBonus || 0) + it.maxmana; this.lookVer = -1; this.mana += it.maxmana; G.ui.toast('Mana massimo +' + it.maxmana); }
        G.audio.play('powerup'); inv.consumeSel(1); this.useT = 30; G.particles.burst(this.cx, this.cy, '#ffd84a', 16, 2);
      } else if (it.type === 'summon') {
        if (G.enemyMgr.bossAlive()) { this.say(G, 'Un boss è già presente'); return; }
        G.enemyMgr.spawnBoss(G, it.boss); inv.consumeSel(1); this.useT = 30;
      }
    }

    // ---- combattimento ----
    attack(G, it, aimDir, toolOnly) {
      if (this.useT > 0 || this.swing && !this.swing.mineOnly) return;
      const m = G.input.mouse, inv = G.inv;
      this.facing = aimDir;
      const sx = this.cx, sy = this.y + 10;
      const ang = Math.atan2(m.wy - sy, m.wx - sx);
      if (it.type === 'sword' || toolOnly) {
        this.useT = it.spd; this.swing = { t: it.spd, dur: it.spd, angle: -1.5, hit: new Set(), item: it, icon: S().icon(it.id), rot: Math.PI / 4, melee: true, len: it.len || 22 };
        G.audio.play('swing');
        if (it.wave) { const sp = 7; C.proj({ kind: 'wave', x: sx + Math.cos(ang) * 12, y: sy + Math.sin(ang) * 12, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, dmg: it.dmg * it.wave, kb: 3, life: 40, pierce: 4, w: 10, h: 14, col: it.col[0], trail: it.col[0] }); }
      } else if (it.type === 'bow') {
        const ammo = inv.slots.find((s) => s && ITEMS[s.id].type === 'ammo');
        if (!ammo) { this.say(G, 'Servono delle frecce'); return; }
        const adm = ITEMS[ammo.id].dmg; inv.remove(ammo.id, 1);
        this.useT = it.spd; this.swing = { t: Math.min(it.spd, 14), dur: 14, angle: Math.atan2(m.wy - sy, (m.wx - sx) * aimDir), icon: S().icon(it.id), rot: Math.PI / 4 + 0.5, aim: true };
        const n = it.multi || 1;
        for (let i = 0; i < n; i++) { const a = ang + (n > 1 ? (i - (n - 1) / 2) * 0.14 : 0); C.proj({ kind: 'arrow', x: sx, y: sy, vx: Math.cos(a) * it.vel, vy: Math.sin(a) * it.vel, dmg: it.dmg + adm, kb: it.kb, life: 100, grav: 0.07, pierce: it.pierce || 1, w: 6, h: 6 }); }
        G.audio.play('bow');
      } else if (it.type === 'staff') {
        if (this.mana < it.mana) { this.say(G, 'Mana insufficiente'); return; }
        this.mana -= it.mana; this.manaDelay = 50;
        this.useT = it.spd; this.swing = { t: Math.min(it.spd, 14), dur: 14, angle: Math.atan2(m.wy - sy, (m.wx - sx) * aimDir), icon: S().icon(it.id), rot: Math.PI / 4 + 0.4, aim: true };
        const n = it.multi || 1, k = it.proj;
        for (let i = 0; i < n; i++) {
          const a = ang + (n > 1 ? (i - (n - 1) / 2) * 0.2 : 0), sp = k === 'fire' ? 6.5 : k === 'spark' ? 8 : 7;
          const o = { kind: k, x: sx + Math.cos(a) * 10, y: sy + Math.sin(a) * 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, dmg: it.dmg, kb: it.kb, life: 70, trail: k === 'spark' ? '#8fe6ff' : k === 'frost' ? '#bfeaff' : k === 'spore' ? '#b6f060' : k === 'shadow' ? '#a45fe0' : '#ff9a3c', w: 8, h: 8 };
          if (k === 'frost') o.slow = true; if (k === 'spore') { o.homing = 0.06; o.poison = true; o.life = 90; } if (k === 'shadow') { o.homing = 0.1; o.life = 100; } if (k === 'fire') { o.explode = 30; o.big = true; o.life = 80; }
          C.proj(o);
        }
        G.audio.play('magic');
      }
    }
    updateSwing(G) {
      const s = this.swing;
      if (s.mineOnly) s.angle = TF.lerp(-1.5, 0.9, 1 - s.t / s.dur);
      if (s.melee) {
        const p = 1 - s.t / s.dur; s.angle = TF.lerp(-1.6, 1.0, p);
        const it = s.item, len = s.len + 4, sx = this.cx, sy = this.y + 10, f = this.facing;
        const dmg = it.dmg * (1 + (this.fx.melee || 0));
        for (const e of G.enemies) {
          if (e.dead || s.hit.has(e)) continue;
          for (const d of [0.4, 0.7, 1]) {
            const px = sx + f * Math.cos(s.angle) * len * d, py = sy + Math.sin(s.angle) * len * d;
            if (TF.hits(e, px - 4, py - 4, 8, 8)) { s.hit.add(e); C.hitEnemy(G, e, dmg, f, it.kb, { slow: it.slow, poison: it.poison, lifesteal: it.lifesteal }); break; }
          }
        }
      }
    }
  }
  const S = () => TF.Sprites;
  TF.Player = Player;
})(window.TF);
