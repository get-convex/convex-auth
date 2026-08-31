import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import {
  requirement,
  requirementValidators,
  type OnSignInVerdictOf,
  type SignInFactsOf,
} from "./requirements.ts";

const mathFactor = requirement("mathFactor:problem", {
  data: v.object({}),
  facts: { mathVerified: v.object({ verifiedAt: v.number() }) },
});

const emailLink = requirement("app:emailLink", {
  data: v.object({ maskedAddress: v.string() }),
  facts: { emailVerified: v.boolean() },
});

describe("requirement", () => {
  test("kinds must be namespaced", () => {
    expect(() =>
      // @ts-expect-error - unprefixed kinds are reserved for the framework
      requirement("terms", { data: v.object({}) }),
    ).toThrow(/must be namespaced/);
  });

  test("fact fields must be declared required", () => {
    expect(() =>
      requirement("app:bad", {
        data: v.object({}),
        // @ts-expect-error - the derived facts bag's optionality is handled by the framework
        facts: { verified: v.optional(v.boolean()) },
      }),
    ).toThrow(/must be declared required/);
  });

  test("facts default to none", () => {
    const spec = requirement("app:plain", { data: v.object({}) });
    expect(spec.facts).toEqual({});
  });
});

describe("requirementValidators", () => {
  test("an empty array is rejected", () => {
    expect(() => requirementValidators([])).toThrow(
      /needs at least one requirement/,
    );
  });

  test("duplicate kinds are rejected", () => {
    expect(() => requirementValidators([mathFactor, mathFactor])).toThrow(
      /Duplicate requirement kind/,
    );
  });

  test("fact fields claimed by two kinds are rejected", () => {
    const clash = requirement("app:clash", {
      data: v.object({}),
      facts: { emailVerified: v.string() },
    });
    expect(() => requirementValidators([emailLink, clash])).toThrow(
      /declared by both "app:emailLink" and "app:clash"/,
    );
  });

  test("the derived facts bag makes every fact field optional", () => {
    const { vFacts } = requirementValidators([mathFactor, emailLink]);
    const fields = (
      vFacts as unknown as {
        fields: Record<string, { isOptional: string; kind?: string }>;
      }
    ).fields;
    expect(Object.keys(fields).sort()).toEqual([
      "emailVerified",
      "mathVerified",
    ]);
    expect(fields.mathVerified.isOptional).toBe("optional");
    expect(fields.emailVerified.isOptional).toBe("optional");
  });

  test("the requirement union is closed over the declared kinds", () => {
    const { vRequirement } = requirementValidators([mathFactor, emailLink]);
    const union = vRequirement as unknown as {
      kind: string;
      members: { fields: { kind: { value: string } } }[];
    };
    expect(union.kind).toBe("union");
    expect(union.members.map((m) => m.fields.kind.value).sort()).toEqual([
      "app:emailLink",
      "mathFactor:problem",
    ]);
  });

  test("the verdict union accepts null and closed incomplete verdicts", () => {
    const { vVerdict } = requirementValidators([mathFactor]);
    const union = vVerdict as unknown as {
      kind: string;
      members: { kind: string }[];
    };
    expect(union.kind).toBe("union");
    expect(union.members.map((m) => m.kind).sort()).toEqual(["null", "object"]);
  });

  test("compile-time: the static types derive from the specs", () => {
    // Never executed — the point is that tsc checks the body (an
    // expect-error directive on a line that DOES compile fails typecheck).
    const typeChecks = () => {
      type Specs = readonly [typeof mathFactor, typeof emailLink];
      const facts: SignInFactsOf<Specs> = {
        mathVerified: { verifiedAt: 123 },
        emailVerified: true,
      };
      // @ts-expect-error - unknown facts field
      const badFacts: SignInFactsOf<Specs> = { somethingElse: true };
      const verdict: OnSignInVerdictOf<Specs> = {
        status: "requirements-needed",
        requirements: [
          { kind: "app:emailLink", data: { maskedAddress: "c…@convex.dev" } },
        ],
      };
      const badVerdict: OnSignInVerdictOf<Specs> = {
        status: "requirements-needed",
        // @ts-expect-error - "app:other" is not a declared kind
        requirements: [{ kind: "app:other", data: {} }],
      };
      const complete: OnSignInVerdictOf<Specs> = null;
      return { facts, badFacts, verdict, badVerdict, complete };
    };
    expect(typeof typeChecks).toBe("function");
  });
});
