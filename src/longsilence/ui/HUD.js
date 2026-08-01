import * as THREE from 'three-ls';

/* ============================================================================
   The screen-space layer.

   Almost everything that used to live here now lives on the dashboard, in the
   world, where a pilot would actually read it. What is left is the handful of
   things that are not physical objects: what you are looking at, what you were
   just told, and what you can reach.

   The directive was the last holdout. It was a centred card drawn over the
   canopy spar — an overlay occluding the structure it was supposedly mounted
   behind — and it is now an annunciator strip on the glareshield, which the
   structure can occlude in turn. Nothing here should ever be an instrument.
   ========================================================================== */

const _v = new THREE.Vector3();

export class HUD {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('hud');
    this.el = {
      reticle: document.getElementById('reticle'),
      rArc: document.getElementById('rArc'),
      markers: document.getElementById('markers'),
      log: document.getElementById('log'),
      narr: document.getElementById('narrText'),
      prompt: document.getElementById('prompt'),
      promptKey: document.getElementById('promptKey'),
      promptLabel: document.getElementById('promptLabel'),
      promptHint: document.getElementById('promptHint'),
      hints: document.getElementById('hints'),
      fold: document.getElementById('foldOverlay'),
      foldSub: document.getElementById('foldSub'),
      perf: document.getElementById('perf'),
      touchUI: document.getElementById('touchUI'),
      combat: document.getElementById('combat'),
    };

    this.markerPool = new Map();
    this.logs = [];
    this._narrTimer = 0;
    this._lastMode = null;

