import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://cartcrft.dev',
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
