import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = dirname(fileURLToPath(import.meta.url));
const servidorNode = join(raiz, "servidor", "servidor.js");

const proceso = spawn(process.execPath, [servidorNode, ...process.argv.slice(2)], {
  cwd: raiz,
  stdio: "inherit",
  env: process.env
});

proceso.on("exit", (codigo) => {
  process.exit(codigo ?? 0);
});

proceso.on("error", (error) => {
  console.error("No se pudo iniciar el servidor de la aplicación:", error.message);
  process.exit(1);
});
