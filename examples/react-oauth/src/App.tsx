import { type ReactNode } from "react";

/**
 * A brand-styled OAuth sign-in option rendered as a button.
 */
type OAuthProvider = {
  /** Human-readable provider name, shown in the button label. */
  name: string;
  /**
   * Authorization URL the button navigates to.
   *
   * Placeholder for now - replace `"#"` with the real OAuth URL.
   */
  href: string;
  /** Brand icon rendered to the left of the label. */
  icon: ReactNode;
  /** Tailwind color/border classes controlling the button's appearance. */
  className: string;
};

/** Google's multi-color "G" mark. */
const GoogleIcon = (): ReactNode => (
  <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
    />
  </svg>
);

/** GitHub's Octocat mark, tinted via `currentColor`. */
const GitHubIcon = (): ReactNode => (
  <svg
    className="h-5 w-5 shrink-0"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.3-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.25 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
  </svg>
);

/**
 * Available sign-in providers. The `href` values are placeholders and
 * should be pointed at the real OAuth authorization endpoints.
 */
const PROVIDERS: OAuthProvider[] = [
  {
    name: "Google",
    href: "#",
    icon: <GoogleIcon />,
    className:
      "bg-white text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50",
  },
  {
    name: "GitHub",
    href: "#",
    icon: <GitHubIcon />,
    className: "bg-gray-900 text-white hover:bg-gray-800",
  },
];

/**
 * Landing page presenting OAuth sign-in options as button-styled links.
 */
export default function App(): ReactNode {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl ring-1 ring-gray-200">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold text-gray-900">Sign in</h1>
          <p className="mt-1 text-sm text-gray-500">
            Continue with your preferred account
          </p>
        </div>
        <div className="flex flex-col gap-3">
          {PROVIDERS.map((provider) => (
            <a
              key={provider.name}
              href={provider.href}
              className={`flex w-full items-center justify-center gap-3 rounded-lg px-4 py-2.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 ${provider.className}`}
            >
              {provider.icon}
              Continue with {provider.name}
            </a>
          ))}
        </div>
      </div>
    </main>
  );
}
