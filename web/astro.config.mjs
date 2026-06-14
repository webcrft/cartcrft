import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  integrations: [
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
      // Sidebar — TODO(docs-agent): replace autogenerate with explicit grouped sidebar.
      // Autogenerate is used during scaffold to avoid slug resolution issues.
      //
      // Verified slugs (from content collection IDs, no extension):
      //   quickstart, quickstart-mcp, api-overview, byo-keys, parity-endpoints,
      //   agent-native, acp, ucp, security, self-host, cloud-vs-selfhost,
      //   contributing, testing, readme
      //
      // Switch to explicit groups like:
      //   { label: 'Getting Started', items: [{ slug: 'quickstart' }, { slug: 'quickstart-mcp' }] }
      //   { label: 'Guides', items: [{ slug: 'api-overview' }, { slug: 'byo-keys' }, { slug: 'parity-endpoints' }] }
      //   { label: 'Agent-Native', items: [{ slug: 'agent-native' }, { slug: 'acp' }, { slug: 'ucp' }] }
      //   { label: 'Self-Host', items: [{ slug: 'self-host' }, { slug: 'cloud-vs-selfhost' }] }
      //   { label: 'Security', items: [{ slug: 'security' }] }
      //   { label: 'Contributing', items: [{ slug: 'contributing' }, { slug: 'testing' }] }
      //   { label: 'Reference', items: [{ slug: 'readme', label: 'Docs Overview' }] }
      sidebar: [
        {
          label: 'All Docs',
          autogenerate: { directory: '.' },
        },
      ],
      // Let docs agent override head, favicon, etc.
      head: [
        {
          tag: 'meta',
          attrs: { name: 'theme-color', content: '#6366f1' },
        },
      ],
    }),
  ],
});
