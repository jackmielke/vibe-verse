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

/** Remembered across visits: has this person ever actually flown it? */
const FLOWN_KEY = 'vibe.explorer.flown';

/* ============================================================================
   Teaching it.

   The report that started this was "it's not intuitive at all… we need more
   basic controls, and we need to know how to do it". The second half is this
   file's problem, and the two functions below are the whole of it. They are
   pure and exported so the thing that matters about them can be tested: what
   they do *not* say. A key row with twelve entries teaches nothing, and a
   coach line that fires while the player is already flying is noise.
   ========================================================================== */

/**
 * The four-to-six keys that matter, for the layout actually in force.
 *
 * Everything else moved to the reference panel behind `?`. The row used to
 * carry eight chips plus two conditionals — scan, autopilot, free-look, view,
 * stand, the number keys — which is a list, and nobody reads a list at the
 * bottom of a windscreen while trying to work out why the ship is spinning.
 */
export function flightHints(c) {
  const rows = c.scheme === 'sim'
    ? [['MOUSE', 'steer'], ['W/S', 'throttle'], ['A/D', 'yaw'], ['↑↓', 'pitch']]
    : [['MOUSE', 'steer'], ['W/S', 'throttle'], ['A/D', 'slide']];
  rows.push(['J', 'fold to target']);
  // Landing is the point of the game, so it is on the row the moment it is
  // possible and it says which of land, enter or invade it will be.
  if (c.canLand) rows.push(['L', c.landVerb || 'land']);
  rows.push(['?', 'all keys']);
  return rows;
}

/**
 * One line, at most, about the next thing to do.
 *
 * Ordered by what is actually blocking the player rather than by lesson
 * number. Two of the steps outlive the tutorial and are returned for ever:
 *
 * - `lock`, because a dead pointer is a state, not a lesson. Game calls
 *   exitPointerLock() whenever a panel opens, so *every* player who picks a
 *   world off the star map comes back to a mouse that does nothing, with
 *   nothing on screen to say why. That was true of experts too.
 * - `land`, because the whole game is on the far side of it and it is
 *   conditional — a player who tried L from the wrong place concluded it did
 *   not exist.
 *
 * Everything else stops once `taught` is set, which happens the first time
 * anybody folds or sets down and is remembered between visits.
 */
export function coachStep(c) {
  if (!c.flying) return null;
  if (!c.touch && !c.locked) {
    return {
      id: 'lock', sticky: true, urge: true,
      text: 'CLICK TO STEER',
      sub: 'the pointer flies the ship · ESC lets it go',
    };
  }
  if (c.canLand) {
    return {
      id: `land:${c.targetName || ''}`, urge: true,
      text: `PRESS L TO ${(c.landVerb || 'land').toUpperCase()}`,
      sub: c.targetName ? `${c.targetName.toUpperCase()} is within reach` : '',
    };
  }
  if (c.taught) return null;
  if (c.throttle < 0.12) {
    return {
      id: 'throttle',
      text: c.touch ? 'PUSH THE THROTTLE UP' : 'HOLD W TO THROTTLE UP',
      sub: c.touch ? 'the slider on the right' : 'S slows · X stops dead',
    };
  }
  if (!c.steered) {
    return {
      id: 'steer',
      text: c.touch ? 'DRAG TO STEER' : 'MOVE THE MOUSE TO STEER',
      sub: c.touch ? 'left stick flies the ship'
        : c.scheme === 'sim' ? 'A/D yaw · arrows pitch · Q/E roll'
          : 'A and D slide sideways · Q/E roll',
    };
  }
  return {
    id: 'go',
    text: c.touch ? 'FOLD TO YOUR TARGET' : 'PRESS J TO FOLD TO YOUR TARGET',
    sub: 'T picks another · 1-5 jump straight to a world · L lands',
  };
}

/**
 * The full list, behind one key, built from the layout in force so it can
 * never describe the other one. Also the only place the three settings keys
 * are written down — a control scheme nobody can find is the same as one that
 * does not exist, which is the mistake the flight row made with V and L.
 */
