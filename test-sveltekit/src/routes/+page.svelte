<script>
    import { useAuthActions, useAuthToken } from '@convex-dev/auth/sveltekit';
    
    // Get auth actions (signIn, signOut)
    const { signIn, signOut } = useAuthActions();
    
    // Auth token will be null when not authenticated
    const authToken = useAuthToken();
    
    // Derive authenticated state from token
    let isAuthenticated = $derived(authToken !== null);
  </script>

<h1>Welcome to SvelteKit</h1>
<p>Visit <a href="https://svelte.dev/docs/kit">svelte.dev/docs/kit</a> to read the documentation</p>

<div>
  {#if isAuthenticated}
    <p>You are authenticated!</p>
    <button onclick={() => signOut()}>Sign Out</button>
  {:else}
    <p>You are not authenticated.</p>
    <button onclick={() => signIn('google')}>Sign In with Google</button>
  {/if}
</div>
