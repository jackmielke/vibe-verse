/* ============================================================================
   The hub, aboard the ship.

   VIBEY carries the vibeverse's own records: the photographs people have
   uploaded, the roster of everyone who lives here, and the traffic on the
   lobby band. They are shown on the archive terminal on the port wall — the
   biggest display in the ship, and the one you have to get out of the seat and
   walk to, which is the point. Data you stand in front of reads as somewhere
   you are; data on a HUD reads as a menu.

   This module holds and paginates that data and nothing else. It deliberately
   does NOT import the app's Supabase client: `src/longsilence` is a vendored
   fork that has to stay re-syncable against upstream, and an engine that
   reaches into the host application cannot be lifted back out. The React page
   fetches, and hands a plain object in.

   Everything here has to survive the data never arriving. The ship is flown
   from a route that may be offline, signed out, or blocked from the database
   entirely — so every page renders something honest when its table is empty,
   and none of them can throw.
   ========================================================================== */

/** The pages the terminal cycles through, in order. */
export const PAGES = ['gallery', 'crew', 'band'];

const PAGE_TITLE = {
  gallery: 'THE GALLERY',
  crew: 'THE MANIFEST',
  band: 'THE BAND',
};

/** Seconds a page holds before the terminal moves on by itself. */
const DWELL = { gallery: 7.0, crew: 11.0, band: 11.0 };

export class VibeverseData {
  constructor() {
    /** @type {{title:string,caption:string,residency:string,img:HTMLImageElement|null}[]} */
    this.photos = [];
    /** @type {{name:string,detail:string,resident:boolean}[]} */
    this.crew = [];
    /** @type {{name:string,status:string,color:string,seen:string}[]} */
    this.agents = [];
    /** @type {{speaker:string,body:string,kind:string,when:string}[]} */
    this.messages = [];
    this.counts = {};

    this.loaded = false;
    /** Set when the fetch failed outright, so the panel can say so plainly. */
    this.error = null;

    this.page = 0;
    this.photoIdx = 0;
    /** 0..1 crossfade between the outgoing and incoming photograph. */
    this.fade = 1;
    this._t = 0;
    this._photoT = 0;
    this._scroll = 0;
    /** Held pages stop the automatic cycle — someone is reading. */
    this.held = false;
  }

  /** Accept a payload from the page. Shape is whatever `loadVibeverse` built. */
  adopt(data) {
    if (!data) return;
    if (data.error) { this.error = String(data.error).slice(0, 120); }
    this.photos = Array.isArray(data.photos) ? data.photos : [];
    this.crew = Array.isArray(data.crew) ? data.crew : [];
    this.agents = Array.isArray(data.agents) ? data.agents : [];
    this.messages = Array.isArray(data.messages) ? data.messages : [];
    this.counts = data.counts || {};
    this.loaded = true;
  }

  get pageId() { return PAGES[this.page % PAGES.length]; }
  get title() { return PAGE_TITLE[this.pageId] || 'ARCHIVE'; }

  /** The photograph currently on the glass, and the one fading out under it. */
  get photo() { return this.photos[this.photoIdx % Math.max(1, this.photos.length)] || null; }
  get prevPhoto() {
    if (this.photos.length < 2) return null;
    const i = (this.photoIdx - 1 + this.photos.length) % this.photos.length;
    return this.photos[i] || null;
  }

  /** Advance a page by hand. Also releases the automatic cycle for a while. */
  step(dir = 1) {
    this.page = (this.page + dir + PAGES.length) % PAGES.length;
    this._t = 0;
    this._scroll = 0;
    return this.pageId;
  }

  nextPhoto() {
    if (this.photos.length < 2) return;
    this.photoIdx = (this.photoIdx + 1) % this.photos.length;
    this.fade = 0;
    this._photoT = 0;
  }

  /**
   * @param {number} dt seconds
   * @param {boolean} watched true while the player is stood at the terminal
   */
  update(dt, watched) {
    this._t += dt;
    this._photoT += dt;
    // The crossfade runs on wall time rather than per frame, so it looks the
    // same on a machine having a bad second. Same lesson as the fold tunnel.
    if (this.fade < 1) this.fade = Math.min(1, this.fade + dt * 1.6);
    this._scroll += dt;

    // Photographs cycle on their own, but only while somebody is watching —
    // a gallery advancing to an empty room is just texture uploads.
    if (this.pageId === 'gallery' && watched && this._photoT > 4.6) this.nextPhoto();

    if (!watched || this.held) return;
    if (this._t > (DWELL[this.pageId] || 8)) { this._t = 0; this.step(1); }
  }

  /** Rows for the band page, scrolled. Newest first, so the top line is live. */
  bandRows(n) {
    if (!this.messages.length) return [];
    const off = Math.floor(this._scroll * 0.55) % this.messages.length;
    const out = [];
    for (let i = 0; i < Math.min(n, this.messages.length); i++) {
      out.push(this.messages[(off + i) % this.messages.length]);
    }
    return out;
  }
}
