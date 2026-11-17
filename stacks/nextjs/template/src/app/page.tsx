import { Counter } from "@/components/counter";

export default function HomePage() {
  const generatedAt = new Date().toISOString();

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Next.js Reference Application</h1>
      <p>
        Governed by the <strong>AI Engineering Playbook</strong>.
      </p>
      <p>
        <small>Server Rendered Timestamp: {generatedAt}</small>
      </p>
      <hr style={{ margin: "1.5rem 0" }} />
      <section>
        <h2>Interactive Leaf Component Demo</h2>
        <Counter initialCount={0} />
      </section>
    </main>
  );
}
