# Get the e2e tests working

1. Create a test user

   `npx convex run tests:init`

1. Set up the secret on Convex backend:

   `npx convex env set AUTH_E2E_TEST_SECRET <something>`

1. Turn on the secret sign-in UI and specify the secret for playwright:

   Add the following to `.env.local`:

   ```
   NEXT_PUBLIC_E2E_TEST=true
   AUTH_E2E_TEST_SECRET=<something>
   ```
