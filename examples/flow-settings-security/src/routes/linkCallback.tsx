// Return leg of the link-OAuth redirect started by `security.startLinkOAuth`.
//
// Completing the link (state validation, code exchange, attaching the
// identity to the signed-in user) happens in the auth HTTP callback route
// BEFORE it 302s here — a `completeOAuth`-style call is deliberately OUT of
// scope for this fixture (see flow-oauth-link for the full callback
// treatment). By the time this renders, `listIdentities` already reflects
// the new identity, reactively.
export function LinkCallback() {
  return (
    <>
      <h1>Linked!</h1>
      <p>(Completion handled by the auth callback route in a real app.)</p>
      <p>
        <a href="/">Back to account security</a>
      </p>
    </>
  );
}