    document.querySelectorAll('[data-close]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.dataset.close;
        if (id === 'codex') game.codex.close();
        if (id === 'starmap') game.starmap.close();
      });
    });

    if (game.input.hasTouch) this.el.touchUI.classList.remove('hidden');
  }

  show() { this.root.classList.remove('hidden'); requestAnimationFrame(() => this.root.classList.add('on')); }

  onSystemChange() {
    for (const [, m] of this.markerPool) m.el.remove();
    this.markerPool.clear();
  }

  refreshTargets() { }

  log(text, cls = '') {
    const d = document.createElement('div');
    d.className = 'lg ' + cls;
    d.textContent = text;
    this.el.log.appendChild(d);
    this.logs.push({ el: d, t: 0 });
    while (this.logs.length > 4) { const o = this.logs.shift(); o.el.remove(); }
    setTimeout(() => d.classList.add('out'), 6000);
  }

  narrate(text, who) {
    this.el.narr.innerHTML = (who ? `<span class="who">${who}</span>` : '') + text;
    this.el.narr.classList.add('on');
    this._narrTimer = 7.5;
  }

  /**
   * Cinematic mode. Bars and a title card, and every diegetic overlay hidden —
   * during a sequence the frame belongs to the camera, not to the instruments.
   */
  cinematic(on, title, sub) {
    if (!this._cine) {
      const d = document.createElement('div');
      d.id = 'cine';
      d.innerHTML = '<div class="bar top"></div><div class="bar bot"></div>'
        + '<div class="card"><div class="ttl"></div><div class="sub"></div></div>';
      // Inside the wrapper, not on the body: the stylesheet is scoped to
      // `#ls-root`, and a cinematic bar parented to the document would be
      // unstyled and would outlive the route.
      (document.getElementById('ls-root') || document.body).appendChild(d);
      this._cine = d;
    }
    this._cine.classList.toggle('on', !!on);
    this.root.classList.toggle('cine', !!on);
    if (on) {
      this._cine.querySelector('.ttl').textContent = title || '';
      this._cine.querySelector('.sub').textContent = sub || '';
      this._cine.querySelector('.card').classList.remove('on');
      requestAnimationFrame(() => this._cine.querySelector('.card').classList.add('on'));
    }
  }

  setFold(on) { this.el.fold.classList.toggle('on', on); }
  setFlash(v) { this.game.setFlash(v); }

  /* ------------------------------------------------------------- frame */

  update(dt) {
    const g = this.game;
    const piloting = g.mode === 'pilot' || g.mode === 'exterior';
    const uiOpen = g.starmap.open || g.codex.open;

    /* ---- reticle
       Flying, or fighting. It is the same crosshair and it means the same
       thing both times — where the thing you press the button on will go —
       and standing in a firefight without one is the single fastest way to
       make a shooter feel broken. */
    const aiming = !!(g.battle && g.landed && g.landed.onFoot);
    this.el.reticle.classList.toggle('hidden', (!piloting && !aiming) || uiOpen);
    this.el.reticle.classList.toggle('aim', aiming);
    const p = g.scanProgress || 0;
    this.el.rArc.setAttribute('d', p > 0.001 ? arcPath(60, 60, 21, -90, -90 + p * 360) : '');

    // ---- interaction prompt
    const st = g.mode === 'walk' ? g.player.station : null;
    const showPrompt = !uiOpen && (st || g.mode === 'pilot');
    this.el.prompt.classList.toggle('hidden', !showPrompt);
    if (showPrompt) {
      const key = g.input.hasTouch ? 'USE' : 'E';
      this.el.promptKey.textContent = key;
      if (g.mode === 'pilot') {
        this.el.promptLabel.textContent = 'LEAVE THE HELM';
        this.el.promptHint.textContent = '';
      } else {
        this.el.promptLabel.textContent = st.label;
        this.el.promptHint.textContent = st.hint || '';
      }
    }

    // ---- contextual control hints
    /* Contextual keys.

       This used to key on `mode` alone, and opening a panel does not change
       mode — so the star map could take the frame, block every movement key,
       and leave this row still reading "WASD move". The map *is* escapable:
       Escape closes it and always did. But nothing on screen said so, and a
       control nobody can find is the same as a control that does not exist.
       Someone testing the build reported being trapped in it.

       Landing had the mirror problem. L lands, and L has never appeared here —
       it is also conditional, since `canLand` wants a solid world inside 2.6
       radii, so a player pressing every key in turn from the wrong place would
       conclude it is not possible. It shows up when it is actually available,
       and says which of land or lift off it will do. */
    const canLand = !!(!g.landed && g.canLand && g.canLand());
    const fighting = !!g.battle;
    const hintKey = `${g.mode}|${uiOpen ? 1 : 0}|${canLand ? 1 : 0}`
      + `|${g.landed ? (g.landed.onFoot ? 2 : 1) : 0}|${fighting ? 1 : 0}`;
    if (this._hintKey !== hintKey) {
      const wasLand = this._canLand;
      this._hintKey = hintKey;
      this._lastMode = g.mode;
      this._canLand = canLand;
      let keys;
      if (uiOpen) {
        keys = [['ESC', 'close'], ['J', 'fold to target']];
      } else if (g.landed) {
        /* The ground has its own controls and used to borrow the flight row,
           which advertised a throttle, a scanner and an autopilot to somebody
           standing on a planet. */
        keys = g.landed.onFoot
          ? (fighting
            ? [['WASD', 'walk'], ['LMB', 'fire'], ['SHIFT', 'run'], ['E', 'board'], ['L', 'lift off']]
            : [['WASD', 'walk'], ['MOUSE', 'look'], ['SHIFT', 'run'], ['E', 'board'], ['L', 'lift off']])
          : [['E', fighting ? 'take the field' : 'step out'], ['L', 'lift off'], ['TAB', 'archive']];
      } else if (g.mode === 'walk') {
        keys = [['WASD', 'move'], ['MOUSE', 'look'], ['E', 'use'], ['SHIFT', 'run'],
          ['V', 'outside view'], ['1-5', 'jump to world']];
      } else {
        /* V has always existed and has never been on this row, which is most of
           why the view "changed by itself" — the only other things that move it
           are sitting down and standing up. And free-look is quoted with the
           mouse button first: Alt is a modifier the window manager may eat, the
           right button is not, and both have always been wired to it. */
        keys = [['MOUSE', 'fly'], ['W/S', 'throttle'], ['F', 'scan'], ['G', 'autopilot'],
          ['J', 'fold'], ['RMB', 'look'], ['V', g.mode === 'exterior' ? 'cockpit' : 'chase cam'],
          ['E', 'stand']];
        // Landing on a vibeverse world is not "land", it is the door. Say so on
        // the key row, because that row is where a player looks to find out
        // what they can do next.
        if (canLand) {
          keys.push(['L', g.target?.spec?.contested ? 'invade'
            : g.target?.spec?.worldRoute ? 'enter world' : 'land']);
        }
        // The fast path, and it belongs on the row rather than in a manual
        // nobody reads: one key per world, no chart.
        keys.push(['1-5', 'jump to world']);
      }
      this.el.hints.innerHTML = keys.map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`).join('');
      this._syncTouchLabels();
      // The row is small and at the bottom edge. Coming into range of a world
      // you can actually set down on is worth saying out loud, once.
      if (canLand && !wasLand && g.target) {
        this.log(
          g.target.spec?.worldRoute
            ? `${g.target.name.toUpperCase()} · LAND TO ENTER · L`
            : `LANDING AVAILABLE · ${g.target.name.toUpperCase()} · L`,
          g.target.spec?.worldRoute ? 'hi' : 'ok');
      }
    }

    this._updateCombat();

    // ---- fold banner
    if (g.ship.foldMode) {
      const t = g.target;
      /* Mid-hyperjump the target is a body in the system being left behind, and
         quoting a range to it while the tunnel is up is nonsense. Name the
         destination instead — it is the only thing the player cares about for
         the two and a half seconds this is on screen. */
      this.el.foldSub.textContent = g._jumpDest
        ? `${g._jumpDest.toUpperCase()}  ·  INTERSTELLAR`
        : t
          ? `${t.name.toUpperCase()}  ·  ${fmtDist(t.absPos.distanceTo(g.ship.absPos))}` : '';
    }

    // ---- timers
    if (this._narrTimer > 0) {
      this._narrTimer -= dt;
      if (this._narrTimer <= 0) this.el.narr.classList.remove('on');
    }
    this._updateMarkers(piloting && !uiOpen);

    if (this.el.perf.classList.contains('on')) {
      this.el.perf.textContent =
        `${g.engine.fps.toFixed(0)} fps  ${g.engine.pixelRatio.toFixed(2)}x  q=${g.quality}  ${g.mode}\n` +
        `draws ${g.engine.drawCalls}  tris ${(g.engine.triangles / 1000).toFixed(0)}k`;
    }
  }

  /**
   * The scoreboard, and it only exists while there is a fight.
   *
   * Two numbers and a health bar. Not four numbers and a minimap: the whole
   * read the player needs from a firefight is "am I winning" and "am I about to
   * die", and everything else is on the field in front of them, in blue or red.
   */
  _updateCombat() {
    const el = this.el.combat;
    if (!el) return;
    const B = this.game.battle;
    if (!B) {
      if (this._combatOn) { el.classList.remove('on'); this._combatOn = false; }
      return;
    }
    if (!this._combatOn) { el.classList.add('on'); this._combatOn = true; }

    const c = B.counts();
    const hp = Math.max(0, Math.round(B.playerHp));
    // Rebuilt only when something changed. This runs every frame on the ground
    // and innerHTML is not free.
    const key = `${c.ally}|${c.enemy}|${c.kills}|${hp}|${c.over || ''}`;
    if (this._combatKey === key) return;
    this._combatKey = key;
    el.innerHTML =
      `<div class="cb-row"><b class="cb-blue">${c.ally}</b><em>ALLIED</em>`
      + `<span class="cb-vs">·</span><b class="cb-red">${c.enemy}</b><em>HOSTILE</em></div>`
      + `<div class="cb-bar"><i style="width:${hp}%"></i></div>`
      + `<div class="cb-foot">${c.over === 'won' ? 'SITE HELD'
        : c.over === 'lost' ? 'LINE BROKEN' : `KILLS ${c.kills}`}</div>`;
    el.classList.toggle('won', c.over === 'won');
    el.classList.toggle('lost', c.over === 'lost');
  }

  _syncTouchLabels() {
    const g = this.game;
    const walk = g.mode === 'walk';
    /* Three label sets now, not two. The ground used to borrow the flight row,
       which on a phone meant a landed player had a SCAN button, an AUTO button,
       a FOLD button and no way whatsoever to take off again — L is a key, and a
       phone has no keys. FIRE is on the row for the same reason. */
    const ground = !!g.landed;
    const map = ground
      ? (g.landed.onFoot
        ? { use: 'BOARD', boost: 'RUN', scan: g.battle ? 'FIRE' : 'MAP', auto: 'ARC', fold: 'LIFT' }
        : { use: 'STEP OUT', boost: 'RUN', scan: 'MAP', auto: 'ARC', fold: 'LIFT' })
      : walk
        ? { use: 'USE', boost: 'RUN', scan: 'MAP', auto: 'ARC', fold: 'VIEW' }
        : { use: 'STAND', boost: 'BOOST', scan: 'SCAN', auto: 'AUTO', fold: 'FOLD' };
    document.querySelectorAll('#touchBtns .tb').forEach((b) => {
      const t = map[b.dataset.act];
      if (t) b.textContent = t;
    });
    const thr = document.getElementById('touchThr');
    if (thr) thr.style.display = (walk || ground) ? 'none' : '';
  }

  _updateMarkers(active) {
    const g = this.game;
    if (!active) {
      for (const [, m] of this.markerPool) m.el.style.display = 'none';
      return;
    }
    const cam = g.camera;
    const seen = new Set();
    const bodies = g.bodies.slice()
      .sort((a, b) => a.absPos.distanceToSquared(g.ship.absPos) - b.absPos.distanceToSquared(g.ship.absPos))
      .slice(0, 10);

    // Screen-space declutter. Bodies arrive sorted near-to-far, so the first
    // one to claim a patch of canopy keeps it and anything landing on top of it
    // is dropped — two labels overlapping is worse than one label missing.
    const placed = [];
    const MIN_SEP = 46;
    /* The cabin is drawn over the world in its own pass, so a marker composited
       on top of the frame sits on top of the *room* as well — the review caught
       one label lying across the centre MFD, interleaved with the MFD's own
       type, and another over the left MFD and the throttle. Ask the cabin
       whether the ray actually leaves through the glazing. Only in the cockpit:
       in exterior view there is no room in the way. */
    const cabin = (g.mode !== 'exterior' && g.interior && g.interior.seesSky)
      ? g.interior : null;

    for (const b of bodies) {
      _v.copy(b.absPos).sub(g.origin);
      const dist = _v.distanceTo(cam.position);
      _v.project(cam);
      const onScreen = _v.z < 1 && Math.abs(_v.x) < 0.98 && Math.abs(_v.y) < 0.92;
      const angular = 2 * Math.atan((b.radius || 1) / Math.max(dist, 1));
      if (!onScreen || angular > 0.5) continue;
      if (cabin && !cabin.seesSky(_v.x, _v.y, g.interiorCam)) continue;

      const sx = (_v.x * 0.5 + 0.5) * innerWidth;
      const sy = (-_v.y * 0.5 + 0.5) * innerHeight;
      let crowded = false;
      for (const q of placed) {
        if (Math.abs(q.x - sx) < MIN_SEP && Math.abs(q.y - sy) < MIN_SEP) { crowded = true; break; }
      }
      if (crowded && b !== g.target) continue;
      placed.push({ x: sx, y: sy });

      seen.add(b.id);
      let m = this.markerPool.get(b.id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'mk';
        el.innerHTML = `<svg viewBox="0 0 28 28">
            <path class="mk-br" d="M4 10V4h6M18 4h6v6M24 18v6h-6M10 24H4v-6"/>
            <circle cx="14" cy="14" r="1.5" class="mk-dot"/>
          </svg>
          <div class="mk-lbl"><span></span><em></em></div>`;
        this.el.markers.appendChild(el);
        m = { el, name: el.querySelector('span'), sub: el.querySelector('em') };
        this.markerPool.set(b.id, m);
      }
      m.el.style.display = '';
      m.el.style.transform = `translate(${sx}px, ${sy}px)`;
      // Authored worlds are marked by key, not by route: the contested one has
      // no route and is still very much one of ours.
      const isWorld = !!b.spec?.worldKey;
      const hostile = !!b.spec?.contested;
      m.el.className = 'mk'
        + (b.kind === 'anomaly' ? ' anom' : '')
        + (isWorld ? ' world' : '')
        + (hostile ? ' hostile' : '')
        + (b.scanned ? ' scanned' : '')
        + (b === g.target ? ' sel' : '');
      if (m._n !== b.name) { m.name.textContent = b.name; m._n = b.name; }
      /* A world that leads somewhere says so under its name instead of just its
         range. Everything else out here is scenery; these are doors, and from a
         hundred thousand kilometres they look identical to scenery. The one you
         cannot walk into says the other thing, which is what it is for. */
      m.sub.textContent = hostile
        ? `${fmtDist(dist)} · CONTESTED`
        : isWorld ? `${fmtDist(dist)} · VIBEVERSE WORLD` : fmtDist(dist);
    }
    for (const [id, m] of this.markerPool) if (!seen.has(id)) m.el.style.display = 'none';
  }
}

export function fmtDist(d) {
  if (d < 1) return `${Math.round(d * 1000)} m`;
  if (d < 1000) return `${d.toFixed(1)} km`;
  if (d < 1e6) return `${(d / 1000).toFixed(1)} Mm`;
  return `${(d / 149597870).toFixed(4)} AU`;
}

function arcPath(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}
