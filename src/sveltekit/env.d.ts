/**
 * Type declarations for SvelteKit environment variables
 * This allows the library to be used without a dev server
 */

declare module "$env/dynamic/public" {
  export const env: {
    [key: `PUBLIC_${string}`]: string | undefined;
    PUBLIC_CONVEX_URL: string;
  };
}
