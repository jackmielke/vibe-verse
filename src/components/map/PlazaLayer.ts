import mapboxgl from "mapbox-gl";
import * as THREE from "three";

/**
 * 3D Plaza: a circular tiled plaza with a central fountain, ringed by
 * benches and lanterns. Same MercatorCoordinate pattern as the temple.
 */
export function createPlazaLayer(
  id: string,
  lngLat: { lng: number; lat: number },
  altitude = 0,
): mapboxgl.CustomLayerInterface {
  const modelOrigin: [number, number] = [lngLat.lng, lngLat.lat];
  const modelRotate: [number, number, number] = [Math.PI / 2, 0, 0];

  const modelAsMercatorCoordinate = mapboxgl.MercatorCoordinate.fromLngLat(
    modelOrigin,
    altitude,
  );

  // Plaza is wider than the temple (~32m diameter)
  const meterScale = modelAsMercatorCoordinate.meterInMercatorCoordinateUnits() * 32;

  const modelTransform = {
    translateX: modelAsMercatorCoordinate.x,
    translateY: modelAsMercatorCoordinate.y,
    translateZ: modelAsMercatorCoordinate.z,
    rotateX: modelRotate[0],
    rotateY: modelRotate[1],
    rotateZ: modelRotate[2],
    scale: meterScale,
  };

  let camera: THREE.Camera;
  let scene: THREE.Scene;
  let renderer: THREE.WebGLRenderer;
  let fountainStream: THREE.Mesh;
  const lanterns: THREE.PointLight[] = [];
  const startTime = performance.now();

  return {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      camera = new THREE.Camera();
      scene = new THREE.Scene();

      scene.add(new THREE.AmbientLight(0xffd9b3, 0.55));
      const key = new THREE.DirectionalLight(0xffe5c2, 1.0);
      key.position.set(0, -70, 100).normalize();
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xfbbf24, 0.5);
      rim.position.set(0, 70, 50).normalize();
      scene.add(rim);

      const tileLight = new THREE.MeshStandardMaterial({
        color: 0xe8dcc4, roughness: 0.85, metalness: 0.05,
      });
      const tileDark = new THREE.MeshStandardMaterial({
        color: 0xb89968, roughness: 0.9, metalness: 0.05,
      });
      const stoneMat = new THREE.MeshStandardMaterial({
        color: 0xc9a87a, roughness: 0.9,
      });
      const waterMat = new THREE.MeshStandardMaterial({
        color: 0x5cbdb9, roughness: 0.2, metalness: 0.3,
        emissive: 0x2dd4a8, emissiveIntensity: 0.3,
        transparent: true, opacity: 0.85,
      });
      const lanternMat = new THREE.MeshStandardMaterial({
        color: 0xfbbf24, emissive: 0xfbbf24, emissiveIntensity: 1.8,
      });
      const woodMat = new THREE.MeshStandardMaterial({
        color: 0x8b6f4e, roughness: 0.7,
      });

      const root = new THREE.Group();

      // Outer plaza ring (wide, low)
      const outer = new THREE.Mesh(
        new THREE.CylinderGeometry(2.5, 2.6, 0.12, 24),
        tileDark,
      );
      outer.position.y = 0.06;
      root.add(outer);

      // Inner tile (lighter, raised slightly)
      const inner = new THREE.Mesh(
        new THREE.CylinderGeometry(2.2, 2.2, 0.08, 24),
        tileLight,
      );
      inner.position.y = 0.13;
      root.add(inner);

      // Central fountain — three-tier
      const fountainBase = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 1.0, 0.3, 16),
        stoneMat,
      );
      fountainBase.position.y = 0.31;
      root.add(fountainBase);

      const fountainBowl = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.7, 0.18, 16),
        waterMat,
      );
      fountainBowl.position.y = 0.55;
      root.add(fountainBowl);

      const fountainPedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.22, 0.6, 12),
        stoneMat,
      );
      fountainPedestal.position.y = 0.95;
      root.add(fountainPedestal);

      const fountainTop = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.35, 0.1, 16),
        waterMat,
      );
      fountainTop.position.y = 1.3;
      root.add(fountainTop);

      // Water stream shooting up — animated
      fountainStream = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.12, 1.2, 8),
        new THREE.MeshBasicMaterial({
          color: 0xa5f3fc, transparent: true, opacity: 0.65,
        }),
      );
      fountainStream.position.y = 1.95;
      root.add(fountainStream);

      // Six lanterns ringing the plaza
      const lanternCount = 6;
      for (let i = 0; i < lanternCount; i++) {
        const angle = (i / lanternCount) * Math.PI * 2;
        const r = 2.0;
        const x = Math.cos(angle) * r;
        const z = Math.sin(angle) * r;

        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.05, 0.06, 1.2, 8),
          woodMat,
        );
        post.position.set(x, 0.7, z);
        root.add(post);

        const lantern = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 12, 12),
          lanternMat,
        );
        lantern.position.set(x, 1.45, z);
        root.add(lantern);

        const light = new THREE.PointLight(0xfbbf24, 1.5, 4);
        light.position.set(x, 1.45, z);
        scene.add(light);
        lanterns.push(light);
      }

      scene.add(root);

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    render(gl, matrix) {
      const t = (performance.now() - startTime) / 1000;

      // Fountain stream gently pulses up/down
      if (fountainStream) {
        const s = 1 + 0.15 * Math.sin(t * 3);
        fountainStream.scale.y = s;
      }

      // Lanterns flicker softly, slightly out of phase
      lanterns.forEach((l, i) => {
        l.intensity = 1.3 + 0.4 * Math.sin(t * 2.5 + i);
      });

      const rotationX = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(1, 0, 0), modelTransform.rotateX,
      );
      const rotationY = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(0, 1, 0), modelTransform.rotateY,
      );
      const rotationZ = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(0, 0, 1), modelTransform.rotateZ,
      );

      const m = new THREE.Matrix4().fromArray(matrix);
      const l = new THREE.Matrix4()
        .makeTranslation(
          modelTransform.translateX,
          modelTransform.translateY,
          modelTransform.translateZ,
        )
        .scale(new THREE.Vector3(modelTransform.scale, -modelTransform.scale, modelTransform.scale))
        .multiply(rotationX)
        .multiply(rotationY)
        .multiply(rotationZ);

      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      renderer.render(scene, camera);
    },
  };
}
