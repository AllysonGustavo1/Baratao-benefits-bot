const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");

const CHECKIN_URL = "https://barataocombustiveis.com.br/api/v1/grava_checkin";
const ROLETA_URL = "https://barataocombustiveis.com.br/api/v1/roleta";
const ACCOUNTS_DIR = path.join(__dirname, "contas");
const CYCLE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BETWEEN_REQUESTS_DELAY_MS = 10 * 1000;
const BETWEEN_ACCOUNTS_DELAY_MS = 10 * 1000;

function decodeResponseBody(buffer, encoding) {
  if (!encoding) return buffer.toString("utf8");
  if (encoding.includes("gzip")) {
    return zlib.gunzipSync(buffer).toString("utf8");
  }
  if (encoding.includes("deflate")) {
    return zlib.inflateSync(buffer).toString("utf8");
  }
  if (encoding.includes("br")) {
    return zlib.brotliDecompressSync(buffer).toString("utf8");
  }
  return buffer.toString("utf8");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAccountFile(fileName, fileContent) {
  const parsed = {};

  for (const rawLine of fileContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_]+)\s*[:=]\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    const value = match[2].trim().replace(/^['"]|['"]$/g, "");
    parsed[key] = value;
  }

  const accountName = path.basename(fileName, path.extname(fileName));
  const authorization =
    parsed.BARATAO_authorization ||
    parsed.BARATAO_AUTHORIZATION ||
    parsed.authorization ||
    "";
  const checkinCookie = parsed.cookie || parsed.BARATAO_COOKIE || "";
  const roletaCookie =
    parsed.baratao_roleta_cookie ||
    parsed.BARATAO_ROLETA_COOKIE ||
    checkinCookie ||
    "";
  const baratao = parsed.baratao || parsed.BARATAO || checkinCookie || "";

  return {
    accountName,
    authorization,
    baratao,
    checkinCookie,
    roletaCookie,
  };
}

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_DIR)) {
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    console.warn(
      `[${new Date().toISOString()}] Pasta "contas" criada em ${ACCOUNTS_DIR}. Adicione arquivos .txt de contas para iniciar.`,
    );
    return [];
  }

  const accountFiles = fs
    .readdirSync(ACCOUNTS_DIR)
    .filter((fileName) => fileName.toLowerCase().endsWith(".txt"));

  if (accountFiles.length === 0) {
    console.warn(
      `[${new Date().toISOString()}] Nenhum arquivo .txt encontrado em ${ACCOUNTS_DIR}.`,
    );
    return [];
  }

  const accounts = [];

  for (const fileName of accountFiles) {
    const filePath = path.join(ACCOUNTS_DIR, fileName);
    const account = parseAccountFile(
      fileName,
      fs.readFileSync(filePath, "utf8"),
    );

    if (
      !account.authorization ||
      !account.checkinCookie ||
      !account.roletaCookie
    ) {
      console.warn(
        `[${new Date().toISOString()}] Conta ${account.accountName} ignorada. Campos obrigatorios: BARATAO_authorization (ou BARATAO_AUTHORIZATION), cookie (ou BARATAO_COOKIE), baratao_roleta_cookie (ou BARATAO_ROLETA_COOKIE/cookie).`,
      );
      continue;
    }

    accounts.push(account);
  }

  return accounts;
}

function createHeaders(account, cookie) {
  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-encoding": "gzip",
    authorization: account.authorization,
    connection: "Keep-Alive",
    cookie,
    host: "barataocombustiveis.com.br",
    "user-agent": "barataoapp",
  };

  if (account.baratao) {
    headers.baratao = account.baratao;
  }

  return headers;
}

