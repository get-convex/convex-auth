<script lang="ts">
  import type { ConvexClient } from "convex/browser";
  import { api } from "$convex/_generated/api.js";
  import { useQuery } from "convex-svelte";
  import { getContext } from "svelte";
  import { toast } from "svelte-sonner";
  import { errorText } from "$lib/errors";
  import ChangePasswordForm from "./ChangePasswordForm.svelte";

  type AuthContext = {
    signOut: () => Promise<void>;
    signIn: (
      provider: string,
      args?: Record<string, unknown>,
    ) => Promise<{ kind: "signedIn" | "redirect"; redirect?: URL | string }>;
    passkey?: {
      isSupported: () => boolean;
      register: (opts?: Record<string, unknown>) => Promise<{
        kind: "signedIn" | "redirect";
        redirect?: URL | string;
      }>;
    };
  };

  const auth = getContext<AuthContext>("auth");

  let { user, userRoleLabel, selectedProject, members, permissions, groupId, client } = $props<{
    user: { name: string; email: string | null };
    userRoleLabel: string;
    selectedProject: { projectId: string; identifier: string } | null;
    members: Array<{
      memberId: string;
      userId: string;
      name: string;
      email: string | null;
      roleIds: string[];
    }>;
    permissions: {
      canManageMembers: boolean;
      canManageSso: boolean;
    };
    groupId: string;
    client: ConvexClient;
  }>();

  let tab = $state<"passkeys" | "security" | "apikeys" | "members">("passkeys");
  let isSigningOut = $state(false);

  let showInviteForm = $state(false);
  let inviteEmail = $state("");
  let inviteRoleId = $state("member");
  let isInviting = $state(false);
  let isRegisteringPasskey = $state(false);
  let isDeletingPasskeyId = $state<string | null>(null);
  let apiKeyName = $state("");
  let issueReadScope = $state(true);
  let issueWriteScope = $state(false);
  let isCreatingApiKey = $state(false);
  let isRevokingApiKeyId = $state<string | null>(null);
  let createdApiKey = $state<{ keyId: string; secret: string } | null>(null);

  const invitesQuery = useQuery(
    api.groups.listInvites,
    () => permissions.canManageMembers ? { groupId: groupId } : "skip",
  );
  const passkeysQuery = useQuery(api.account.listPasskeys, () => ({}));
  const apiKeysQuery = useQuery(api.account.listApiKeys, () => ({}));
  const hasPasswordQuery = useQuery(api.account.hasPassword, () => ({}));
  const pendingInvites = $derived(invitesQuery.data ?? []);
  const passkeys = $derived(passkeysQuery.data ?? []);
  const apiKeys = $derived(apiKeysQuery.data ?? []);
  const hasPassword = $derived(hasPasswordQuery.data ?? false);
  const adminCount = $derived(
    members.filter((m: { roleIds: string[] }) => m.roleIds.includes("orgAdmin")).length,
  );
  const passkeySupported = $derived(auth.passkey?.isSupported() ?? false);
  const origin = $derived(typeof window === "undefined" ? "" : window.location.origin);

  const roleOptions = [
    { id: "orgAdmin", label: "Admin" },
    { id: "member", label: "Member" },
    { id: "viewer", label: "Viewer" },
  ];

  function getRoleLabel(roleIds: string[]) {
    if (roleIds.includes("orgAdmin")) return "Admin";
    if (roleIds.includes("member")) return "Member";
    if (roleIds.includes("viewer")) return "Viewer";
    return "Unassigned";
  }

  function formatScopes(
    scopes: Array<{ resource: string; actions: string[] }>,
  ) {
    return scopes
      .map((scope) => `${scope.resource}:${scope.actions.join("/")}`)
      .join(", ");
  }

  function clockTime(timestamp: number) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function handleRoleChange(memberId: string, newRoleId: string) {
    try {
      await client.mutation(api.groups.updateMemberRole, {
        groupId: groupId,
        memberId,
        roleId: newRoleId,
      });
    } catch (e: unknown) {
      toast.error(errorText(e, "Failed to update role"));
    }
  }

  async function handleSignOut() {
    isSigningOut = true;
    try {
      await auth.signOut();
      window.location.reload();
    } catch (e: unknown) {
      toast.error(errorText(e, "Sign out failed"));
    } finally {
      isSigningOut = false;
    }
  }

  async function handleInvite() {
    if (!inviteEmail.includes("@")) return;
    isInviting = true;
    const emailToSend = inviteEmail;
    try {
      const result = await client.action(api.groups.inviteMember, {
        groupId: groupId,
        email: inviteEmail,
        roleId: inviteRoleId,
      });
      if ("ok" in result && result.ok) {
        inviteEmail = "";
        toast.success(`Invite sent to ${emailToSend}`);
      } else if ("message" in result) {
        toast.error(typeof result.message === "string" ? result.message : "Failed to invite");
      }
    } catch (e: unknown) {
      toast.error(errorText(e, "Failed to invite"));
    } finally {
      isInviting = false;
    }
  }

  async function handleRevokeInvite(inviteId: string) {
    try {
      await client.mutation(api.groups.revokeInvite, {
        groupId: groupId,
        inviteId,
      });
    } catch (e: unknown) {
      toast.error(errorText(e, "Failed to revoke"));
    }
  }

  async function handleRegisterPasskey() {
    if (!auth.passkey) {
      toast.error("Passkeys are not available in this browser.");
      return;
    }
    isRegisteringPasskey = true;
    try {
      const result = await auth.passkey.register({
        name: typeof navigator === "undefined" ? "This device" : navigator.platform,
      });
      if (result.kind === "redirect" && result.redirect) {
        window.location.href = result.redirect.toString();
      }
    } catch (e: unknown) {
      toast.error(errorText(e, "Failed to register passkey"));
    } finally {
      isRegisteringPasskey = false;
    }
  }

  async function handleDeletePasskey(passkeyId: string) {
    isDeletingPasskeyId = passkeyId;
    try {
      await client.mutation(api.account.removePasskey, { passkeyId });
    } catch (e: unknown) {
      toast.error(errorText(e, "Failed to delete passkey"));
    } finally {
      isDeletingPasskeyId = null;
    }
  }

  async function handleCreateApiKey() {
    if (!apiKeyName.trim()) return;
    isCreatingApiKey = true;
    createdApiKey = null;
    try {
      createdApiKey = await client.mutation(api.account.createApiKey, {
        name: apiKeyName,
        issueRead: issueReadScope,
        issueWrite: issueWriteScope,
      });
      apiKeyName = "";
    } catch (e: unknown) {
      toast.error(errorText(e, "Failed to create API key"));
    } finally {
      isCreatingApiKey = false;
    }
  }

  async function handleRevokeApiKey(keyId: string) {
    isRevokingApiKeyId = keyId;
    try {
      await client.mutation(api.account.revokeApiKey, { keyId });
    } catch (e: unknown) {
      toast.error(errorText(e, "Failed to revoke API key"));
    } finally {
      isRevokingApiKeyId = null;
    }
  }

  const tabs = $derived([
    { id: "passkeys" as const, label: "Passkeys" },
    ...(hasPassword ? [{ id: "security" as const, label: "Security" }] : []),
    { id: "apikeys" as const, label: "API keys" },
    { id: "members" as const, label: "Members" },
  ]);