export function keyReference(c) {
  const fly = c.scheme === 'sim'
    ? [['A / D', 'yaw'], ['↑ ↓', 'pitch'], ['MOUSE', 'steer']]
    : [['MOUSE', 'pitch and yaw'], ['A / D', 'slide left and right'],
      ['← → ↑ ↓', 'steer without a mouse']];
  return [
    ['FLYING', [
      ['W / S', 'throttle up and down'],
      ...fly,
      ['Q / E', 'roll'],
      ['SPACE / CTRL', 'climb and drop'],
      ['SHIFT', 'boost'],
      ['X', 'full stop'],
      ['RMB / ALT', 'look around without turning'],
    ]],
    ['GETTING SOMEWHERE', [
      ['T', 'pick the next target'],
      ['G', 'autopilot to it'],
      ['J', 'fold — the fast way across a system'],
      ['L', 'land, or lift off again'],
      ['M', 'star map'],
      ['1 - 5', 'jump straight to a vibeverse world'],
      ['F', 'scan what you are looking at'],
    ]],
    ['THE SHIP', [
      ['E', 'leave or take the helm'],
      ['V', 'cockpit or chase camera'],
      ['TAB', 'codex'],
      ['N', 'page the archive terminal'],
      ['P', 'performance readout'],
    ]],
    ['CONTROLS', [
      ['O', `layout — now ${c.schemeLabel}`],
      ['Z', `flight assist — now ${c.assist ? 'ON' : 'OFF'}`],
      ['[ / ]', `steering sensitivity — now ${Math.round((c.flySens || 1) * 100)}%`],
      ['?', 'this list'],
    ]],
  ];
}

/* The coach and the reference panel are built here rather than in the page's
   markup because they are the engine's own idea of what the player needs told,
   and because a vendored fork that has to stay re-syncable should not be
   growing new nodes in the host's JSX. Same trick `cinematic()` uses for the
   bars, with the same reason for scoping the rules to `#ls-root`: the
   stylesheet is scoped to that wrapper, and anything parented to the document
   would be unstyled and would outlive the route. */
