import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source rather than built output.
  transpilePackages: [
    '@media-tracker/contracts',
    '@media-tracker/db',
    '@media-tracker/tmdb',
  ],
  serverExternalPackages: ['@node-rs/argon2', 'postgres'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'image.tmdb.org' }],
  },
  poweredByHeader: false,

  /**
   * The workspace packages are ESM TypeScript source and use the required
   * `.js` specifier for relative imports. Webpack resolves those literally, so
   * it needs to be told they may be `.ts` on disk. Turbopack resolves this
   * itself.
   */
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default config;
