import * as THREE from 'three-ls';

/* ============================================================================
   Unified input: keyboard + mouse-as-stick, gamepad, and touch sticks.
   Everything funnels into one normalised state object the flight model reads,
   so no downstream code cares which device is driving.
   ========================================================================== */

const KEYMAP = {
  KeyW: 'thrUp', KeyS: 'thrDn',
  KeyA: 'yawL', KeyD: 'yawR',
  KeyQ: 'rollL', KeyE: 'rollR',
  /* The arrows are a *fallback*, and `turnL/turnR` exist so they can be.
     ArrowLeft used to be `yawL` — the same action A is bound to — which meant
     the two could never mean different things. They have to: under the simple
     scheme A and D slide the ship sideways, and losing keyboard yaw with them
     would leave a player with a dead trackpad no way to turn at all. So the
     arrows keep their own names, always steer, and nothing essential is on
     them because the pointer does the same job better. */
  ArrowUp: 'pitchU', ArrowDown: 'pitchD', ArrowLeft: 'turnL', ArrowRight: 'turnR',
  Space: 'up', ControlLeft: 'down', KeyC: 'down',
  ShiftLeft: 'boost', ShiftRight: 'boost',
  KeyF: 'scan', KeyJ: 'fold', KeyX: 'stop',
  KeyR: 'align', KeyV: 'view', KeyT: 'target',
  AltLeft: 'look', AltRight: 'look',
};

/* ============================================================================
   Control schemes.

   The layout this shipped with is a six-degree-of-freedom sim: throttle on
   W/S, yaw on A/D, and *pitch on the arrow keys*. That asks a laptop pilot to
   steer with both hands at opposite ends of the keyboard, and the report that
   started this was exactly that — "not intuitive at all", nobody could work
   out how to fly it.

   So there are two, and the one that a laptop can actually do is the default:

   - `simple`  — one hand on WASD, one on the pointer. The pointer pitches and
     yaws; A and D become translation, which is what they are for in every
     browser space game. Nothing needed to fly is on the arrow keys.
   - `sim`     — the original. A and D yaw, the arrows pitch, six axes under
     your fingers. Kept whole, because the people who like it are not wrong.

   The three tuning numbers ride on the scheme rather than on the class,
   because they are the scheme: the pointer is a *virtual stick* (see
   feedStick), and how far a flick throws it, how fast it springs back and how
   much slop sits at the centre is the entire difference between "this flies
   like a mouse" and "this drifts".
   ========================================================================== */
export const SCHEMES = {
  simple: {
    id: 'simple',
    label: 'SIMPLE',
    /* A and D are translation, not rotation. */
    strafeAD: true,
    /* Half again as much throw per pixel as the sim layout. A trackpad has
       about a third of the travel a mouse does before the finger runs out of
       glass, and at 0.0022 a full swipe across one barely reached half stick. */
    sensitivity: 0.0034,
    /* Springs back in about a third of a second, so letting go of the pointer
       stops the turn. At the sim layout's 0.85/s a hard turn is still a third
       of itself a second later, which is the "it keeps going" complaint. */
    autoCenter: 2.6,
    /* Slop at the centre, and it is here for the trackpad. A resting finger on
       a trackpad still emits a pixel or two a second; without a deadzone the
       ship yaws very slowly forever and the player cannot tell why. */
    deadzone: 0.12,
    /* Full throttle in a little over half a second rather than 1.1 s. Held
       against a ship that takes seconds to change speed, a slow throttle reads
       as an unresponsive one. */
    throttleRate: 1.9,
  },
  sim: {
    id: 'sim',
    label: 'SIM · 6DOF',
    strafeAD: false,
    sensitivity: 0.0022,
    autoCenter: 0.85,
    deadzone: 0,
    throttleRate: 1,
  },
};

export const DEFAULT_SCHEME = 'simple';

/** Where the control preferences live between visits. */
export const PREFS_KEY = 'vibe.explorer.controls';

