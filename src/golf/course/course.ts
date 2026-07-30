/**
 * Vibe Golf — course loading.
 *
 * Owns which hole is live, hands it to the physics broadphase, and announces
 * hole changes so the renderer, camera and HUD can re-dress themselves.
 * Publishes `CourseService`.
 */
import type { Course, CourseService, Hole, System, SystemFactory } from "../types";
import { COURSES } from "./holes";

const createCourse: SystemFactory = (ctx) => {
  const service: CourseService = {
    courses: COURSES as Course[],
    current: null,
    courseIndex: 0,
    holeIndex: 0,
    load(courseId: string, holeIndex: number) {
      const ci = Math.max(0, this.courses.findIndex((c) => c.id === courseId));
      const course = this.courses[ci];
      if (!course) return;
      const hole: Hole | undefined = course.holes[holeIndex];
      if (!hole) return;
      this.courseIndex = ci;
      this.holeIndex = holeIndex;
      this.current = hole;
      ctx.services.physics?.setHole(hole);
      ctx.emit("golf:hole", { course, hole, holeIndex });
    },
    next() {
      const course = this.courses[this.courseIndex];
      if (!course) return false;
      if (this.holeIndex + 1 < course.holes.length) {
        this.load(course.id, this.holeIndex + 1);
        return true;
      }
      ctx.emit("golf:courseComplete", { course });
      return false;
    },
  };

  ctx.services.course = service;

  const sys: System = {
    name: "course",
    update() {
      // Load the opening hole once physics is up (it boots after us on a
      // cold start, so we can't do this in the factory body).
      if (!service.current && ctx.services.physics) {
        service.load(service.courses[0]?.id ?? "", 0);
      }
    },
  };
  return sys;
};

export default createCourse;
