import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <h2>404 - Page Not Found</h2>
      <p>The requested resource could not be found.</p>
      <Link href="/" style={{ color: "#2563eb", textDecoration: "underline" }}>
        Return Home
      </Link>
    </div>
  );
}