/**
 * The same four keys, named for the other thing they do.
 *
 * KEYMAP is a *ship* keymap: W is the throttle, A and D are the rate stick.
 * The on-foot controller reuses those keys, so for years it asked for 'thrUp'
 * to mean walk-forward and 'yawL' to mean strafe-left. That reads as a bug
 * every time and invites the real one — somebody rebinding a walk key and
 * silently moving the throttle with it, or adding a foot binding to KEYMAP and
 * finding it flies the ship.
 *
 * So the foot names are real names that `held()` resolves back to the ship
 * action underneath. One key set, one source of truth, and the split is visible
 * at both call sites. Nothing here changes what the flight model sees.
 */
export const FOOT_ALIAS = {
  walkF: 'thrUp', walkB: 'thrDn',
  walkL: 'yawL', walkR: 'yawR',
  sprint: 'boost',
};

/* How long after a touch a mouse event is still assumed to be that touch's
   compatibility click rather than a real mouse. Chrome synthesises those
   within ~300 ms of touchend; 800 ms covers the slow cases with margin. */
const TOUCH_SETTLE_MS = 800;

/* Scratch for the deadzoned stick. One per module: Input.update is the only
   caller and it is not re-entrant. */
const _axes = { x: 0, y: 0 };

export class Input {
  constructor(dom) {
    this.dom = dom;
    this.keys = new Set();
    this.pressed = new Set();
    this.stick = new THREE.Vector2(0, 0);
    /* Set by _applyScheme, which runs before anything can read them. Listed
       here anyway so the shape of an Input is readable in one place. */
    this.sensitivity = 0;
    this.autoCenter = 0;
    this.deadzone = 0;
    this.throttleRate = 1;
    /** Player gain on top of the scheme's own, adjustable in flight. */
    this.flySens = 1;
    /** Flight assist: auto-level and extra damping. Ship.update reads it. */
    this.assist = true;
    this.scheme = DEFAULT_SCHEME;
    /* Bumped whenever a preference changes, with a line to show for it. The
       HUD watches the counter rather than taking a callback, so nothing here
       needs to know a HUD exists. */
    this.settingsRev = 0;
    this.settingsMsg = '';
    this._applyScheme(SCHEMES[DEFAULT_SCHEME]);
    this.locked = false;
    this.touch = false;
    this._touchAt = 0;                  // ms of the last finger down/up
    this.touchL = new THREE.Vector2();
    this.touchR = new THREE.Vector2();
    this.touchBtn = new Set();
    this.touchTapped = new Set();
    this.invertY = false;
    this.uiOpen = false;
    this.lookSens = 1;
    /** Screen pixels of swipe per pixel of look. See _initSwipeLook. */
    this.touchLookSens = 1.6;
    // raw pointer deltas, consumed once per frame by the first-person camera
    this._mdx = 0; this._mdy = 0;

    this.state = {
      pitch: 0, yaw: 0, roll: 0,
      throttleDelta: 0, strafeX: 0, strafeY: 0,
      boost: 0, assist: this.assist,
    };

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const a = KEYMAP[e.code];
      if (a) { this.keys.add(a); this.pressed.add(a); }
      /* Slash joins the list for Firefox, where `/` opens quick-find and steals
         every keystroke after it from the ship. Safe to swallow for the same
         reason Tab and Space already are: while this route is mounted there is
         nothing on the page to type into. */
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Slash'].includes(e.code)) e.preventDefault();
      this.pressed.add('code:' + e.code);
    };
    this._onKeyUp = (e) => { const a = KEYMAP[e.code]; if (a) this.keys.delete(a); };
    /* Everything the window can be holding down, not just the keys. Alt-tabbing
       away mid-burst used to leave `lmb` true — no mouseup ever arrives, because
       the release happened in another window — and the rifle went on firing for
       as long as the tab was in the background. The stick goes too: it is a rate
       and a rate with nobody's hand on it is a ship that turns while you are
       reading your email. */
    this._onBlur = () => {
      this.keys.clear();
      this.touchBtn.clear();
      this.lmb = false; this.rmb = false;
      this.stick.set(0, 0);
      this._mdx = 0; this._mdy = 0;
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);

