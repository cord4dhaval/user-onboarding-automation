/**
 * Tailwind is added additively: the app's own stylesheet still owns the existing screens,
 * and utilities are available to the ones being rebuilt. Preflight is deliberately not
 * imported (see globals.css) — its reset would restyle every screen at once, which is the
 * opposite of a migration you can stop halfway.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
