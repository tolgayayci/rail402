import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';

/**
 * The generator scaffolds an "Ask AI" panel backed by OpenRouter. It is removed here: it needs a
 * third-party API key, sends page content to an external service, and adds a large dependency
 * surface to a docs site that does not need one. Full-text search (Orama, local) stays.
 */
export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}
