import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = dirname(fileURLToPath(import.meta.url));
const servidorPython = join(raiz, "servidor", "servidor_python.py");

const proceso = spawn("py", [servidorPython], {
  cwd: raiz,
  stdio: "inherit",
  shell: true
});

proceso.on("exit", (codigo) => {
  process.exit(codigo ?? 0);
});
