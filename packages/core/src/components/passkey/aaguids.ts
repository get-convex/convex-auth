/**
 * Default display names for new passkeys, from the AAGUID of the
 * authenticator.
 *
 * The AAGUID identifies the authenticator model. The large passkey
 * providers report theirs even under `attestation: "none"`, exactly so
 * that a relying party can show "iCloud Keychain" instead of a generic
 * label. The table vendors the well-known entries of the community list at
 * https://github.com/passkeydeveloper/passkey-authenticator-aaguids; an
 * unknown or zeroed AAGUID gets no name at all.
 *
 * @module
 */

const WELL_KNOWN_AAGUIDS: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud Keychain",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain (Managed)",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome on Mac",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
};

/**
 * The display name for a new passkey whose authenticator reports `aaguid`,
 * used when the caller gives no name of its own. `undefined` when the
 * authenticator model is unknown, which leaves the passkey without a name.
 */
export function defaultPasskeyName(aaguid: string): string | undefined {
  return WELL_KNOWN_AAGUIDS[aaguid];
}
