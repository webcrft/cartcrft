import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// ── Cloud feature flag ─────────────────────────────────────────────────────────
// PUBLIC_CARTCRFT_CLOUD=1 enables managed-cloud surfaces in the build.
// When unset/falsy, all cloud-only routes, sidebar entries, and nav items are
// excluded from the output — the OSS build ships zero cloud surface.
const CLOUD = Boolean(process.env.PUBLIC_CARTCRFT_CLOUD);

// Cloud-only Starlight sidebar group (included only when CLOUD=true)
const cloudSidebarGroup = CLOUD
  ? [
      {
        label: 'Cloud',
        items: [
          { slug: 'cloud/overview' },
          { slug: 'cloud/billing' },
          { slug: 'cloud/quotas' },
          { slug: 'cloud/onboarding' },
        ],
      },
    ]
  : []

// https://astro.build/config
export default defineConfig({
  site: 'https://cartcrft.dev',
  output: 'static',
  // ── Astro static redirects — map legacy /docs/* paths to Starlight root paths
  redirects: {
    '/docs': '/quickstart',
    '/docs/quickstart': '/quickstart',
    '/docs/quickstart-mcp': '/quickstart-mcp',
    '/docs/agent-native': '/agent-native',
    '/docs/acp': '/acp',
    '/docs/ucp': '/ucp',
    '/docs/byo-keys': '/byo-keys',
    '/docs/self-host': '/self-host',
    '/docs/cloud-vs-selfhost': '/cloud-vs-selfhost',
    '/docs/api-overview': '/api-overview',
    '/docs/parity-endpoints': '/parity-endpoints',
    '/docs/security': '/security',
    '/docs/testing': '/testing',
    '/docs/contributing': '/contributing',
  },
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    react(),
    starlight({
      title: 'Cartcrft',
      description: 'Headless commerce for agent-native storefronts',
      logo: {
        src: './src/assets/logo-wordmark.svg',
        replacesTitle: true,
      },
      customCss: ['./src/styles/custom.css'],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/webcrftsystems/cartcrft' },
      ],
      editLink: {
        baseUrl: 'https://github.com/webcrftsystems/cartcrft/edit/main/web/',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { slug: 'quickstart' },
            { slug: 'quickstart-mcp' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { slug: 'byo-keys' },
            { slug: 'self-host' },
            { slug: 'cloud-vs-selfhost' },
          ],
        },
        {
          label: 'Agent-native',
          items: [
            { slug: 'agent-native' },
            {
              label: 'Protocols',
              items: [
                { slug: 'acp' },
                { slug: 'ucp' },
              ],
            },
          ],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'api-overview' },
            { slug: 'parity-endpoints' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { slug: 'security' },
            { slug: 'testing' },
          ],
        },
        {
          label: 'Project',
          items: [
            { slug: 'contributing' },
          ],
        },
        // Cloud-only sidebar group — excluded from OSS builds
        ...cloudSidebarGroup,
      ],
      head: [
        {
          tag: 'meta',
          attrs: { name: 'theme-color', content: '#6366f1' },
        },
      ],
    }),
  ],
});
