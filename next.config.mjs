/** @type {import('next').NextConfig} */
export default {
  serverExternalPackages: ["mongodb", "nodemailer"],
  // The engine is authored as ESM with explicit .js specifiers so it runs under tsx and
  // node directly. This lets the bundler resolve those same specifiers to the .ts sources.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};
