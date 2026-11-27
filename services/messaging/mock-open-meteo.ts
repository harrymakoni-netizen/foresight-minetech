// Local stand-in for the Open-Meteo forecast endpoint, used only by the
// end-to-end run. It serves the documented response shape (hourly.time and
// hourly.precipitation in UTC) with a burst of rain a few hours ahead. It is
// NOT weather data and never ships in a deployment.
import { createServer } from "node:http";
const port = Number(process.env.MOCK_OPEN_METEO_PORT || 8391);
createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/v1/forecast" || url.searchParams.get("hourly") !== "precipitation") {
    res.writeHead(404).end();
    return;
  }
  const start = Math.floor(Date.now() / 3600e3) * 3600e3;
  const times = Array.from({ length: 48 }, (_, i) => new Date(start + i * 3600e3).toISOString().slice(0, 16));
  const precipitation = times.map((_, i) => (i === 3 ? 14 : i === 4 ? 7 : 0));
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ latitude: Number(url.searchParams.get("latitude")), longitude: Number(url.searchParams.get("longitude")), hourly_units: { precipitation: "mm" }, hourly: { time: times, precipitation } }));
}).listen(port, "127.0.0.1", () => console.log(`Mock Open-Meteo on ${port}`));
