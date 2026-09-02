/**
 * BETTER FORTNITE — the grapple.
 *
 * Everyone has one, from the first second. F fires a hook along the look; if
 * it finds a surface inside `GRAPPLE.range` the rope attaches and pulls you
 * toward it until you arrive, let go, or the rope times out. It is not a
 * physics rope — it is a velocity you are steered onto — because a real
 * pendulum feels wonderful for the four people who master it and like a
 * broken swing for everyone else, and this is the mobility tool for everyone.
 *
 * Ordering matters and it is the reason this boots before the player: the
 * pull is written into `player.velocity` in `fixed()`, and the player's own
 * fixed step then adds a step of gravity and integrates. The gravity is a
 * few centimetres a step against a pull of tens of metres a second, which is
 * exactly the sag a rope should have.
 *
 * The rope is a thin cylinder stretched between the hand and the anchor every
 * frame. One mesh, one material, rebuilt by matrix rather than geometry.
 */
import * as THREE from "three";
import type { GrappleService, SystemFactory } from "../types";
import { GRAPPLE } from "../mode/better";

const createGrapple: SystemFactory = (ctx) => {
  const anchor = new THREE.Vector3();
  const hookNormal = new THREE.Vector3();
  let hooked = false;
  let hookedFor = 0;
  let cooldown = 0;
  let cooldownMax = GRAPPLE.cooldown;
  let wasJump = false;

  const _eye = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _to = new THREE.Vector3();
  const _mid = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _q = new THREE.Quaternion();

  // ---- visuals -----------------------------------------------------------
  const root = new THREE.Group();
  root.name = "dz:grapple";
  ctx.scene.add(root);

  const ropeGeo = new THREE.CylinderGeometry(GRAPPLE.ropeRadius, GRAPPLE.ropeRadius, 1, 6, 1, true);
  const ropeMat = new THREE.MeshStandardMaterial({ color: GRAPPLE.ropeColor, roughness: 0.9, metalness: 0 });
  const rope = new THREE.Mesh(ropeGeo, ropeMat);
  rope.visible = false;
  rope.frustumCulled = false;
  root.add(rope);

  // A claw: three short prongs around a shaft, which reads as "hook" at any
  // distance and is eleven triangles.
  const hook = new THREE.Group();
  const hookMat = new THREE.MeshStandardMaterial({ color: GRAPPLE.hookColor, roughness: 0.55, metalness: 0.7 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.34, 6), hookMat);
  hook.add(shaft);
  const prongGeo = new THREE.ConeGeometry(0.045, 0.22, 5);
  for (let i = 0; i < 3; i++) {
    const prong = new THREE.Mesh(prongGeo, hookMat);
    const a = (i / 3) * Math.PI * 2;
    prong.position.set(Math.cos(a) * 0.12, 0.2, Math.sin(a) * 0.12);
    prong.rotation.set(Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9);
    hook.add(prong);
  }
  hook.visible = false;
  root.add(hook);

  const service: GrappleService = {
    get cooldown() {
      return cooldown;
    },
    get cooldownMax() {
      return cooldownMax;
    },
    get hooked() {
      return hooked;
    },
    fire() {
      return fire();
    },
    release() {
      release("manual");
    },
  };
  ctx.services.grapple = service;

  function publish(): void {
    ctx.emit("dz:grapple", { hooked, cooldown, cooldownMax });
  }

  function fire(): boolean {
    const player = ctx.services.player;
    const collision = ctx.services.collision;
    if (!player || !collision) return false;
    if (cooldown > 0 || hooked) return false;
    const st = player.state;
    if (st === "dead" || st === "down" || st === "bus") return false;

    player.eye(_eye);
    player.look(_dir);
    const hit = collision.raycast(_eye, _dir, GRAPPLE.range);
    cooldownMax = GRAPPLE.cooldown * (ctx.services.augments?.factor("grappleCooldown") ?? 1);
    if (!hit) {
      // A miss still costs something, or F becomes a free range-finder. A
      // third of the cooldown: enough to make you aim, not enough to punish.
      cooldown = cooldownMax * 0.33;
      ctx.services.audio?.play("grapple-miss", { volume: 0.5 });
      publish();
      return false;
    }

    anchor.copy(hit.point);
    hookNormal.copy(hit.normal);
    hooked = true;
    hookedFor = 0;
    cooldown = cooldownMax;

    // The kick: a flat shot at a wall should lift you off the ground, and a
    // shot from the ground should not start by dragging you along it.
    player.velocity.y = Math.max(player.velocity.y, GRAPPLE.liftKick);

    hook.position.copy(anchor);
    // Point the shaft into the surface.
    _q.setFromUnitVectors(_up, hookNormal.clone().negate().normalize());
    hook.quaternion.copy(_q);
    hook.visible = true;
    rope.visible = true;

    ctx.services.audio?.play("grapple-fire", { volume: 0.75 });
    ctx.services.audio?.play("grapple-hit", { volume: 0.6, position: anchor });
    ctx.services.vfx?.impact(anchor, hookNormal, hit.material ?? "concrete");
    publish();
    return true;
  }

  function release(_why: "arrived" | "timeout" | "manual" | "state"): void {
    if (!hooked) return;
    hooked = false;
    hook.visible = false;
    rope.visible = false;
    const player = ctx.services.player;
    if (player) {
      // Carry most of the momentum into the landing. Killing it entirely is
      // the "invisible wall" feel; keeping all of it fires you past the roof.
      player.velocity.x *= GRAPPLE.carry;
      player.velocity.z *= GRAPPLE.carry;
    }
    ctx.services.audio?.play("grapple-release", { volume: 0.4 });
    publish();
  }

  return {
    name: "grapple",

    fixed(dt) {
      if (cooldown > 0) cooldown = Math.max(0, cooldown - dt);
      const player = ctx.services.player;
      if (!player) return;

      if (hooked) {
        const st = player.state;
        if (st === "dead" || st === "down" || st === "bus") {
          release("state");
          return;
        }
        hookedFor += dt;
        _to.subVectors(anchor, player.position);
        // Aim at the anchor from the chest, not the feet: arriving with your
        // head at the ledge is arriving; arriving with your feet there is a
        // face-plant into the wall under it.
        _to.y -= 1.2;
        const dist = _to.length();
        if (dist < GRAPPLE.arriveDistance || hookedFor > GRAPPLE.maxDuration) {
          release(dist < GRAPPLE.arriveDistance ? "arrived" : "timeout");
          return;
        }
        _to.divideScalar(dist);
        // Steer the velocity onto the rope direction at `pullAccel`, capped at
        // `pullSpeed`. Component along the rope is what we control; the rest
        // decays, so a sideways start swings in rather than orbiting.
        const along = player.velocity.dot(_to);
        const want = Math.min(GRAPPLE.pullSpeed, along + GRAPPLE.pullAccel * dt);
        player.velocity.addScaledVector(_to, want - along);
        const side = 1 - Math.min(1, 6 * dt);
        // Remove a fraction of the perpendicular component.
        _mid.copy(_to).multiplyScalar(player.velocity.dot(_to));
        player.velocity.sub(_mid).multiplyScalar(side).add(_mid);
      }
    },

    update() {
      const player = ctx.services.player;
      const input = ctx.input;
      if (!player) return;

      // Jump releases. Edge-triggered here, since `input.jump` is a hold.
      const jump = input.jump;
      if (hooked && jump && !wasJump) release("manual");
      wasJump = jump;

      if (player.controllable && (input.pressed.has("KeyF") || input.pressed.has("dz:grapple"))) fire();

      if (hooked) {
        player.eye(_eye);
        // Hand, roughly: a little right and down from the eye.
        _eye.y -= 0.35;
        _mid.addVectors(_eye, anchor).multiplyScalar(0.5);
        _to.subVectors(anchor, _eye);
        const len = Math.max(0.01, _to.length());
        rope.position.copy(_mid);
        _q.setFromUnitVectors(_up, _to.divideScalar(len));
        rope.quaternion.copy(_q);
        rope.scale.set(1, len, 1);
      }

      // The HUD pip wants the cooldown every frame it is moving, and nothing
      // otherwise.
      if (cooldown > 0 || hooked) publish();
    },

    dispose() {
      ctx.scene.remove(root);
      ropeGeo.dispose();
      ropeMat.dispose();
      prongGeo.dispose();
      shaft.geometry.dispose();
      hookMat.dispose();
      if (ctx.services.grapple === service) ctx.services.grapple = undefined;
    },
  };
};

export default createGrapple;
