import { createDancePose, setArm, setLeg } from "./dances";

export function createRiderPose() {
  const pose = createDancePose();
  pose.rootY = -0.8;
  pose.rootPitch = 0.08;
  setLeg(pose.legL, 1, 1.1, 0.28, 1.25, 0.2);
  setLeg(pose.legR, -1, 1.1, 0.28, 1.25, 0.2);
  setArm(pose.armL, 1, 0.65, 0.1, 0.45);
  setArm(pose.armR, -1, 0.65, 0.1, 0.45);
  return pose;
}