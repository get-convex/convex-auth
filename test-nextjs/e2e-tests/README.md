# Get the e2e tests working

1. Create a test user

   `npx convex run tests:init`

2. Set up the secret on Convex backend:

   `npx convex env set AUTH_E2E_TEST_SECRET <something>`

3. Specify the secret for playwright:

   Add the following to `.env.local`:

   ```
   AUTH_E2E_TEST_SECRET=<something>
   ```