const COACH_CSS = `
#ls-root #lsCoach{position:absolute;left:50%;top:calc(18px + var(--safe-t));
  transform:translateX(-50%) translateY(-9px);pointer-events:none;text-align:center;
  padding:9px 22px 8px;max-width:min(560px,92vw);
  background:linear-gradient(180deg,rgba(6,13,20,.88),rgba(6,13,20,.52));
  border:1px solid rgba(143,228,255,.24);
  clip-path:polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,8px 100%,0 calc(100% - 8px));
  opacity:0;transition:opacity .4s ease,transform .4s cubic-bezier(.2,.8,.2,1)}
#ls-root #lsCoach.on{opacity:1;transform:translateX(-50%)}
#ls-root #lsCoach b{display:block;font-weight:400;font-size:12px;letter-spacing:.26em;
  color:#eaf8ff;text-shadow:0 2px 14px #000}
#ls-root #lsCoach i{display:block;margin-top:5px;font-style:normal;font-size:9px;
  letter-spacing:.17em;color:var(--dim)}
#ls-root #lsCoach.urge{border-color:rgba(255,196,138,.42)}
#ls-root #lsCoach.urge b{color:var(--am)}
#ls-root #lsKeys{position:absolute;left:50%;top:50%;
  transform:translate(-50%,-50%) scale(.985);pointer-events:none;
  width:min(760px,93vw);max-height:88vh;overflow:hidden;padding:18px 22px 20px;
  background:rgba(3,8,13,.94);border:1px solid rgba(143,228,255,.22);
  opacity:0;transition:opacity .2s ease,transform .2s cubic-bezier(.2,.8,.2,1)}
#ls-root #lsKeys.on{opacity:1;transform:translate(-50%,-50%)}
#ls-root #lsKeys .kt{font-size:10px;letter-spacing:.34em;color:#eaf8ff;
  padding-bottom:12px;border-bottom:1px solid rgba(143,228,255,.16);margin-bottom:13px}
#ls-root #lsKeys .kc{display:grid;grid-template-columns:repeat(auto-fit,minmax(228px,1fr));
  gap:15px 28px}
#ls-root #lsKeys h4{margin:0 0 6px;font-weight:400;font-size:8.5px;letter-spacing:.30em;
  color:var(--am)}
#ls-root #lsKeys .kr{display:flex;gap:11px;align-items:baseline;padding:2px 0;
  font-size:9.5px;letter-spacing:.13em;color:var(--dim)}
#ls-root #lsKeys .kr kbd{flex:0 0 92px;font:inherit;letter-spacing:.08em;
  color:rgba(158,234,255,.96)}
#ls-root #lsKeys .kf{margin-top:14px;font-size:8.5px;letter-spacing:.22em;color:var(--cy-d)}
@media (max-width:760px){
  #ls-root #lsKeys{padding:14px 15px 16px;font-size:11px}
  #ls-root #lsKeys .kc{gap:11px 16px;grid-template-columns:1fr}
  #ls-root #lsCoach b{font-size:10.5px;letter-spacing:.2em}
}
`;

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

    // ---- teaching state
    this._coachId = null;
    this._coachT = 0;
    /* Seconds of genuine steering input. A single frame of it is a twitch of
       the trackpad; a third of a second is somebody turning the ship. */
    this._steerT = 0;
    this._taught = readFlown();
    /* Seeded from the current value so restoring a saved scheme at boot does
       not announce itself as a change the player just made. */
    this._setRev = game.input.settingsRev;
    this._buildCoach();

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

  /**
   * The coach line and the key reference, once.
   *
   * Parented to `#hud` rather than to the wrapper, which buys two things for
   * free: the whole layer fades in with the rest of the instruments, and
   * `#hud.cine` hides it during a sequence — a tutorial line over a landing
   * shot is exactly the sort of thing the cinematic mode exists to suppress.
   * Looked up by id first, because React can hand the same markup to a second
   * HUD and two coach cards is worse than none.
   */
  _buildCoach() {
    const host = this.root || document.getElementById('ls-root') || document.body;
    if (!host) return;
    if (!document.getElementById('lsCoachCss')) {
      const s = document.createElement('style');
      s.id = 'lsCoachCss';
      s.textContent = COACH_CSS;
      host.appendChild(s);
    }
    let coach = document.getElementById('lsCoach');
    if (!coach) {
      coach = document.createElement('div');
      coach.id = 'lsCoach';
      coach.innerHTML = '<b></b><i></i>';
      host.appendChild(coach);
    }
    let keys = document.getElementById('lsKeys');
    if (!keys) {
      keys = document.createElement('div');
      keys.id = 'lsKeys';
      host.appendChild(keys);
    }
    this.el.coach = coach;
    this.el.coachText = coach.querySelector('b');
    this.el.coachSub = coach.querySelector('i');
    this.el.keys = keys;
  }

  /** The reference panel, rebuilt on open so it quotes the current settings. */
  toggleKeys(on) {
    const el = this.el.keys;
    if (!el) return;
    const want = on === undefined ? !el.classList.contains('on') : !!on;
    if (want) {
      const inp = this.game.input;
      const c = {
        scheme: inp.scheme,
        schemeLabel: (inp.schemeDef && inp.schemeDef.label) || inp.scheme,
        assist: inp.assist,
        flySens: inp.flySens,
      };
      el.innerHTML = '<div class="kt">CONTROLS</div><div class="kc">'
        + keyReference(c).map(([head, rows]) => `<div><h4>${head}</h4>`
          + rows.map(([k, v]) => `<div class="kr"><kbd>${k}</kbd>${v}</div>`).join('')
          + '</div>').join('')
        + '</div><div class="kf">? TO CLOSE</div>';
    }
    el.classList.toggle('on', want);
  }

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
    /* Which of land, enter or invade L will actually do. Landing on a
       vibeverse world is not "land", it is the door — and the contested one is
       a fight. Computed once because both the key row and the coach line say
       it, and they must never disagree. */
    const landVerb = g.target?.spec?.contested ? 'invade'
      : g.target?.spec?.worldRoute ? 'enter world' : 'land';
    // The scheme is in the key, or pressing O leaves the row describing the
    // layout you just left.
    const hintKey = `${g.mode}|${uiOpen ? 1 : 0}|${canLand ? 1 : 0}`
      + `|${g.landed ? (g.landed.onFoot ? 2 : 1) : 0}|${fighting ? 1 : 0}`
      + `|${g.input.scheme}|${landVerb}`;
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
          ['1-5', 'jump to world'], ['?', 'all keys']];
      } else {
        /* Five chips, not ten. This row carried V, F, G, RMB, E and the number
           keys as well, on the reasoning that a control nobody can find is a
           control that does not exist — which is true, and the wrong fix. Ten
           chips is a list, and the player who could not work out how to fly
           this was reading all of them and learning none. The four that get
           you moving stay; everything else is one key away behind `?`, which
           is on the row saying so. */
        keys = flightHints({ scheme: g.input.scheme, canLand, landVerb });
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

    this._updateCoach(dt, { piloting, uiOpen, canLand, landVerb });

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
   * One line of instruction, and the key that shows the rest.
   *
   * The whole of it is timing. A prompt that stays up is wallpaper the player
   * stops seeing, and a prompt that vanishes before it is read may as well not
   * have fired — so each step gets nine seconds from the moment it becomes the
   * answer, and comes back if the situation comes back. `lock` is the
   * exception and is sticky: it describes a pointer that is not captured, and
   * that is true until the player clicks, however long they take.
   */
  _updateCoach(dt, c) {
    const g = this.game;
    const inp = g.input;
    const el = this.el.coach;

    // A preference changed. Say so where the player is already looking.
    if (inp.settingsRev !== this._setRev) {
      this._setRev = inp.settingsRev;
      if (inp.settingsMsg) this.log(inp.settingsMsg, 'hi');
      // The scheme changes what the reference says, so refresh it if it is up.
      if (this.el.keys && this.el.keys.classList.contains('on')) this.toggleKeys(true);
    }
    /* `?` is Shift+Slash on most layouts and plain Slash on none of them that
       matter — the code is the same either way, so the panel answers both and
       the row can advertise the character people will actually reach for. */
    if (!c.uiOpen && inp.tappedCode('Slash')) this.toggleKeys();

    if (!el) return;

    /* Flying means the player is in a position to act on any of this: at the
       helm, off the ground, with no panel and no sequence over the top. */
    const flying = c.piloting && !c.uiOpen && !g.landed && !g.transition
      && !(g.director && g.director.active);

    // Steering, and by any means — keys, pointer, stick or pad all land here.
    if (flying && (Math.abs(inp.state.pitch) > 0.06 || Math.abs(inp.state.yaw) > 0.06)) {
      this._steerT += dt;
    }
    /* Folded once, or set down once. Either is proof the player found the way
       out of the system they started in, which is the last thing the tutorial
       has to teach, so it is also what retires it — for good, across visits. */
    if (!this._taught && (g.ship.foldMode || g.landed)) {
      this._taught = true;
      writeFlown();
    }

    const step = coachStep({
      flying,
      /* `touch`, not `hasTouch`. hasTouch is a capability — a laptop with a
         touchscreen has it and is still being flown with a mouse, and telling
         *that* player nothing about their dead pointer is the exact failure
         this line exists to fix. `touch` is the latch Input sets the first
         time a finger actually lands, which on a handset is the tap on WAKE. */
      touch: !!inp.touch,
      locked: !!inp.locked,
      throttle: g.ship.throttle || 0,
      steered: this._steerT > 0.35,
      scheme: inp.scheme,
      taught: this._taught,
      canLand: c.canLand,
      landVerb: c.landVerb,
      targetName: g.target && g.target.name,
    });

    const id = step ? step.id : null;
    if (id !== this._coachId) {
      this._coachId = id;
      this._coachT = 0;
      if (step) {
        this.el.coachText.textContent = step.text;
        this.el.coachSub.textContent = step.sub || '';
        el.classList.toggle('urge', !!step.urge);
      }
    }
    if (!step) { el.classList.remove('on'); return; }
    this._coachT += dt;
    el.classList.toggle('on', !!step.sticky || this._coachT < 9);
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
    /* The right stick is gone from everything except flight, where it is still
       roll and throttle trim. Looking around is a swipe now — see
       Input._initSwipeLook — so on foot the stick did nothing but sit in the
       corner of a phone screen implying it did. */
    const sr = document.getElementById('stickR');
    if (sr) sr.style.display = (walk || ground) ? 'none' : '';
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

/* Both wrapped: Safari in private mode throws on either call, and a tutorial
   that cannot remember it already ran is a far smaller problem than a HUD that
   throws every frame. Failing to read means the prompts run again, which is
   the safe direction to fail in. */
function readFlown() {
  try { return window.localStorage && window.localStorage.getItem(FLOWN_KEY) === '1'; }
  catch (e) { return false; }
}
function writeFlown() {
  try { window.localStorage && window.localStorage.setItem(FLOWN_KEY, '1'); }
  catch (e) { /* nothing to do about it and nothing lost */ }
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
