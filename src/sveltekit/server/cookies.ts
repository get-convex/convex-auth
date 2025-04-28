/**
 * Cookie handling utilities for Convex Auth in SvelteKit
 */
import cookie from "cookie";
import { logVerbose } from "./utils.js";

// Interface for cookie options - nullable maxAge is used internally only
export interface CookieOptions {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  maxAge?: number | null;
  sameSite?: "strict" | "lax" | "none";
  domain?: string;
  expires?: Date;
}

// Cookie names
export const AUTH_TOKEN_COOKIE = "__convexAuthJWT";
export const AUTH_REFRESH_TOKEN_COOKIE = "__convexAuthRefreshToken";
export const AUTH_VERIFIER_COOKIE = "verifier";

// Default cookie options
export const defaultCookieOptions: CookieOptions = {
  path: "/",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
};

/**
 * Convert our internal CookieOptions with nullable maxAge to the format needed
 * by the cookie library (which only accepts number | undefined)
 */
function normalizeOptions(options: CookieOptions): cookie.SerializeOptions {
  // Extract maxAge and convert null to undefined
  const { maxAge, ...rest } = options;
  return {
    ...rest,
    maxAge: maxAge === null ? undefined : maxAge,
  };
}

/**
 * Set auth cookies on a response object
 * 
 * @param response The response object to set cookies on
 * @param token The JWT token to set, or null to clear
 * @param refreshToken The refresh token to set, or null to clear
 * @param cookieConfig Cookie configuration options
 * @param verbose Whether to enable verbose logging
 */
export function setAuthCookies(
  response: Response,
  token: string | null,
  refreshToken: string | null,
  cookieConfig: CookieOptions = defaultCookieOptions,
  verbose = false,
) {
  logVerbose(
    `Setting auth cookies { token: ${!!token}, refreshToken: ${!!refreshToken} }`,
    verbose,
  );
  
  // Normalize the cookie config
  const finalCookieConfig = { 
    ...defaultCookieOptions,
    ...cookieConfig 
  };

  if (token === null) {
    // To delete a cookie, we need to set it with an expired date/max-age
    response.headers.append(
      "set-cookie",
      cookie.serialize(AUTH_TOKEN_COOKIE, "", {
        ...normalizeOptions(finalCookieConfig),
        maxAge: 0, // Setting max-age to 0 tells the browser to delete it immediately
        expires: new Date(0), // Setting an expired date as backup
      }),
    );
  } else {
    response.headers.append(
      "set-cookie",
      cookie.serialize(AUTH_TOKEN_COOKIE, token, {
        ...normalizeOptions(finalCookieConfig),
        // If maxAge is null, it should be converted to undefined to make a session cookie
        maxAge: finalCookieConfig.maxAge === null 
          ? undefined 
          : (finalCookieConfig.maxAge === undefined 
              ? 60 * 60 // 1 hour default
              : finalCookieConfig.maxAge),
      }),
    );
  }

  if (refreshToken === null) {
    // To delete a cookie, we need to set it with an expired date/max-age
    response.headers.append(
      "set-cookie",
      cookie.serialize(AUTH_REFRESH_TOKEN_COOKIE, "", {
        ...normalizeOptions(finalCookieConfig),
        maxAge: 0, // Setting max-age to 0 tells the browser to delete it immediately
        expires: new Date(0), // Setting an expired date as backup
      }),
    );
  } else {
    response.headers.append(
      "set-cookie",
      cookie.serialize(AUTH_REFRESH_TOKEN_COOKIE, refreshToken, {
        ...normalizeOptions(finalCookieConfig),
        // If maxAge is null, it should be converted to undefined to make a session cookie
        maxAge: finalCookieConfig.maxAge === null 
          ? undefined 
          : (finalCookieConfig.maxAge === undefined 
              ? 60 * 60 * 24 * 30 // 30 days default
              : finalCookieConfig.maxAge),
      }),
    );
  }
}

/**
 * Set verifier cookie on a response object for OAuth PKCE flow
 * 
 * @param response The response object to set the verifier cookie on
 * @param verifier The verifier string to set
 * @param cookieConfig Cookie configuration options
 * @param verbose Whether to enable verbose logging
 */
export function setVerifierCookie(
  response: Response,
  verifier: string,
  cookieConfig: CookieOptions = defaultCookieOptions,
  verbose = false,
) {
  logVerbose(`Setting verifier cookie`, verbose);
  
  // Normalize the cookie config
  const finalCookieConfig = { 
    ...defaultCookieOptions,
    ...cookieConfig 
  };

  response.headers.append(
    "set-cookie",
    cookie.serialize(AUTH_VERIFIER_COOKIE, verifier, {
      ...normalizeOptions(finalCookieConfig),
      // Handle null maxAge by converting to undefined (session cookie)
      // Use a shorter default expiration for verifier (5 minutes)
      maxAge: finalCookieConfig.maxAge === null 
        ? undefined 
        : (finalCookieConfig.maxAge === undefined 
            ? 60 * 5 // 5 minutes default for verifier
            : finalCookieConfig.maxAge),
    }),
  );
}
