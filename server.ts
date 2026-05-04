import "dotenv/config";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import cors from "cors";
import express from "express";
import { mkdir } from "fs/promises";
import path from "path";
import pino from "pino";
import QRCode from "qrcode";

const app = express();
app.use(
  cors({
    origin: process.env.CORS_ORIGIN === "*" ? true : process.env.CORS_ORIGIN,
  }),
);
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;
const SESSIONS_ROOT = path.resolve(process.env.SESSIONS_DIR ?? "./sessions");
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? "silent" });

type SessionStatus = "idle" | "connecting" | "qr" | "open" | "closed";

type TenantSession = {
  socket: ReturnType<typeof makeWASocket> | null;
  qrRaw: string | null;
  qrDataUrl: string | null;
  status: SessionStatus;
  lastError: string | null;
};

const tenantSessions = new Map<string, TenantSession>();

function sanitizeTenantId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) {
    throw new Error("tenant_id inválido");
  }
  if (/[\\/]/.test(trimmed) || trimmed.includes("..")) {
    throw new Error("tenant_id não pode conter caminhos");
  }
  return trimmed;
}

function getSession(tenantId: string): TenantSession {
  let s = tenantSessions.get(tenantId);
  if (!s) {
    s = {
      socket: null,
      qrRaw: null,
      qrDataUrl: null,
      status: "idle",
      lastError: null,
    };
    tenantSessions.set(tenantId, s);
  }
  return s;
}

async function destroySocket(session: TenantSession): Promise<void> {
  const sock = session.socket;
  session.socket = null;
  if (!sock) return;
  try {
    await sock.logout();
  } catch {
    try {
      sock.end(undefined);
    } catch {
      /* ignore */
    }
  }
}

async function startBaileysForTenant(tenantId: string): Promise<void> {
  const session = getSession(tenantId);
  session.lastError = null;
  session.status = "connecting";
  session.qrRaw = null;
  session.qrDataUrl = null;

  await destroySocket(session);

  const authFolder = path.join(SESSIONS_ROOT, tenantId);
  await mkdir(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    auth: state,
    logger: baileysLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  session.socket = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 256 });
      } catch {
        session.qrDataUrl = null;
      }
      session.qrRaw = qr;
      session.status = "qr";
    }

    if (connection === "close") {
      session.status = "closed";
      session.qrRaw = null;
      session.qrDataUrl = null;

      const boomError = lastDisconnect?.error as Boom | undefined;
      const statusCode = boomError?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (boomError) {
        session.lastError = boomError.message;
      }

      session.socket = null;

      if (shouldReconnect) {
        setTimeout(() => {
          void startBaileysForTenant(tenantId).catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            getSession(tenantId).lastError = msg;
            getSession(tenantId).status = "closed";
          });
        }, 2500);
      }
    } else if (connection === "open") {
      session.status = "open";
      session.qrRaw = null;
      session.qrDataUrl = null;
      session.lastError = null;
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "axe-whatsapp-baileys" });
});

/**
 * Corpo JSON: { "tenant_id": "<uuid do Supabase>" }
 * Cada zelador usa um tenant_id distinto; a sessão fica em ./sessions/<tenant_id>/.
 */
app.post("/api/whatsapp/session", async (req, res) => {
  try {
    const tenantId = sanitizeTenantId(String(req.body?.tenant_id ?? ""));
    await startBaileysForTenant(tenantId);
    const s = getSession(tenantId);
    res.status(202).json({
      tenant_id: tenantId,
      status: s.status,
      message:
        s.status === "qr"
          ? "Escaneie o QR em GET /api/whatsapp/session/:tenantId/qr"
          : "Conexão iniciada; consulte o status e o QR nas rotas GET.",
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro ao iniciar sessão";
    res.status(400).json({ error: message });
  }
});

app.post("/api/whatsapp/session/:tenantId/start", async (req, res) => {
  try {
    const tenantId = sanitizeTenantId(req.params.tenantId);
    await startBaileysForTenant(tenantId);
    const s = getSession(tenantId);
    res.status(202).json({
      tenant_id: tenantId,
      status: s.status,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro ao iniciar sessão";
    res.status(400).json({ error: message });
  }
});

app.get("/api/whatsapp/session/:tenantId/qr", (req, res) => {
  try {
    const tenantId = sanitizeTenantId(req.params.tenantId);
    const s = getSession(tenantId);
    if (!s.qrRaw && s.status !== "open") {
      return res.status(404).json({
        tenant_id: tenantId,
        error: "Nenhum QR disponível ainda. Chame POST .../session com este tenant_id.",
        status: s.status,
      });
    }
    if (s.status === "open") {
      return res.json({
        tenant_id: tenantId,
        status: "open",
        message: "Já conectado ao WhatsApp; não é necessário QR.",
      });
    }
    return res.json({
      tenant_id: tenantId,
      status: s.status,
      qr_raw: s.qrRaw,
      qr_image_data_url: s.qrDataUrl,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro";
    res.status(400).json({ error: message });
  }
});

app.get("/api/whatsapp/session/:tenantId/status", (req, res) => {
  try {
    const tenantId = sanitizeTenantId(req.params.tenantId);
    const s = getSession(tenantId);
    res.json({
      tenant_id: tenantId,
      status: s.status,
      last_error: s.lastError,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro";
    res.status(400).json({ error: message });
  }
});

app.post("/api/whatsapp/session/:tenantId/logout", async (req, res) => {
  try {
    const tenantId = sanitizeTenantId(req.params.tenantId);
    const s = getSession(tenantId);
    await destroySocket(s);
    s.status = "idle";
    s.qrRaw = null;
    s.qrDataUrl = null;
    s.lastError = null;
    res.json({ tenant_id: tenantId, status: "idle", message: "Sessão encerrada no servidor." });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro";
    res.status(400).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Axé WhatsApp (Baileys) ouvindo na porta ${PORT}`);
  console.log(`Pasta de sessões: ${SESSIONS_ROOT}`);
});
