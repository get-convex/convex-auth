---
title: Device Flow (RFC 8628)
description: Authenticate input-constrained devices like CLIs, smart TVs, and IoT.
---

<svelte:head>

  <title>Device Flow (RFC 8628) - convex-auth</title>
</svelte:head>

# Device Flow (RFC 8628)

Enable input-constrained devices to authenticate by displaying a short code that
the user enters on a secondary device.

## Setup

```ts
import { device } from "@robelest/convex-auth/providers";

defineAuth(components.auth, {
  providers: [device({ verificationUri: "https://myapp.com/device" })],
});
```

## How it works

1. Device calls `signIn("device")` -> gets `userCode` and `deviceCode`
2. Device displays: "Go to myapp.com/device, enter code: WDJB-MJHT"
3. User visits URL on their phone/laptop, signs in, enters the code
4. Device polls until authorized -> receives session tokens

## Device side (CLI)

Use `@robelest/convex-auth/client` here because CLIs and device flows usually
run outside the browser. The `browser` entrypoint is for web apps and adds
browser-only defaults like passkeys, storage, and URL integration.

```ts
import { client } from "@robelest/convex-auth/client";
import { api } from "../convex/_generated/api";

const auth = client({ convex, api: api.auth });

const result = await auth.signIn("device");
if (result.kind !== "deviceCode") {
  throw new Error("Device flow did not start.");
}

const { deviceCode } = result;

console.log(`Go to: ${deviceCode.verificationUri}`);
console.log(`Enter code: ${deviceCode.userCode}`);

await auth.device.poll({ code: deviceCode });
// User is now signed in
```

## Verification page

Build a page at your `verificationUri` where authenticated users enter the code:

```tsx
function DeviceVerification() {
  const [userCode, setUserCode] = useState("");

  const handleVerify = async () => {
    await auth.device.verify({ code: userCode });
  };

  return (
    <div>
      <h1>Authorize Device</h1>
      <input value={userCode} onChange={(e) => setUserCode(e.target.value)} />
      <button onClick={handleVerify}>Authorize</button>
    </div>
  );
}
```

## Configuration

| Option            | Default                  | Description                                    |
| ----------------- | ------------------------ | ---------------------------------------------- |
| `verificationUri` | `APP_URL + "/device"`    | URL of your verification page                  |
| `charset`         | `"BCDFGHJKLMNPQRSTVWXZ"` | User code characters (no vowels, per RFC 8628) |
| `userCodeLength`  | `8`                      | Code length (displayed as `XXXX-XXXX`)         |
| `expiresIn`       | `900` (15 min)           | Code lifetime in seconds                       |
| `interval`        | `5`                      | Minimum polling interval in seconds            |

## Error codes

| Code                           | Meaning                          |
| ------------------------------ | -------------------------------- |
| `DEVICE_AUTHORIZATION_PENDING` | User hasn't entered the code yet |
| `DEVICE_SLOW_DOWN`             | Polling too fast                 |
| `DEVICE_CODE_EXPIRED`          | Code expired, restart the flow   |
| `DEVICE_CODE_INVALID`          | Code not found or already used   |
