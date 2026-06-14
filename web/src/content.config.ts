import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';

// ── Cloud feature flag ─────────────────────────────────────────────────────────
// When PUBLIC_CARTCRFT_CLOUD is unset/falsy, cloud/* doc pages are excluded from
// the static build entirely — zero cloud routes are emitted.
const CLOUD = Boolean(import.meta.env.PUBLIC_CARTCRFT_CLOUD);

export const collections = {
  docs: defineCollection({
    // When cloud is OFF, only load non-cloud/* docs (exclude cloud/ directory).
    // When cloud is ON, use the full docsLoader which picks up everything.
    loader: CLOUD
      ? docsLoader()
      : glob({
          base: './src/content/docs',
          // Match all .md/.mdx EXCEPT anything inside cloud/
          pattern: ['**/[^_]*.{md,mdx}', '!cloud/**'],
        }),
    schema: docsSchema(),
  }),

  // ── Marketing content — prose pages that are content-authored ─────────────
  marketing: defineCollection({
    loader: glob({
      base: './src/content/marketing',
      pattern: '**/*.{md,mdx}',
    }),
    schema: z.object({
      title: z.string(),
      description: z.string(),
      updatedDate: z.string().optional(),
      methodology: z.string().optional(),
    }),
  }),
};
