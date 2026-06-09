export default function Home() {
  return (
    <div style={{ fontFamily: "monospace", padding: "2rem", maxWidth: 800, margin: "0 auto" }}>
      <h1>DeepSeek OpenAI-Compatible API</h1>
      <p>Deployed on Vercel. Use the following endpoints:</p>

      <h2>Endpoints</h2>
      <pre>{`GET  /api/v1/models           (no auth required)
POST /api/v1/chat/completions (Bearer token)`}</pre>

      <h2>Example</h2>
      <pre>{`curl https://YOUR_DOMAIN.vercel.app/api/v1/models

curl https://YOUR_DOMAIN.vercel.app/api/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-your-api-key" \\
  -d '{
    "model": "expert",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'`}</pre>
    </div>
  );
}