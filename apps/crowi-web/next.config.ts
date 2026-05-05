import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Disable automatic trailing slash redirects
  // Crowi treats paths with and without trailing slashes as different pages:
  // - With trailing slash: portal/directory page
  // - Without trailing slash: page itself
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
