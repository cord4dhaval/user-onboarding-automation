/** @type {import('next').NextConfig} */
export default {
  serverExternalPackages: ["mongodb", "nodemailer"],
  // `next build` and `next dev` write to the same directory, so a build run to check
  // compilation while a dev server is up deletes the files that server is serving from.
  // The page keeps rendering from cache and every server action behind it silently stops
  // working — which cost an afternoon here, twice, and looked from the outside like a
  // button that did nothing. `npm run build:check` sets this and leaves dev alone.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The engine is authored as ESM with explicit .js specifiers so it runs under tsx and
  // node directly. This lets the bundler resolve those same specifiers to the .ts sources.
  // Well-known documents must live at the domain root, but a directory beginning with a
  // dot is not routable in the app directory.
  async rewrites() {
    return [
      { source: "/.well-known/oauth-authorization-server", destination: "/api/wellknown/oauth-authorization-server" },
      { source: "/.well-known/oauth-protected-resource", destination: "/api/wellknown/oauth-protected-resource" },
      { source: "/.well-known/oauth-protected-resource/api/mcp", destination: "/api/wellknown/oauth-protected-resource" },
    ];
  },
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};