function postCheckin(account) {
  const body = JSON.stringify({ date: new Date().toISOString() });
  const url = new URL(CHECKIN_URL);

  const options = {
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers: {
      ...createHeaders(account, account.checkinCookie),
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];

      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseBuffer = Buffer.concat(chunks);
        let responseText;

        try {
          responseText = decodeResponseBody(
            responseBuffer,
            res.headers["content-encoding"] || "",
          );
        } catch (error) {
          responseText = responseBuffer.toString("utf8");
        }

        const isSuccess = res.statusCode >= 200 && res.statusCode < 300;

        if (isSuccess) {
          console.log(
            `[${new Date().toISOString()}] [${account.accountName}] Check-in enviado com sucesso (${res.statusCode}).`,
          );
          console.log(responseText);
          resolve();
          return;
        }

        reject(
          new Error(
            `[${new Date().toISOString()}] [${account.accountName}] Falha no check-in. Status: ${res.statusCode}. Resposta: ${responseText}`,
          ),
        );
      });
    });

    req.on("error", (error) => {
      reject(
        new Error(
          `[${new Date().toISOString()}] [${account.accountName}] Erro de requisicao no check-in: ${error.message}`,
        ),
      );
    });

    req.setTimeout(30000, () => {
      req.destroy(
        new Error(
          `[${new Date().toISOString()}] [${account.accountName}] Timeout de 30s excedido no check-in.`,
        ),
      );
    });

    req.write(body);
    req.end();
  });
}

function postRoleta(account) {
  const url = new URL(ROLETA_URL);

  const options = {
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers: {
      ...createHeaders(account, account.roletaCookie),
      "content-length": 0,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];

      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseBuffer = Buffer.concat(chunks);
        let responseText;

        try {
          responseText = decodeResponseBody(
            responseBuffer,
            res.headers["content-encoding"] || "",
          );
        } catch (error) {
          responseText = responseBuffer.toString("utf8");
        }

        const isSuccess = res.statusCode >= 200 && res.statusCode < 300;

        if (isSuccess) {
          console.log(
            `[${new Date().toISOString()}] [${account.accountName}] Roleta executada com sucesso (${res.statusCode}).`,
          );
          console.log(responseText);
          resolve();
          return;
        }

        reject(
          new Error(
            `[${new Date().toISOString()}] [${account.accountName}] Falha na roleta. Status: ${res.statusCode}. Resposta: ${responseText}`,
          ),
        );
      });
    });

    req.on("error", (error) => {
      reject(
        new Error(
          `[${new Date().toISOString()}] [${account.accountName}] Erro de requisicao na roleta: ${error.message}`,
        ),
      );
    });

    req.setTimeout(30000, () => {
      req.destroy(
        new Error(
          `[${new Date().toISOString()}] [${account.accountName}] Timeout de 30s excedido na roleta.`,
        ),
      );
    });

    req.end();
  });
}

async function runAccountRequests(account) {
  try {
    await postCheckin(account);
    console.log(
      `[${new Date().toISOString()}] [${account.accountName}] Aguardando 10 segundos antes da roleta.`,
    );
    await wait(BETWEEN_REQUESTS_DELAY_MS);
    await postRoleta(account);
  } catch (error) {
    console.error(error.message);
  }
}

async function runAllAccounts(accounts) {
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    console.log(
      `[${new Date().toISOString()}] [${account.accountName}] Iniciando execucao da conta ${index + 1}/${accounts.length}.`,
    );

    await runAccountRequests(account);

    const hasNextAccount = index < accounts.length - 1;
    if (hasNextAccount) {
      console.log(
        `[${new Date().toISOString()}] Aguardando 10 segundos para iniciar a proxima conta.`,
      );
      await wait(BETWEEN_ACCOUNTS_DELAY_MS);
    }
  }
}

async function startScheduler() {
  console.log(`[${new Date().toISOString()}] Agendador iniciado.`);

  while (true) {
    const cycleStartedAt = new Date().toISOString();
    const accounts = loadAccounts();

    if (accounts.length === 0) {
      console.warn(
        `[${cycleStartedAt}] Nenhuma conta valida encontrada para executar requests.`,
      );
    } else {
      console.log(
        `[${cycleStartedAt}] Executando ciclo em ${accounts.length} conta(s).`,
      );
      await runAllAccounts(accounts);
    }

    const nextRunAt = new Date(Date.now() + CYCLE_INTERVAL_MS).toISOString();
    console.log(
      `[${new Date().toISOString()}] Ciclo finalizado. Proxima execucao em ${nextRunAt}.`,
    );

    await wait(CYCLE_INTERVAL_MS);
  }
}

startScheduler().catch((error) => {
  console.error(
    `[${new Date().toISOString()}] Erro fatal no agendador: ${error.message}`,
  );
  process.exitCode = 1;
});
