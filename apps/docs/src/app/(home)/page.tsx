import Link from 'next/link';

/**
 * Placeholder root page.
 *
 * The marketing landing page is designed separately
 * and is deliberately NOT built here. This exists only so `/` is not a 404 while the docs are the
 * useful thing at this domain.
 */
export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col justify-center text-center">
      <h1 className="mb-4 text-2xl font-bold">x402 Stellar</h1>
      <p className="text-fd-muted-foreground mb-6">
        An x402 facilitator for Stellar, with a discovery layer agents can actually search.
      </p>
      <p>
        <Link href="/docs" className="font-medium underline">
          Read the documentation
        </Link>
      </p>
    </div>
  );
}
