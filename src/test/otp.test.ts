/**
 * The sign-in box submits itself the moment six digits land in it, which is
 * what makes "it autofills" true rather than half-true: iOS offers the code
 * above the keyboard, one tap drops it in, and the form goes.
 *
 * The danger in a self-submitting form is a loop. After a rejected code the box
 * still holds six characters, so a naive effect fires again on the next render,
 * and again. Supabase rate-limits OTP verification, so the punishment is not a
 * bit of noise — it is that the user cannot sign in at all for the next hour,
 * with nothing on screen explaining why. That is the case these tests exist for.
 */
import { describe, expect, it } from "vitest";
import { OTP_LENGTH, isCompleteOtp, normalizeOtp, shouldAutoSubmit } from "@/lib/otp";

const base = { sent: true, loading: false, lastTried: null as string | null };

describe("normalising a pasted code", () => {
  it("keeps six plain digits as they are", () => {
    expect(normalizeOtp("429173")).toBe("429173");
  });

  it("strips whatever the email client brought along", () => {
    // All of these are things people genuinely paste.
    expect(normalizeOtp("429-173")).toBe("429173");
    expect(normalizeOtp("Code: 429173")).toBe("429173");
    expect(normalizeOtp(" 429173 ")).toBe("429173");
    expect(normalizeOtp("4 2 9 1 7 3")).toBe("429173");
  });

  it("caps at the code length rather than sending a longer token", () => {
    expect(normalizeOtp("4291739999")).toBe("429173");
    expect(normalizeOtp("429173").length).toBe(OTP_LENGTH);
  });

  it("survives an empty or junk value", () => {
    expect(normalizeOtp("")).toBe("");
    expect(normalizeOtp("no digits here")).toBe("");
    expect(isCompleteOtp("12345")).toBe(false);
    expect(isCompleteOtp("123456")).toBe(true);
  });
});

describe("when the form submits itself", () => {
  it("fires once a complete code arrives", () => {
    expect(shouldAutoSubmit({ ...base, code: "123456" })).toBe(true);
  });

  it("stays quiet part-way through a hand-typed code", () => {
    for (const partial of ["", "1", "12", "123", "1234", "12345"]) {
      expect(shouldAutoSubmit({ ...base, code: partial }), partial).toBe(false);
    }
  });

  it("does not fire before the code has been sent", () => {
    expect(shouldAutoSubmit({ ...base, sent: false, code: "123456" })).toBe(false);
  });

  it("does not stack a second request on top of one in flight", () => {
    expect(shouldAutoSubmit({ ...base, loading: true, code: "123456" })).toBe(false);
  });

  it("refuses to retry the code it just tried — this is the loop guard", () => {
    // The exact shape of the bug: rejected code, box unchanged, next render.
    expect(shouldAutoSubmit({ ...base, code: "000000", lastTried: "000000" })).toBe(false);
  });

  it("tries again once the user corrects it", () => {
    expect(shouldAutoSubmit({ ...base, code: "654321", lastTried: "000000" })).toBe(true);
  });

  it("treats a reformatted paste of the same code as already tried", () => {
    // "429-173" and "429173" are one code. Normalising before comparing is
    // what stops a re-paste from burning a second verification attempt.
    expect(shouldAutoSubmit({ ...base, code: "429-173", lastTried: "429173" })).toBe(false);
  });

  it("never fires twice for one code, across a realistic sequence", () => {
    // Walk the whole journey and count. Typing, a rejection, a correction.
    const typed = ["1", "12", "123", "1234", "12345", "123456"];
    let lastTried: string | null = null;
    let fired = 0;
    for (const code of typed) {
      if (shouldAutoSubmit({ ...base, code, lastTried })) {
        fired += 1;
        lastTried = normalizeOtp(code);
      }
    }
    expect(fired).toBe(1);

    // Server says no. Nothing changes on screen. Ten more renders.
    for (let i = 0; i < 10; i++) {
      expect(shouldAutoSubmit({ ...base, code: "123456", lastTried })).toBe(false);
    }

    // They fix it.
    for (const code of ["12345", "123457"]) {
      if (shouldAutoSubmit({ ...base, code, lastTried })) {
        fired += 1;
        lastTried = normalizeOtp(code);
      }
    }
    expect(fired).toBe(2);
  });
});
