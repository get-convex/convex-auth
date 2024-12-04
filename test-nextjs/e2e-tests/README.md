# Run the e2e tests

## The mostly automated way

After an `npm install` at the root of this repo and an `npm install` in test-nextjs, run `npm test` in test-nextjs.
This tests against the most recently published official binary.

## The more manual way

The following instructions require some pre-work, but once you've done the first couple steps once
you can skip to running the test command at the end.

1. Clone [convex-backend](https://github.com/get-convex/convex-backend)

1. Follow the instructions in its [README](https://github.com/get-convex/convex-backend/blob/main/README.md) to get it building

1. From the `test-nextjs` directory, run:

```
CONVEX_LOCAL_BACKEND_PATH=/path/to/your/convex-backend npm run test
```

## The most manual way

You'll need manage your own Convex deployment to follow these instructions.

1. Set up your Convex deployment for auth ([instructions](https://labs.convex.dev/auth/setup/manual))

1. Create a test user

   `npx convex run tests:init`

1. Set up the secret on a Convex backend matching the one in `.env.test`:

   `npx convex env set AUTH_E2E_TEST_SECRET <something>`

1. Run `playwright test`
