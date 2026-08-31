/**
 * Typed sign-in requirements, exported at `@convex-dev/auth/lib/requirements`.
 *
 * The core treats requirements as opaque `{ kind: string, data?: any }`
 * payloads; this module lets an app close that vocabulary. Each requirement
 * declares its wire `kind`, the `data` payload the server sends down with
 * it, and the trusted `facts` recorded once the requirement has been
 * verified server-side (see {@link RequirementSpec}). The app declares specs
 * with {@link requirement} wherever they naturally live (a capability's
 * setup function, a module next to the feature they gate) and passes the
 * plain array to a provider setup — e.g. `setupUsernamePassword(core, {
 * signInRequirements: [...] })` — which threads the closed vocabulary
 * through the whole stack:
 *
 *  - The app's evaluating `onSignIn` callback hand-writes its `facts` and
 *    `returns` validators from {@link requirementValidators}, so a verdict
 *    emitting an unregistered kind, a malformed payload, or a malformed
 *    fact is rejected loudly at runtime.
 *  - The provider setup compile-checks the callback against the spec array,
 *    so a verdict emitting an unregistered kind fails the build with the
 *    expected types in the error.
 *  - Clients see a *closed* requirement union through the generated `api`
 *    types, so an exhaustive `switch` over `kind` (with a `satisfies never`
 *    default) stops compiling the moment a new kind is registered.
 *
 * Requirements are satisfied by server-verified facts only: a verification
 * endpoint proves something (a second factor, a CAPTCHA, an email link),
 * records a fact on the parked sign-in attempt, and the evaluator then sees
 * the fact and drops the requirement. (A client-provided input channel for
 * assertion-style requirements — a terms checkbox, say — is planned but not
 * part of this pass.)
 *
 * Capabilities (a second factor, a verifier) participate by exporting a
 * {@link RequirementSpec} from their setup function. Because the spec value
 * is only obtainable by running the setup, registering a kind implies the
 * thing that satisfies it is actually installed — "requirable ⟹ available"
 * holds by construction.
 */
import { type Infer, v, type Validator } from "convex/values";
import { type OnSignInVerdict, type SignInRequirement } from "./types.ts";

/** The "any non-optional validator" bound, mirroring convex's own
 * `GenericValidator`: constraint-position `any` is what lets concrete
 * validator types flow through unwidened. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRequiredValidator = Validator<any, "required", any>;

/** Proof a spec came through {@link requirement}; not exported, so specs
 * can't be conjured structurally (short of a deliberate cast — which the
 * derived runtime validators then catch). */
const brand = Symbol("signInRequirementSpec");

/**
 * The fact fields a requirement contributes. Declared *required* (that's
 * the natural shape: proving a second factor records `mathVerified`); the
 * derived facts bag makes each field optional itself, since a fact exists
 * only once its requirement has been verified.
 */
type FactFields = Record<string, AnyRequiredValidator>;

/**
 * One registrable requirement: its wire `kind`, the validator for the
 * payload the server sends down with it (`data`), and the verification
 * facts server code records once the requirement has been satisfied
 * (`facts`).
 *
 * Facts are trusted by construction: only server code that actually
 * verified something can record one (via `recordAttemptFacts`), and the
 * core persists them across continuation rounds. The app's `onSignIn`
 * evaluator judges a requirement satisfied by the *presence* of its facts.
 */
export type RequirementSpec<
  Kind extends string = string,
  Data extends AnyRequiredValidator = AnyRequiredValidator,
  Facts extends FactFields = FactFields,
> = {
  readonly kind: Kind;
  readonly data: Data;
  readonly facts: Facts;
  readonly [brand]: true;
};

/**
 * Declare a requirement. Kinds must be namespaced (`app:…`, `mathFactor:…`);
 * unprefixed kinds are reserved for the framework — enforced both by the
 * template-literal constraint and at runtime.
 */
export function requirement<
  const Kind extends `${string}:${string}`,
  const Data extends AnyRequiredValidator,
  const Facts extends FactFields = Record<never, never>,
>(
  kind: Kind,
  spec: { data: Data; facts?: Facts },
): RequirementSpec<Kind, Data, Facts> {
  if (!/^[^:]+:.+$/.test(kind)) {
    throw new Error(
      `Requirement kind "${kind}" must be namespaced ("app:…"); unprefixed kinds are reserved for the framework`,
    );
  }
  const facts = spec.facts ?? ({} as Facts);
  for (const [field, validator] of Object.entries(facts)) {
    if (validator.isOptional !== "required") {
      throw new Error(
        `Fact field "${field}" of "${kind}" must be declared required; the derived bag's optionality is handled by the framework`,
      );
    }
  }
  return { kind, data: spec.data, facts, [brand]: true };
}

type AnySpec = RequirementSpec;

/** A single emitted requirement, per spec: `{ kind, data }` with both narrowed. */
type RequirementFor<S extends AnySpec> =
  S extends RequirementSpec<infer Kind extends string, infer Data>
    ? { kind: Kind; data: Infer<Data> }
    : never;

type UnionToIntersection<U> = (
  U extends unknown ? (u: U) => void : never
) extends (i: infer I) => void
  ? I
  : never;

