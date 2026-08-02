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
  ArrowUp: 'pitchU', ArrowDown: 'pitchD', ArrowLeft: 'yawL', ArrowRight: 'yawR',
  Space: 'up', ControlLeft: 'down', KeyC: 'down',
  ShiftLeft: 'boost', ShiftRight: 'boost',
  KeyF: 'scan', KeyJ: 'fold', KeyX: 'stop',
  KeyR: 'align', KeyV: 'view', KeyT: 'target',
  AltLeft: 'look', AltRight: 'look',
};

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

export class Input {
  constructor(dom) {
    this.dom = dom;
    this.keys = new Set();
    this.pressed = new Set();
    this.stick = new THREE.Vector2(0, 0);
    this.sensitivity = 0.0022;
    this.autoCenter = 0.85;
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
      boost: 0,
    };

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const a = KEYMAP[e.code];
      if (a) { this.keys.add(a); this.pressed.add(a); }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
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
    this.stick.x += dx * this.sensitivity;
    this.stick.y += dy * this.sensitivity;
    const l = this.stick.length();
    if (l > 1) this.stick.multiplyScalar(1 / l);
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

    // the stick self-centres slowly, so you can fly hands-off
    if (!this.touch) this.stick.multiplyScalar(Math.max(0, 1 - this.autoCenter * dt));
    else this.stick.set(0, 0);

    let pitch = 0, yaw = 0, roll = 0;
    /* `autoCenter` is a hands-off self-centre, not a reset: at 0.85/s a hard
       turn is still a third of itself a second later. Player.update zeroes the
       stick outright in the two cases where nobody's hand is on it at all —
       see the note there, and note that standing up is not one of them. */
    pitch = -this.stick.y;
    yaw = -this.stick.x;
    pitch += (k('pitchU') - k('pitchD')) * 0.9;
    yaw += (k('yawL') - k('yawR')) * 0.9;
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
    const w = this.wheel();
    s.throttleDelta = td + (-w * 6);

    s.strafeY = k('up') - k('down');
    s.strafeX = 0;
  }
}
