import { useGame } from "./store";

const FOOD_COLOR: Record<string, string> = {
  berry: "#e94e6b",
  seed: "#f4d35e",
  prey: "#d97742",
  water: "#4cc6ff",
  nutrient: "#b388ff",
};

export function FoodField() {
  const food = useGame((s) => s.food);
  return (
    <group>
      {food.map((f) =>
        f.alive ? (
          <mesh key={f.id} position={[f.pos[0], 0.3, f.pos[2]]} castShadow>
            {f.type === "water" ? (
              <cylinderGeometry args={[0.4, 0.4, 0.1, 8]} />
            ) : f.type === "prey" ? (
              <boxGeometry args={[0.5, 0.5, 0.8]} />
            ) : f.type === "nutrient" ? (
              <octahedronGeometry args={[0.3, 0]} />
            ) : (
              <icosahedronGeometry args={[0.28, 0]} />
            )}
            <meshStandardMaterial color={FOOD_COLOR[f.type]} flatShading emissive={FOOD_COLOR[f.type]} emissiveIntensity={0.15} />
          </mesh>
        ) : null,
      )}
    </group>
  );
}