/** Flatten an intersection into one readable object type. */
type Flatten<T> = { [K in keyof T]: T[K] };

/** One spec's contribution to the trusted facts bag: its fact fields, each
 * optional (a fact exists only once its requirement has been verified). The
 * `-readonly` strips the modifier that `const` type-parameter inference adds
 * to spec fields. */
type FactsFor<S extends AnySpec> =
  S extends RequirementSpec<string, AnyRequiredValidator, infer Facts>
    ? { -readonly [Field in keyof Facts]?: Infer<Facts[Field]> }
    : never;

type SignInFactsFor<Specs extends readonly AnySpec[]> = Flatten<
  UnionToIntersection<FactsFor<Specs[number]>>
>;

/**
 * The app's sign-in requirements for one provider: a plain array of
 * {@link requirement} declarations, passed to the provider setup's
 * `signInRequirements` option.
 */
export type SignInRequirements = readonly RequirementSpec[];

/**
 * The requirement union of a requirements array — or the open
 * {@link SignInRequirement} when none is configured.
 */
export type RequirementOf<R extends SignInRequirements | undefined> =
  R extends SignInRequirements ? RequirementFor<R[number]> : SignInRequirement;

/**
 * The accumulated trusted facts bag of a requirements array — every declared
 * fact field, optional — or the open `Record<string, unknown>` bag when none
 * is configured. Never client-writable: it accumulates only through
 * server-side `recordAttemptFacts` calls.
 */
export type SignInFactsOf<R extends SignInRequirements | undefined> =
  R extends SignInRequirements ? SignInFactsFor<R> : Record<string, unknown>;

/**
 * The `onSignIn` verdict union of a requirements array — or the open
 * {@link OnSignInVerdict} when none is configured.
 */
export type OnSignInVerdictOf<R extends SignInRequirements | undefined> =
  R extends SignInRequirements
    ? null | {
        status: "requirements-needed";
        requirements: RequirementFor<R[number]>[];
      }
    : OnSignInVerdict;

/**
 * Derive the runtime validators for a requirements array:
 *
 *  - `vRequirement` — the closed requirement union.
 *  - `vFacts` — the accumulated facts bag (every fact field optional, strict).
 *  - `vVerdict` — the `onSignIn` verdict union (`null` or a `requirements-needed`
 *    verdict carrying closed requirements).
 *
 * Rejects duplicate kinds and fact fields claimed by more than one kind (the
 * facts bag is a single flat object, so field names must be unambiguous).
 *
 * Provider setups call this when `signInRequirements` are configured, and
 * apps call it to declare their evaluating `onSignIn` mutation's `facts` arg
 * and `returns` validators from the same spec values — which is what lets
 * the callback module stay free of any import from `auth.ts` (specs live in
 * modules of their own) while still carrying the precise types:
 *
 * ```ts
 * const { vFacts, vVerdict } = requirementValidators([mathFactor.requirement]);
 *
 * export const evaluateSignIn = internalMutation({
 *   args: { ..., facts: vFacts },
 *   returns: vVerdict,
 *   handler: async (ctx, args) => { ... },
 * });
 * ```
 *
 * The validators' static types derive structurally from the specs (see
 * {@link RequirementOf} and friends), while their runtime shape enforces the
 * same vocabulary — declaration and enforcement can't drift.
 */
export function requirementValidators<const Specs extends SignInRequirements>(
  specs: Specs,
): {
  vRequirement: Validator<RequirementOf<Specs>, "required", string>;
  vFacts: Validator<SignInFactsOf<Specs>, "required", string>;
  vVerdict: Validator<OnSignInVerdictOf<Specs>, "required", string>;
} {
  if (specs.length === 0) {
    throw new Error("`signInRequirements` needs at least one requirement");
  }
  const kinds = new Set<string>();
  const factOwners = new Map<string, string>();
  for (const spec of specs) {
    if (kinds.has(spec.kind)) {
      throw new Error(`Duplicate requirement kind "${spec.kind}"`);
    }
    kinds.add(spec.kind);
    for (const field of Object.keys(spec.facts)) {
      const owner = factOwners.get(field);
      if (owner !== undefined) {
        throw new Error(
          `Fact field "${field}" is declared by both "${owner}" and "${spec.kind}"`,
        );
      }
      factOwners.set(field, spec.kind);
    }
  }

  const members = specs.map((spec) =>
    v.object({ kind: v.literal(spec.kind), data: spec.data }),
  );
  const vRequirement = (members.length === 1
    ? members[0]
    : v.union(...members)) as unknown as Validator<
    RequirementOf<Specs>,
    "required",
    string
  >;

  const factFields: Record<string, Validator<unknown, "optional", string>> = {};
  for (const spec of specs) {
    for (const [field, validator] of Object.entries(spec.facts)) {
      factFields[field] = v.optional(validator);
    }
  }
  const vFacts = v.object(factFields) as unknown as Validator<
    SignInFactsOf<Specs>,
    "required",
    string
  >;

  const vVerdict = v.union(
    v.null(),
    v.object({
      status: v.literal("requirements-needed"),
      requirements: v.array(vRequirement),
    }),
  ) as unknown as Validator<OnSignInVerdictOf<Specs>, "required", string>;

  return { vRequirement, vFacts, vVerdict };
}