</script>

<div class="flex flex-col gap-4">
  <!-- Account bar -->
  <div class="flex justify-between items-center gap-3 pb-3 border-b border-border-transparent">
    <div class="flex items-center gap-2">
      <span class="font-label text-[0.75rem] text-content-primary">{user.name}</span>
      <span class="chip chip--role">{userRoleLabel}</span>
    </div>
    <button
      class="button button--secondary button--compact"
      disabled={isSigningOut}
      onclick={handleSignOut}
    >{isSigningOut ? "..." : "Sign out"}</button>
  </div>

  <div class="flex flex-col gap-4">
    <div class="segmented self-start">
      {#each tabs as t (t.id)}
        <button type="button" data-active={tab === t.id} onclick={() => { tab = t.id; }}>
          {t.label}
        </button>
      {/each}
    </div>

    <div class="panel p-4 flex flex-col gap-3">
      {#if tab === 'passkeys'}
        <div class="flex items-center justify-between gap-3">
          <p class="muted m-0">Register a passkey for faster sign-in on this device.</p>
          <button
            class="button button--secondary button--compact"
            disabled={!passkeySupported || isRegisteringPasskey}
            onclick={handleRegisterPasskey}
          >{isRegisteringPasskey ? "Adding..." : "Add passkey"}</button>
        </div>

        {#if !passkeySupported}
          <p class="muted">This browser does not support WebAuthn passkeys.</p>
        {:else if passkeys.length === 0}
          <p class="muted">No passkeys registered yet.</p>
        {:else}
          <div class="flex flex-col">
            {#each passkeys as passkey (passkey.passkeyId)}
              <div class="flex justify-between items-center gap-3 py-1.5 border-b border-border-transparent">
                <div class="flex flex-col">
                  <span class="text-sm text-content-primary">{passkey.name ?? passkey.deviceType}</span>
                  <span class="font-label text-[0.6875rem] text-content-tertiary">
                    {passkey.backedUp ? "Synced" : "Local"}
                    {#if passkey.lastUsedAt}
                      · {clockTime(passkey.lastUsedAt)}
                    {/if}
                  </span>
                </div>
                <button
                  class="button button--ghost text-[0.65rem] text-content-tertiary hover:text-content-error"
                  disabled={isDeletingPasskeyId === passkey.passkeyId}
                  onclick={() => handleDeletePasskey(passkey.passkeyId)}
                >{isDeletingPasskeyId === passkey.passkeyId ? "removing" : "remove"}</button>
              </div>
            {/each}
          </div>
        {/if}

      {:else if tab === 'security'}
        <p class="muted m-0">Change your password. After updating, your session continues with fresh tokens.</p>
        <ChangePasswordForm email={user.email} />

      {:else if tab === 'apikeys'}
        <p class="muted m-0">Create a key for <code>/api/me</code> and <code>/api/issues</code> curl requests.</p>

        <form class="flex flex-col gap-2" onsubmit={(e) => { e.preventDefault(); handleCreateApiKey(); }}>
          <input
            bind:value={apiKeyName}
            class="input input--compact"
            type="text"
            maxlength="60"
            placeholder="CLI key"
          />
          <label class="flex items-center gap-2 font-label text-[0.75rem] text-content-primary">
            <input bind:checked={issueReadScope} type="checkbox" />
            Allow <code>GET /api/issues</code>
          </label>
          <label class="flex items-center gap-2 font-label text-[0.75rem] text-content-primary">
            <input bind:checked={issueWriteScope} type="checkbox" />
            Allow <code>POST /api/issues</code>
          </label>
          <button class="button button--secondary button--compact self-start" disabled={isCreatingApiKey || !apiKeyName.trim()} type="submit">
            {isCreatingApiKey ? "Creating..." : "Create API key"}
          </button>
        </form>

        {#if createdApiKey}
          <div class="flex flex-col gap-2 p-3 border border-border-transparent bg-background-primary rounded-md">
            <p class="m-0 font-label text-[0.75rem] text-content-secondary">Copy this secret now. It will only be shown once.</p>
            <code class="code-block">{createdApiKey.secret}</code>
            <code class="code-block">curl -H "Authorization: Bearer {createdApiKey.secret}" {origin}/api/me</code>
            {#if selectedProject}
              <code class="code-block">curl -H "Authorization: Bearer {createdApiKey.secret}" "{origin}/api/issues?projectId={selectedProject.projectId}"</code>
            {:else}
              <p class="muted m-0">Select a project in the sidebar to get a ready-to-run <code>/api/issues</code> curl command.</p>
            {/if}
          </div>
        {/if}

        {#if apiKeys.length === 0}
          <p class="muted">No API keys yet.</p>
        {:else}
          <div class="flex flex-col">
            {#each apiKeys as key (key.keyId)}
              <div class="flex justify-between items-center gap-3 py-1.5 border-b border-border-transparent">
                <div class="flex flex-col">
                  <span class="text-sm text-content-primary">{key.name}</span>
                  <span class="font-label text-[0.6875rem] text-content-tertiary">
                    {key.prefix}
                    {#if key.scopes.length > 0}
                      · {formatScopes(key.scopes)}
                    {:else}
                      · no scopes
                    {/if}
                  </span>
                </div>
                {#if key.revoked}
                  <span class="chip chip--role">Revoked</span>
                {:else}
                  <button
                    class="button button--ghost text-[0.65rem] text-content-tertiary hover:text-content-error"
                    disabled={isRevokingApiKeyId === key.keyId}
                    onclick={() => handleRevokeApiKey(key.keyId)}
                  >{isRevokingApiKeyId === key.keyId ? "revoking" : "revoke"}</button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

      {:else if tab === "members"}
        <!-- Action buttons -->
        {#if permissions.canManageMembers || permissions.canManageSso}
          <div class="flex gap-2">
            {#if permissions.canManageMembers}
              <button
                class="button button--secondary button--compact"
                onclick={() => { showInviteForm = !showInviteForm; }}
              >{showInviteForm ? "Cancel" : "Invite member"}</button>
            {/if}
            {#if permissions.canManageSso}
              <a class="button button--secondary button--compact no-underline" href="/{groupId}/connection">
                Connections
              </a>
            {/if}
          </div>
        {/if}

        <!-- Invite form -->
        {#if showInviteForm}
          <div class="flex flex-col gap-2 p-3 border border-border-transparent bg-background-primary rounded-md">
            <form class="flex gap-1.5 items-center flex-wrap" onsubmit={(e) => { e.preventDefault(); handleInvite(); }}>
              <input
                class="input input--compact flex-1 min-w-[10rem]"
                bind:value={inviteEmail}
                type="email"
                placeholder="Email address"
              />
              <select class="select select--compact" bind:value={inviteRoleId}>
                {#each roleOptions as role (role.id)}
                  <option value={role.id}>{role.label}</option>
                {/each}
              </select>
              <button
                class="button button--accent button--compact"
                type="submit"
                disabled={isInviting || !inviteEmail.includes("@")}
              >{isInviting ? "..." : "Send"}</button>
            </form>

            <!-- Pending invites -->
            {#if pendingInvites.length > 0}
              <div class="flex flex-col mt-1">
                <span class="font-label text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-content-tertiary mb-1">Pending</span>
                {#each pendingInvites as invite (invite.inviteId)}
                  <div class="flex justify-between items-center gap-2 py-1 border-b border-border-transparent">
                    <div class="flex items-center gap-2">
                      <span class="font-label text-[0.75rem] text-content-primary">{invite.email ?? "—"}</span>
                      <span class="chip chip--role">{getRoleLabel(invite.roleIds)}</span>
                    </div>
                    <button
                      class="button button--ghost text-[0.65rem] text-content-tertiary hover:text-content-error"
                      onclick={() => handleRevokeInvite(invite.inviteId)}
                    >revoke</button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Member list -->
        <div class="flex flex-col">
          {#each members as member (member.userId)}
            <div class="flex justify-between items-center gap-2 py-1.5 border-b border-border-transparent">
              <div class="flex flex-col">
                <span class="text-sm text-content-primary">{member.name}</span>
                {#if member.email}
                  <span class="font-label text-[0.6875rem] text-content-tertiary">{member.email}</span>
                {/if}
              </div>
              {#if permissions.canManageMembers && !(adminCount === 1 && member.roleIds.includes("orgAdmin"))}
                <select
                  class="select select--compact"
                  value={member.roleIds[0] ?? "viewer"}
                  onchange={(e) => handleRoleChange(member.memberId, e.currentTarget.value)}
                >
                  {#each roleOptions as role (role.id)}
                    <option value={role.id}>{role.label}</option>
                  {/each}
                </select>
              {:else}
                <span
                  class="chip chip--role"
                  title={adminCount === 1 && member.roleIds.includes("orgAdmin")
                    ? "A group must keep at least one admin."
                    : undefined}
                >{getRoleLabel(member.roleIds)}</span>
              {/if}
            </div>
          {:else}
            <p class="muted">No members.</p>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
