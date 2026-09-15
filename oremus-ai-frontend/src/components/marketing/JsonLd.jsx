// Server component. Injects JSON-LD structured data into the page.
// Rendered server-side so search engines see the schema on first crawl.
export default function JsonLd({ data }) {
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
