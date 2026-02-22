const withNextra = require("nextra")({
  theme: "nextra-theme-docs",
  themeConfig: "./theme.config.tsx",
  defaultShowCopyCode: true,
});

module.exports = withNextra({
  basePath: "/auth",
  async redirects() {
    // Only in dev — production shares the domain with other apps
    if (process.env.NODE_ENV !== "development") return [];
    return [
      {
        source: "/:path((?!auth/).*)",
        destination: "/auth/:path",
        basePath: false,
        permanent: false,
      },
    ];
  },
});
