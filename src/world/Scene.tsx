import { Suspense } from "react";
import { Lighting } from "./Lighting";
import { Sky } from "./Sky";
import { Terrain } from "./Terrain";
import { Ocean } from "./Water";
import { Foliage } from "./Foliage";
import { Player } from "./CharacterController";

export function Scene() {
  return (
    <>
      <Sky />
      <Lighting />
      <Terrain />
      <Suspense fallback={null}>
        <Ocean />
      </Suspense>
      <Foliage />
      <Suspense fallback={null}>
        <Player />
      </Suspense>
    </>
  );
}
