import { createServer, request as httpRequest } from "node:http";

const PORT = Number(process.env.DASHBOARD_PORT || 8080);

createServer((incoming, outgoing) => {
  const upstream = httpRequest(
    {
      hostname: "localhost",
      port: 3000,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, host: "localhost:3000" },
    },
    (response) => {
      outgoing.writeHead(response.statusCode || 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("error", (error) => {
    outgoing.statusCode = 502;
    outgoing.end(`Dashboard is starting: ${error.message}`);
  });
  incoming.pipe(upstream);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Remote dashboard gateway listening on port ${PORT}`);
});