    // --------------------------------------------------------- mouse stick
    this._onMouseDown = (e) => {
      if (this.uiOpen) return;
      /* `touch` latches for the session and stays latched here. Downstream it
         means far more than "no mouse" — Game picks the look branch off it, the
         throttle and the walk read `touchL`/`touchR` off it — so un-latching it
         from a mouse click would take the on-screen sticks away mid-session on
         a Surface or an iPad with a trackpad.

         What the latch must NOT do is veto pointer lock, and it did: on a
         laptop with a touchscreen that someone poked once, lock could never be
         requested again and look was dead for the rest of the visit. That is
         exactly the symptom the on-foot camera was reported with. So the gate
         is narrower than the latch — only a press inside the settle window is
         refused, because that one really is the touch's own compatibility
         click. A press outside it is a mouse, and a mouse gets the pointer. */
      if (this.touch && Date.now() - (this._touchAt || 0) < TOUCH_SETTLE_MS) return;
      /* Left button does one of two things depending on whether the pointer is
         already captured. The click that *takes* the lock must not also fire a
         weapon — that click was aimed at a browser chrome-covered canvas the
         player could not see through, and shooting on it would mean every
         return-to-tab put a round downrange. */
      if (e.button === 0) {
        if (!this.locked && dom.requestPointerLock) this.requestLock();
        else { this.pressed.add('fire'); this.lmb = true; }
      }
      if (e.button === 2) { this.pressed.add('scanClick'); this.rmb = true; }
    };
    this._onContextMenu = (e) => e.preventDefault();
    this._onWheel = (e) => {
      this._wheel = (this._wheel || 0) + Math.sign(e.deltaY);
      e.preventDefault();
    };
    dom.addEventListener('mousedown', this._onMouseDown);
    dom.addEventListener('contextmenu', this._onContextMenu);
    dom.addEventListener('wheel', this._onWheel, { passive: false });
    /* Every listener this class installs is held and removed in dispose(). The
       canvas ones used to be anonymous on the assumption that a canvas dies with
       its route; React disproves that — see the note in dispose(). */
    this._onMouseUp = (e) => {
      if (e.button === 2) this.rmb = false;
      if (e.button === 0) this.lmb = false;
    };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === dom;
      /* Esc releases the pointer without ever sending a mouseup, so a button
         held at that moment stays held forever. Losing the lock is the release. */
      if (!this.locked) { this.lmb = false; this.rmb = false; }
    };
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this._mdx += e.movementX;
      this._mdy += e.movementY * (this.invertY ? -1 : 1);
    };
    window.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('mousemove', this._onMouseMove);

    this._initTouch();
    this._loadPrefs();
  }

  /* ------------------------------------------------------------ preferences

     Controls are the one setting a player changes once and expects to keep.
     `localStorage` rather than a query string or a table: this route can be
     opened offline and signed out, and a control scheme is not worth a network
     round trip. Every access is wrapped — Safari in private mode throws on
     `getItem`, and a thrown preference should not take the ship down with it. */

  _applyScheme(s) {
    this.scheme = s.id;
    this.sensitivity = s.sensitivity;
    this.autoCenter = s.autoCenter;
    this.deadzone = s.deadzone;
    this.throttleRate = s.throttleRate;
  }

  /** The scheme object currently in force, never undefined. */
  get schemeDef() { return SCHEMES[this.scheme] || SCHEMES[DEFAULT_SCHEME]; }

  /**
   * Switch layouts. `quiet` is for the load path, which is restoring a choice
   * rather than announcing one.
   */
  setScheme(id, quiet) {
    const s = SCHEMES[id] || SCHEMES[DEFAULT_SCHEME];
    this._applyScheme(s);
    /* The virtual stick carries a deflection in the old scheme's units and
       under the old scheme's deadzone. Handing that across is a ship that
       turns on its own for a second after the switch. */
    this.stick.set(0, 0);
    if (!quiet) this._note(`CONTROLS · ${s.label}`);
    this._savePrefs();
  }

  setFlySens(v, quiet) {
    // Below about a third the ship stops answering a trackpad; above three a
    // mouse twitch is a barrel roll.
    this.flySens = THREE.MathUtils.clamp(v, 0.35, 3);
    if (!quiet) this._note(`STEERING · ${Math.round(this.flySens * 100)}%`);
    this._savePrefs();
  }

  setAssist(on, quiet) {
    this.assist = !!on;
    if (!quiet) this._note(`FLIGHT ASSIST · ${this.assist ? 'ON' : 'OFF'}`);
    this._savePrefs();
  }

  _note(msg) { this.settingsMsg = msg; this.settingsRev++; }

  _loadPrefs() {
    let raw = null;
    try { raw = window.localStorage && window.localStorage.getItem(PREFS_KEY); } catch (e) { return; }
    if (!raw) return;
    let p = null;
    try { p = JSON.parse(raw); } catch (e) { return; }
    if (!p || typeof p !== 'object') return;
    if (SCHEMES[p.scheme]) this.setScheme(p.scheme, true);
    if (Number.isFinite(p.flySens)) this.setFlySens(p.flySens, true);
    if (typeof p.assist === 'boolean') this.setAssist(p.assist, true);
    if (typeof p.invertY === 'boolean') this.invertY = p.invertY;
  }

  _savePrefs() {
    try {
      window.localStorage && window.localStorage.setItem(PREFS_KEY, JSON.stringify({
        scheme: this.scheme, flySens: this.flySens,
        assist: this.assist, invertY: this.invertY,
      }));
    } catch (e) { /* private mode, or a full quota: not worth failing over */ }
  }

  /**
   * The keys that change how the ship flies rather than where it goes.
   *
   * Handled here rather than in Game because Input owns every one of the
   * values they move, and because a control scheme has to be reachable from
   * inside the cockpit — a player who cannot fly it is not going to find a
   * settings menu behind a route change.
   */
  _settingsKeys() {
    if (this.tappedCode('KeyO')) this.setScheme(this.scheme === 'simple' ? 'sim' : 'simple');
    if (this.tappedCode('KeyZ')) this.setAssist(!this.assist);
    // Both are consumed every frame on purpose: reading one and skipping the
    // other would leave a stale press to fire on some later frame.
    const up = this.tappedCode('BracketRight');
    const dn = this.tappedCode('BracketLeft');
    if (up !== dn) this.setFlySens(this.flySens * (up ? 1.25 : 1 / 1.25));
  }

  _initTouch() {
    const coarse = window.matchMedia('(hover: none)').matches || 'ontouchstart' in window;
    this.hasTouch = coarse;

    const setup = (el, vec) => {
      if (!el) return;
      let id = null; const origin = new THREE.Vector2();
      const knob = el.querySelector('i');
      const R = 44;
      const start = (e) => {
        const t = e.changedTouches[0];
        id = t.identifier;
        const r = el.getBoundingClientRect();
        origin.set(r.left + r.width / 2, r.top + r.height / 2);
        el.classList.add('act');
        this.touch = true;
        move(e);
      };
      const move = (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier !== id) continue;
          let dx = (t.clientX - origin.x) / R;
          let dy = (t.clientY - origin.y) / R;
          const l = Math.hypot(dx, dy);
          if (l > 1) { dx /= l; dy /= l; }
          vec.set(dx, dy);
          if (knob) knob.style.transform = `translate(${dx * R}px, ${dy * R}px)`;
        }
        e.preventDefault();
      };
      const end = (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier !== id) continue;
          id = null; vec.set(0, 0);
          el.classList.remove('act');
          if (knob) knob.style.transform = '';
        }
      };
      el.addEventListener('touchstart', start, { passive: false });
      el.addEventListener('touchmove', move, { passive: false });
      el.addEventListener('touchend', end);
      el.addEventListener('touchcancel', end);
    };

    setup(document.getElementById('stickL'), this.touchL);
    setup(document.getElementById('stickR'), this.touchR);
    this._initSwipeLook();

    document.querySelectorAll('#touchBtns .tb, #touchThr .tt').forEach((b) => {
      const act = b.dataset.act;
      b.addEventListener('touchstart', (e) => {
        this.touch = true;
        this.touchBtn.add(act); this.touchTapped.add(act);
        b.classList.add('on'); e.preventDefault();
      }, { passive: false });
      const off = () => { this.touchBtn.delete(act); b.classList.remove('on'); };
      b.addEventListener('touchend', off);
      b.addEventListener('touchcancel', off);
      // mouse fallback so the touch UI is testable on desktop
      b.addEventListener('mousedown', (e) => {
        this.touchBtn.add(act); this.touchTapped.add(act); b.classList.add('on'); e.preventDefault();
      });
      b.addEventListener('mouseup', off);
      b.addEventListener('mouseleave', off);
    });

    /* One place that records "a finger was on the glass, and when". Capture
       phase on window, so it sees the touch whichever control it lands on —
       the sticks and the buttons stop propagation of nothing, but the swipe
       handler is on the canvas and the stick handlers are on their own nodes,
       and this has to be true for all of them. touchend matters as much as
       touchstart: the browser's compatibility mousedown arrives *after* the
       release, and a long press would otherwise look like a mouse. */
    this._onAnyTouch = () => { this.touch = true; this._touchAt = Date.now(); };
    for (const t of ['touchstart', 'touchend', 'touchcancel']) {
      window.addEventListener(t, this._onAnyTouch, { passive: true, capture: true });
    }
  }

  /**
   * Swipe anywhere to look.
   *
   * The right stick used to be the camera, and a stick is the wrong instrument
   * for it: a stick is a *rate* — hold it over and the view keeps turning — so
   * aiming at something meant pushing, guessing when to let go, and correcting.
   * A swipe is a *displacement*. Drag your thumb an inch and the world turns an
   * inch. It is what every phone game that involves looking at something
   * settled on, and it is the difference between aiming and steering.
   *
   * Bound to the canvas rather than to the window, which is the whole trick.
   * `#hud` is `pointer-events:none` and the controls inside `#touchUI` are
   * `auto`, so a touch that starts on the left stick or a button targets that
   * control and never reaches here — while a touch anywhere else falls through
   * to the canvas underneath. Touch events also stay with the element they
   * started on, so a thumb that begins on open sky and wanders across the
   * stick keeps turning the camera instead of hijacking the walk.
   *
   * The deltas go into the same `_mdx/_mdy` the mouse writes to. Downstream
   * there is then exactly one look path for both, which is the only reason
   * this is twenty lines instead of a second one to keep in step.
   */
  _initSwipeLook() {
    const dom = this.dom;
    if (!dom || !dom.addEventListener) return;
    let id = null;
    let lx = 0, ly = 0;

    this._onSwipeStart = (e) => {
      if (this.uiOpen || id !== null) return;
      const t = e.changedTouches[0];
      if (!t) return;
      this.touch = true;
      id = t.identifier;
      lx = t.clientX; ly = t.clientY;
      /* Not prevented. A touch on the canvas is also how the pointer-lock
         click and the archive's own taps arrive, and swallowing the start
         would break both — only the *move* is ours. */
    };
    this._onSwipeMove = (e) => {
      if (id === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier !== id) continue;
        /* A little quicker than the mouse. A thumb has about a third of the
           travel a mouse does before it runs out of screen, and 1.6 puts a
           comfortable swipe at roughly a ninety-degree turn. */
        this._mdx += (t.clientX - lx) * this.touchLookSens;
        this._mdy += (t.clientY - ly) * this.touchLookSens * (this.invertY ? -1 : 1);
        lx = t.clientX; ly = t.clientY;
        // Now it is ours: stop the page rubber-banding under the ship.
        if (e.cancelable) e.preventDefault();
      }
    };
    this._onSwipeEnd = (e) => {
      for (const t of e.changedTouches) if (t.identifier === id) id = null;
    };

    dom.addEventListener('touchstart', this._onSwipeStart, { passive: true });
    dom.addEventListener('touchmove', this._onSwipeMove, { passive: false });
    dom.addEventListener('touchend', this._onSwipeEnd, { passive: true });
    dom.addEventListener('touchcancel', this._onSwipeEnd, { passive: true });
  }

  /* One-shot presses stay queued until something consumes them. Clearing the
     queue at the end of update() dropped any tap that landed between the input
     poll and the game's own check — which is most of them. */

  /**
   * Take the pointer, and survive being told no.
   *
   * Chrome refuses a lock request for about a second after the player left one
   * with Esc, and since 113 the refusal arrives as a rejected promise rather
   * than an event — unhandled, it is a red console error on a perfectly normal
   * "Esc, then click back in". `locked` stays false either way, so the next
   * click simply tries again, which is the behaviour you want anyway.
   */
  requestLock() {
    const dom = this.dom;
    if (!dom || !dom.requestPointerLock || this.locked) return;
    try {
      const r = dom.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) { /* older browsers throw instead; same outcome */ }
  }

  /** Drop every listener this class put on window or document. */
  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('mousemove', this._onMouseMove);
    for (const t of ['touchstart', 'touchend', 'touchcancel']) {
      window.removeEventListener(t, this._onAnyTouch, { capture: true });
    }
    /* The canvas ones too, even though the canvas normally dies with the route.
       React can hand the same node to a second Game — a StrictMode double mount
       does exactly that — and two live swipe handlers on one canvas is a camera
       that turns twice as far as your thumb, which reads as a broken game
       rather than as a leak. The mouse ones are here for the same reason and
       were not: a disposed Input still holding the canvas's mousedown goes on
       requesting pointer lock — it never sees a pointerlockchange again, so its
       `locked` is false forever and every click it handles is spent asking for a
       lock the live Input already holds. */
    const dom = this.dom;
    if (dom && dom.removeEventListener) {
      dom.removeEventListener('touchstart', this._onSwipeStart);
      dom.removeEventListener('touchmove', this._onSwipeMove);
      dom.removeEventListener('touchend', this._onSwipeEnd);
      dom.removeEventListener('touchcancel', this._onSwipeEnd);
      dom.removeEventListener('mousedown', this._onMouseDown);
      dom.removeEventListener('contextmenu', this._onContextMenu);
      dom.removeEventListener('wheel', this._onWheel);
    }
    this.locked = false;
    this.lmb = false; this.rmb = false;
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  /** Consume a one-shot press. */
  tapped(action) {
    if (this.pressed.has(action)) { this.pressed.delete(action); return true; }
    if (this.touchTapped.has(action)) { this.touchTapped.delete(action); return true; }
    return false;
  }
  tappedCode(code) {
    const k = 'code:' + code;
    if (this.pressed.has(k)) { this.pressed.delete(k); return true; }
    return false;
  }
  /** True while `action` is down, under either its ship name or its foot name. */
  held(action) {
    if (this.keys.has(action) || this.touchBtn.has(action)) return true;
    const ship = FOOT_ALIAS[action];
    return ship !== undefined && (this.keys.has(ship) || this.touchBtn.has(ship));
  }

  wheel() { const w = this._wheel || 0; this._wheel = 0; return w; }

  /** Push a pointer delta into the flight stick. */
  feedStick(dx, dy) {
    const g = this.sensitivity * this.flySens;
    this.stick.x += dx * g;
    this.stick.y += dy * g;
    const l = this.stick.length();
    if (l > 1) this.stick.multiplyScalar(1 / l);
  }

  /**
   * The virtual stick as the flight model should see it: centred slop removed
   * and the rest stretched back out over the full throw.
   *
   * Without this a trackpad is unflyable. A finger resting on one still emits
   * a pixel or two a second, which lands as a permanent fraction of a degree
   * per second of yaw — far too small to see and far too large to ignore over
   * a minute of flight, with nothing on screen to explain it. Rescaling rather
   * than subtracting matters as much: a plain subtraction loses the top of the
   * range, so full deflection would stop meaning full rate.
   */
  stickAxes(out) {
    const dz = this.deadzone;
    const l = this.stick.length();
    if (l <= dz || l <= 1e-6) { out.x = 0; out.y = 0; return out; }
    const s = ((l - dz) / (1 - dz)) / l;
    out.x = this.stick.x * s;
    out.y = this.stick.y * s;
    return out;
  }

  /** Pointer delta since the last call, in pixels. */
  consumeMouse() {
    const d = { x: this._mdx, y: this._mdy };
    this._mdx = 0; this._mdy = 0;
    return d;
  }

  update(dt) {
    const s = this.state;
    const k = (a) => (this.keys.has(a) ? 1 : 0);
    const scheme = this.schemeDef;

    /* Before anything reads the axes, because switching scheme mid-frame has
       to leave the stick and the deadzone consistent with each other. Skipped
       while a panel owns the screen: O, Z and the brackets are typing keys as
       far as the star map is concerned. */
    if (!this.uiOpen) this._settingsKeys();

    // the stick self-centres, so you can take your hand off the pointer
    if (!this.touch) this.stick.multiplyScalar(Math.max(0, 1 - this.autoCenter * dt));
    else this.stick.set(0, 0);

    let pitch = 0, yaw = 0, roll = 0;
    /* `autoCenter` is a self-centre, not a reset. Under the simple scheme it is
       quick enough (2.6/s) that letting go of the pointer stops the turn, which
       is the behaviour a mouse implies; the sim layout keeps the original
       0.85/s, where a hard turn is still a third of itself a second later and
       you can fly hands-off. Player.update zeroes the stick outright in the two
       cases where nobody's hand is on it at all — see the note there, and note
       that standing up is not one of them. */
    this.stickAxes(_axes);
    pitch = -_axes.y;
    yaw = -_axes.x;
    pitch += (k('pitchU') - k('pitchD')) * 0.9;
    /* The arrows steer under both schemes; A and D only under the sim one,
       where they are yaw rather than translation. */
    yaw += (k('turnL') - k('turnR')) * 0.9;
    if (!scheme.strafeAD) yaw += (k('yawL') - k('yawR')) * 0.9;
    roll += (k('rollL') - k('rollR'));

    // ---- touch sticks
    if (this.touch) {
      pitch += -this.touchL.y;
      yaw += -this.touchL.x;
      roll += this.touchR.x;
    }

    // ---- gamepad
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    let gpThrottle = 0;
    for (const gp of gps) {
      if (!gp) continue;
      const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
      pitch += -dz(gp.axes[1] || 0);
      yaw += -dz(gp.axes[0] || 0);
      roll += dz(gp.axes[2] || 0);
      gpThrottle += -dz(gp.axes[3] || 0);
      if (gp.buttons[7]?.pressed) s.boost = 1;
      if (gp.buttons[0]?.pressed) this.pressed.add('scan');
      break;
    }

    s.pitch = THREE.MathUtils.clamp(pitch, -1, 1);
    s.yaw = THREE.MathUtils.clamp(yaw, -1, 1);
    s.roll = THREE.MathUtils.clamp(roll, -1, 1);
    s.boost = this.held('boost') ? 1 : 0;

    let td = k('thrUp') - k('thrDn');
    if (this.touch) td += -this.touchR.y;
    if (this.touchBtn.has('thrUp')) td += 1;
    if (this.touchBtn.has('thrDn')) td -= 1;
    td += gpThrottle;
    td *= this.throttleRate;
    /* A wheel notch is a *step*, and it was not one. Game integrates this field
       as a rate — `throttle += throttleDelta * dt * 0.9` — so a flat `-w * 6`
       moved the throttle by however long the frame happened to be: a sixth as
       far at 360 Hz as at 60, and a whole notch on a frame that hitched.
       Dividing by dt here cancels the multiply there, so one notch is 0.14 of
       the range wherever it is spun. */
    const w = this.wheel();
    s.throttleDelta = td + (w ? (-w * 0.16) / Math.max(dt, 1 / 240) : 0);

    s.strafeY = k('up') - k('down');
    /* A and D, when the scheme says they are translation. They keep the `yawL`
       and `yawR` names because those names are also what the on-foot
       controller walks on through FOOT_ALIAS — one key set, one source of
       truth, and only the flight model's reading of them changes. */
    s.strafeX = scheme.strafeAD ? (k('yawR') - k('yawL')) : 0;
    /* Carried on the state object because that is the only thing that reaches
       Ship.update. See the note there about the autopilot. */
    s.assist = this.assist;
  }
}
