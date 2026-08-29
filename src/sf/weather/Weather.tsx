/**
 * weather/Weather.tsx — the bridge between the forecast and the frame.
 *
 * Mount once inside the Canvas. It starts the polling, and every frame it
 * eases the world toward whatever the last observation implies:
 *
 *   `frame.fogDensity`        the sky shader, the sun's intensity, the fog
 *                             near/far planes, the volumetric shafts, the
 *                             facade lighting and the enemy sight ranges
 *   `frame.windDirection/Speed`  every tree in the city, the bay's chop, the
 *                             rain's slant, litter, smoke, flags, muzzle smoke
 *   `weather.rain/groundFog/haze`  the rain field, the splashes, the wet
 *                             decals, the marine-layer wisps
 *
 * Two of those three had *no writer at all* before this file existed.
 * `frame.windDirection` and `frame.windSpeed` were read in nine places and
 * set in none, so the whole city was permanently becalmed at whatever the
 * initial value happened to be; `weather` was only ever touched by a unit
 * test. That is the recurring shape of this repository and it is worth saying
 * out loud: the systems were built, they were correct, and nothing had ever
 * turned them on.
 *
 * ## Nothing snaps
 *
 * A refresh ten minutes in can move the fog from 0.2 to 0.7. Applying that on
 * one frame is a visible cut, and it happens while the player is standing
 * still looking at the bay. So the applied state chases the target with a time
 * constant of about half a minute — long enough to read as weather changing,
 * short enough that nobody watches an empty sky waiting for it.
 *
 * The *first* report is the exception and lands instantly: opening the world
 * and watching the fog roll in over thirty seconds because that is how long
 * the easing takes would be a bug wearing a feature's clothes.
 */
import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { frame } from "../state/store";
import { setWeather, weather } from "../vfx/environmental";
import { currentReport, startWeatherPolling, subscribeWeather } from "./service";
import { worldWeather, type WorldWeather } from "./report";

/** Seconds for the applied state to cover ~63 % of the distance to a new one. */
const EASE_SECONDS = 30;

const CALM: WorldWeather = {
  rain: 0, groundFog: 0, haze: 0, fogDensity: 0.35,
  windX: 1, windZ: 0, windSpeed: 4, cloud: 0.3,
};

export default function Weather() {
  const target = useRef<WorldWeather>(CALM);
  const applied = useRef<WorldWeather>({ ...CALM });
  const primed = useRef(false);

  useEffect(() => {
    const read = () => {
      const r = currentReport();
      if (r) target.current = worldWeather(r);
    };
    read();
    const off = subscribeWeather(read);
    const stop = startWeatherPolling();
    return () => {
      off();
      stop();
    };
  }, []);

  useFrame((_, delta) => {
    if (frame.paused) return;
    const t = target.current;
    const a = applied.current;

    if (!primed.current && currentReport()) {
      Object.assign(a, t);
      primed.current = true;
      /* `wetness` is normally integrated up from `rain` by the environment
         system over about ten seconds. On the first frame that is wrong: a
         city that has been rained on for an hour before you loaded it is
         already wet, and watching the road dry-to-wet as you spawn is
         backwards. Only here — after this, the lag is the point. */
      weather.wetness = t.rain > 0.05 ? 1 : 0;
    } else {
      // Exponential, framerate-independent. `delta` rather than the clamped
      // `frame.dt`: this is wall-clock easing of a wall-clock quantity, and a
      // tab that was hidden for a minute should come back to the weather it
      // is now rather than the weather it was.
      const k = 1 - Math.exp(-Math.min(delta, 5) / EASE_SECONDS);
      a.rain += (t.rain - a.rain) * k;
      a.groundFog += (t.groundFog - a.groundFog) * k;
      a.haze += (t.haze - a.haze) * k;
      a.fogDensity += (t.fogDensity - a.fogDensity) * k;
      a.cloud += (t.cloud - a.cloud) * k;
      a.windSpeed += (t.windSpeed - a.windSpeed) * k;
      a.windX += (t.windX - a.windX) * k;
      a.windZ += (t.windZ - a.windZ) * k;
    }

    /* Photo mode and the screenshot harness hold the clock while somebody
       composes a frame. They own the sky for as long as they have it — a fog
       slider that slides back on its own is not a slider. */
    if (!frame.clockHeld) frame.fogDensity = a.fogDensity;

    /* Gusts. A constant wind speed makes an entire city of trees lean over and
       stay there, which reads as a still image with a shear applied to it
       rather than as air moving. Two incommensurate sines never repeat on any
       timescale a player will sit through, and cost nothing.

       The mean is preserved: this modulates around the observed speed rather
       than adding to it, so a 5 km/h evening stays a 5 km/h evening. */
    const s = frame.time;
    const gust = 0.82 + 0.18 * Math.sin(s * 0.23) + 0.12 * Math.sin(s * 0.071 + 1.7);
    frame.windSpeed = Math.max(0, a.windSpeed * gust);

    // And the direction wanders a few degrees, for the same reason.
    const swing = Math.sin(s * 0.037) * 0.09 + Math.sin(s * 0.011 + 0.6) * 0.05;
    const cs = Math.cos(swing);
    const sn = Math.sin(swing);
    const len = Math.hypot(a.windX, a.windZ) || 1;
    frame.windDirection.set(
      (a.windX * cs - a.windZ * sn) / len,
      (a.windX * sn + a.windZ * cs) / len,
    );

    setWeather({ rain: a.rain, groundFog: a.groundFog, haze: a.haze });
  });

  return null;
}
