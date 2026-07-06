---
title: auth.member
description: Membership management — add users to groups with roles and permissions.
---

<svelte:head>

  <title>auth.member - convex-auth</title>
</svelte:head>

# auth.member

The `auth.member` namespace manages the relationship between users and groups.
Each membership stores assigned `roleIds`. Use `auth.member.get(...)` to
look up membership details and `auth.member.assert(...)` to enforce
authorization with a single call.

See [Authorization Patterns](/guides/authorization) for the full model.

## Methods

| Method   | Signature                                                             | Returns                                                                     | Description                                                                                                                         |
| -------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `create` | `(ctx, { data: { userId, groupId, roleIds?, status?, extend? } })`    | `Id<"GroupMember">`                                                         | Creates a user membership in a group with optional assigned role IDs. Throws `ConvexError` with code `INVALID_ROLE_IDS` on failure. |
| `get`    | `(ctx, { id })`                                                       | `Doc<"GroupMember"> \| null`                                                | Returns the membership record for a given membership ID, or `null` if it does not exist.                                            |
| `get`    | `(ctx, { userId, groupId, ancestry?, maxDepth? })`                    | `{ membership, roleIds, grants }`                                           | Overloaded: resolves a user's membership in a group (optionally walking ancestry), with roles and grants. Returns without throwing. |
| `list`   | `(ctx, { where?, paginationOpts, orderBy?, order? })`                 | `PaginationResult<Doc<"GroupMember">>` — `{ page, isDone, continueCursor }` | Lists members by group, by user, or both. Convex-native shape.                                                                      |
| `update` | `(ctx, { id, patch })`                                                | `null`                                                                      | Updates a membership's assigned role IDs or metadata. Throws `ConvexError` with code `INVALID_ROLE_IDS` on failure.                 |
| `remove` | `(ctx, { id })`                                                       | `null`                                                                      | Removes a user membership from a group.                                                                                             |
| `assert` | `(ctx, { userId, groupId, ancestry?, roleIds?, grants?, maxDepth? })` | `{ membership, roleIds, grants }`                                           | Resolves membership and enforces required roleIds/grants. Throws `ConvexError` on failure.                                          |

## Examples

### Create a membership

```ts
const memberId = await auth.member.create(ctx, {
  data: {
    userId,
    groupId: orgId,
    roleIds: ["member"],
  },
});
```

### Check membership by record ID

```ts
const member = await auth.member.get(ctx, { id: memberId });

if (!member) {
  throw new Error("Membership not found");
}
```

### Inspect membership and grants

```ts
const result = await auth.member.get(ctx, {
  userId,
  groupId: orgId,
});

if (result.membership) {
  console.log(result.roleIds); // e.g. ["orgAdmin"]
  console.log(result.grants); // e.g. ["members.create", "members.update"]
}
```

### Require specific grants (throws on failure)

```ts
// Throws `NOT_A_MEMBER` or `MISSING_GRANTS` on failure.
await auth.member.assert(ctx, {
  userId,
  groupId: orgId,
  grants: ["members.update"],
});
```

### Inspect role from parent group

```ts
// Checks teamId, then walks up to the parent org
const result = await auth.member.get(ctx, {
  userId,
  groupId: teamId,
});

if (result.membership) {
  console.log(result.roleIds, result.grants);
}
```

### Inspect with ancestry trail

Pass `ancestry: true` to get the list of group IDs traversed during resolution:

```ts
const result = await auth.member.get(ctx, {
  userId,
  groupId: teamId,
  ancestry: true,
});
```
